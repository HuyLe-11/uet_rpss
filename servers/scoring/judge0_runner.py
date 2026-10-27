"""Run a complete OTT BO2 match in one Judge0 Python submission.

Contestant code is executed in a child process inside Judge0. It must expose
choose_move(state) or choose_best_move(state); the trusted parent harness keeps
the process alive for one game and validates every returned move.
"""
import base64
import json
import os
import queue
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


class Judge0Error(RuntimeError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def _proxy_url():
    raw = os.environ.get("OTT_SCORING_PROXY_URL", "").strip()
    if not raw:
        return None
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise Judge0Error("proxy_invalid_url", "OTT_SCORING_PROXY_URL must be an absolute HTTP(S) URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise Judge0Error("proxy_invalid_url", "OTT_SCORING_PROXY_URL must not contain credentials, query, or fragment")
    return raw.rstrip("/")


def _run_proxy_match(contestant, benchmark, max_seconds):
    endpoint = f"{_proxy_url()}/v1/score"
    token = os.environ.get("OTT_SCORING_PROXY_TOKEN", "").strip()
    if not token:
        raise Judge0Error("proxy_not_configured", "OTT_SCORING_PROXY_TOKEN is required when the proxy engine is enabled")
    payload = json.dumps({
        "contestant_code": contestant.decode("utf-8"),
        "benchmark_code": benchmark.decode("utf-8"),
    }).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=payload,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=max_seconds + 10) as response:
            response_body = json.loads(response.read())
            status = response.status
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:500]
        raise Judge0Error("proxy_http_error", f"Cloudflare scoring proxy returned HTTP {error.code}: {detail}") from None
    except (urllib.error.URLError, TimeoutError) as error:
        raise Judge0Error("proxy_unavailable", f"Could not reach Cloudflare scoring proxy: {error}") from None
    except json.JSONDecodeError:
        raise Judge0Error("proxy_invalid_response", "Cloudflare scoring proxy returned invalid JSON") from None

    job_id = response_body.get("job_id")
    if status == 202 and isinstance(job_id, str):
        deadline = time.monotonic() + max_seconds + 180
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(
                    urllib.request.Request(
                        f"{endpoint}/{urllib.parse.quote(job_id)}",
                        headers={"Accept": "application/json", "Authorization": f"Bearer {token}"},
                    ),
                    timeout=15,
                ) as poll_response:
                    response_body = json.loads(poll_response.read())
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
                raise Judge0Error("proxy_poll_failed", f"Could not poll Cloudflare scoring proxy: {error}") from None
            if response_body.get("status") in {"queued", "running"}:
                time.sleep(1)
                continue
            break

    score = response_body.get("match_score")
    games = response_body.get("games")
    if isinstance(score, bool) or not isinstance(score, int) or score not in (-2, -1, 0, 1, 2):
        raise Judge0Error("proxy_invalid_output", "Cloudflare scoring proxy returned an invalid score")
    if not isinstance(games, list) or len(games) != 2:
        raise Judge0Error("proxy_invalid_output", "Cloudflare scoring proxy returned an invalid BO2 replay")
    return {"match_score": score, "games": games, "duration_seconds": 0}


def _judge0_url(value=None):
    raw = (value or os.environ.get("OTT_JUDGE0_URL", "http://127.0.0.1:2358")).strip()
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise Judge0Error(
            "judge0_invalid_url",
            f"OTT_JUDGE0_URL must be an absolute HTTP(S) URL, got {raw!r}",
        )
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise Judge0Error(
            "judge0_invalid_url",
            "OTT_JUDGE0_URL must not contain credentials, query, or fragment",
        )
    return raw.rstrip("/")


def _runner_source(contestant, benchmark):
    contestant_b64 = base64.b64encode(contestant).decode("ascii")
    benchmark_b64 = base64.b64encode(benchmark).decode("ascii")
    template = r"""import base64, json, os, queue, shutil, signal, subprocess, sys, tempfile, threading

BEAT = {0: 2, 1: 0, 2: 1}
DIRS = [(dx, dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1) if dx or dy]
MAX_PLIES = 200
CONTESTANT = base64.b64decode("__CONTESTANT__")
BENCHMARK = base64.b64decode("__BENCHMARK__")
BOT_DRIVER = r'''import base64, contextlib, io, json, random, sys
ns = {"__name__": "ott_contestant"}
random.seed(0)
code = base64.b64decode("__BOT_CODE__")
with contextlib.redirect_stdout(io.StringIO()):
    exec(compile(code, "contestant.py", "exec"), ns, ns)
fn = ns.get("choose_move") or ns.get("choose_best_move")
if not callable(fn):
    raise SystemExit("Bot must define choose_move(state)")
for line in sys.stdin:
    try:
        state = json.loads(line)
        with contextlib.redirect_stdout(io.StringIO()):
            move = fn(state)
        if not isinstance(move, (tuple, list)) or len(move) != 4:
            raise ValueError("choose_move must return four coordinates")
        print(" ".join(str(int(value)) for value in move), flush=True)
    except BaseException:
        print("-1 -1 -1 -1", flush=True)
'''

def start_bot(code, name, workdir):
    encoded = base64.b64encode(code).decode("ascii")
    driver_path = os.path.join(workdir, name + "_driver.py")
    with open(driver_path, "w", encoding="utf-8") as f:
        f.write(BOT_DRIVER.replace("__BOT_CODE__", encoded))
    return ProcBot(driver_path, workdir)

class ProcBot:
    def __init__(self, path, workdir):
        self.lines = queue.Queue(maxsize=8)
        self.process = subprocess.Popen(
            [sys.executable, "-I", path], cwd=workdir,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            bufsize=0, start_new_session=True, env={},
        )
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._drain_stderr, daemon=True).start()
    def _read_stdout(self):
        try:
            for line in iter(self.process.stdout.readline, b""):
                try:
                    self.lines.put(line[:300], timeout=0.1)
                except queue.Full:
                    pass
        finally:
            try:
                self.lines.put(None, timeout=0.1)
            except queue.Full:
                pass
    def _drain_stderr(self):
        try:
            while self.process.stderr.read(4096): pass
        except Exception:
            pass
    def move(self, state, timeout):
        try:
            self.process.stdin.write((json.dumps(state) + chr(10)).encode())
            self.process.stdin.flush()
            line = self.lines.get(timeout=timeout)
            if line is None: return None
            values = [int(v) for v in line.decode("utf-8", errors="replace").split()]
            return tuple(values) if len(values) == 4 else None
        except Exception:
            return None
    def close(self):
        try:
            os.killpg(self.process.pid, signal.SIGKILL)
        except Exception:
            try: self.process.kill()
            except Exception: pass
        try: self.process.wait(timeout=1)
        except Exception: pass

def initial():
    b = {}
    for x in range(9):
        b[(x, 0)] = (0, x % 3)
        b[(x, 8)] = (1, x % 3)
    return b

def legal_moves(b, p):
    out = []
    for (x, y), (owner, kind) in b.items():
        if owner != p: continue
        for dx, dy in DIRS:
            nx, ny = x + dx, y + dy
            if not (0 <= nx < 9 and 0 <= ny < 9): continue
            target = b.get((nx, ny))
            if target is None or (target[0] != p and BEAT[kind] == target[1]):
                out.append((x, y, nx, ny))
    return out

def encode(b, me, ply):
    goal = (8, 8) if me == 0 else (0, 0)
    return {"me": me, "ply": ply, "goal": list(goal),
            "pieces": [[x, y, owner, kind] for (x, y), (owner, kind) in b.items()]}

class MoveTimeout(Exception): pass
def _alarm(_signum, _frame): raise MoveTimeout()

def play(user_code, sample_code, user_first, workdir):
    board = initial()
    user_bot = start_bot(user_code, "contestant", workdir)
    sample_bot = start_bot(sample_code, "benchmark", workdir)
    bots = [user_bot, sample_bot] if user_first else [sample_bot, user_bot]
    user_idx = 0 if user_first else 1
    moves = []
    try:
        for ply in range(MAX_PLIES):
            p = ply % 2
            legal = legal_moves(board, p)
            if not legal:
                raw = -1 if p == 0 else 1
                return (raw if user_first else -raw), moves, p == user_idx
            move = bots[p].move(encode(board, p, ply), 3.0 if ply < 2 else 1.0)
            if move not in legal:
                raw = -1 if p == 0 else 1
                return (raw if user_first else -raw), moves, p == user_idx
            x, y, nx, ny = move
            board[(nx, ny)] = board.pop((x, y))
            moves.append([p, list(move)])
            if (nx, ny) == ((8, 8) if p == 0 else (0, 0)) or len({kind for (owner, kind) in board.values() if owner != p}) < 3:
                raw = 1 if p == 0 else -1
                return (raw if user_first else -raw), moves, False
        return 0, moves, False
    finally:
        user_bot.close()
        sample_bot.close()

try:
    workdir = tempfile.mkdtemp(prefix="ott_match_")
    results, games = [], []
    for user_first in (True, False):
        result, moves, fault = play(CONTESTANT, BENCHMARK, user_first, workdir)
        results.append(result)
        games.append({"players": ["a", "b"] if user_first else ["b", "a"], "result": result, "moves": moves, "fault": fault})
    shutil.rmtree(workdir, ignore_errors=True)
    print("OTT_RESULT:" + json.dumps({"match_score": sum(results), "games": games}, separators=(",", ":")))
except BaseException as exc:
    print("OTT_ERROR:" + type(exc).__name__ + ":" + str(exc))
"""
    return template.replace("__CONTESTANT__", contestant_b64).replace("__BENCHMARK__", benchmark_b64)


def _judge0_request(base_url, path, method="GET", payload=None, timeout=20):
    base_url = _judge0_url(base_url)
    if not path.startswith("/"):
        raise Judge0Error("judge0_invalid_path", "Judge0 API path must start with '/'")
    headers = {"Accept": "application/json"}
    auth_header = os.environ.get("OTT_JUDGE0_AUTH_HEADER", "").strip()
    auth_token = os.environ.get("OTT_JUDGE0_AUTH_TOKEN", "").strip()
    if auth_header and auth_token:
        headers[auth_header] = auth_token
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(base_url + path, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise Judge0Error("judge0_http_error", f"Judge0 returned HTTP {exc.code}: {detail}") from None
    except (urllib.error.URLError, TimeoutError) as exc:
        raise Judge0Error("judge0_unavailable", f"Could not reach Judge0: {exc}") from None


def list_bot_languages(base_url=None):
    """Return active Python 3 runtimes supported by the function bot protocol."""
    base_url = _judge0_url(base_url)
    languages = _judge0_request(base_url, "/languages/")
    if not isinstance(languages, list):
        raise Judge0Error("judge0_invalid_response", "Judge0 /languages did not return a list")
    return [
        {"id": item["id"], "name": item["name"]}
        for item in languages
        if isinstance(item, dict)
        and isinstance(item.get("id"), int)
        and isinstance(item.get("name"), str)
        and (("python" in item["name"].lower() and "3." in item["name"]) or "pypy3" in item["name"].lower())
    ]


def default_bot_language(base_url=None):
    language_id = int(os.environ.get("OTT_JUDGE0_PYTHON_ID", "71"))
    language = next((item for item in list_bot_languages(base_url) if item["id"] == language_id), None)
    if language is None:
        raise Judge0Error("judge0_language_unavailable", f"Default Python language id {language_id} is not active in Judge0")
    return language


def judge0_status(base_url=None):
    """Return non-secret Judge0 capacity limits for the admin monitor."""
    url = _judge0_url(base_url)
    config = _judge0_request(url, "/config_info")
    return {
        "max_cpu_time_limit": config.get("max_cpu_time_limit"),
        "max_wall_time_limit": config.get("max_wall_time_limit"),
        "max_memory_limit": config.get("max_memory_limit"),
        "max_processes_and_or_threads": config.get("max_processes_and_or_threads"),
    }


def run_match(contestant: bytes, benchmark: bytes, base_url=None, language_id=None, max_seconds=None):
    """Submit and poll a BO2 execution; return score and raw replay games."""
    proxy_url = _proxy_url()
    if proxy_url:
        return _run_proxy_match(contestant, benchmark, float(max_seconds or os.environ.get("OTT_JUDGE0_MAX_SECONDS", "140")))

    base_url = _judge0_url(base_url)
    source = _runner_source(contestant, benchmark)
    language_id = int(language_id or os.environ.get("OTT_JUDGE0_PYTHON_ID", "71"))
    cpu_seconds = float(os.environ.get("OTT_JUDGE0_CPU_SECONDS", "30"))
    max_seconds = float(max_seconds or os.environ.get("OTT_JUDGE0_MAX_SECONDS", "140"))
    memory_kb = int(os.environ.get("OTT_JUDGE0_MEMORY_KB", "262144"))

    try:
        config = _judge0_request(base_url, "/config_info")
    except Judge0Error as exc:
        raise Judge0Error("judge0_config_unavailable", f"Could not read Judge0 /config_info: {exc}") from None
    if not isinstance(config, dict):
        raise Judge0Error("judge0_invalid_response", "Judge0 /config_info returned an invalid response")
    max_cpu = float(config.get("max_cpu_time_limit", 0))
    max_wall = float(config.get("max_wall_time_limit", 0))
    max_memory = int(config.get("max_memory_limit", 0))
    if max_cpu < cpu_seconds or max_wall < max_seconds or max_memory < memory_kb:
        raise Judge0Error(
            "judge0_limits_too_low",
            f"Judge0 effective limits are CPU {max_cpu}s / wall {max_wall}s / memory {max_memory}KB; "
            f"module requires CPU {cpu_seconds}s / wall {max_seconds}s / memory {memory_kb}KB. "
            "Update judge0.conf and restart the Judge0 server and workers containers.",
        )
    available = list_bot_languages(base_url)
    if not any(item["id"] == language_id for item in available):
        raise Judge0Error("judge0_language_unavailable", f"Judge0 language id {language_id} is not an active Python 3 runtime")

    submission = _judge0_request(base_url, "/submissions?base64_encoded=false&wait=false", "POST", {
        "source_code": source,
        "language_id": language_id,
        "stdin": "",
        "cpu_time_limit": cpu_seconds,
        "wall_time_limit": max_seconds,
        "memory_limit": memory_kb,
        "max_file_size": 1024,
    })
    token = submission.get("token")
    if not token:
        raise Judge0Error("judge0_invalid_response", "Judge0 did not return a submission token")

    # Keep polling grace bounded so a queued or stalled Judge0 submission
    # cannot multiply the configured match timeout across an entire job.
    deadline = time.monotonic() + max_seconds + 5
    fields = urllib.parse.quote("stdout,stderr,compile_output,message,status,time,memory")
    while time.monotonic() < deadline:
        result = _judge0_request(base_url, f"/submissions/{token}?base64_encoded=false&fields={fields}")
        status = (result.get("status") or {}).get("id")
        if status is not None and status >= 3:
            if status != 3:
                detail = result.get("stderr") or result.get("compile_output") or result.get("message") or (result.get("status") or {}).get("description")
                raise Judge0Error("judge0_execution_failed", str(detail or "Judge0 execution failed")[:500])
            stdout = result.get("stdout") or ""
            payload = next((line[len("OTT_RESULT:"):] for line in reversed(stdout.splitlines()) if line.startswith("OTT_RESULT:")), None)
            error = next((line[len("OTT_ERROR:"):] for line in stdout.splitlines() if line.startswith("OTT_ERROR:")), None)
            if error:
                raise Judge0Error("invalid_bot", error[:500])
            if not payload:
                raise Judge0Error("judge0_invalid_output", "Judge0 output did not contain OTT_RESULT")
            try:
                parsed = json.loads(payload)
            except json.JSONDecodeError:
                raise Judge0Error("judge0_invalid_output", "Judge0 returned invalid OTT_RESULT JSON") from None
            score = parsed.get("match_score")
            games = parsed.get("games")
            if isinstance(score, bool) or not isinstance(score, int) or score not in (-2, -1, 0, 1, 2) or not isinstance(games, list) or len(games) != 2:
                raise Judge0Error("judge0_invalid_output", "Judge0 result has an invalid score or replay")
            return {"match_score": score, "games": games, "duration_seconds": float(result.get("time") or 0)}
        time.sleep(0.2)
    raise Judge0Error("judge0_timeout", "Timed out waiting for Judge0 result")
