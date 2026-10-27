"""Self-hosted scoring API; run on a separate port from Judge0 (host port 2358)."""
import hashlib
import gzip
import json
import logging
import os
import re
import uuid
import ast
import threading
import time
import socket
import asyncio
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

# Load root/data secrets first, then scoring-specific defaults. Existing shell
# variables and root/data .env values take precedence over config.local.env.
ROOT = Path(__file__).resolve().parents[2]
from data import config as _data_config  # noqa: E402,F401


def _load_scoring_config():
    path = Path(__file__).with_name("config.local.env")
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_scoring_config()

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from data.supabase_client import get_supabase
from .judge0_runner import Judge0Error, default_bot_language, judge0_status, run_match

logger = logging.getLogger("ott.scoring")
if not logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s [scoring] %(message)s"))
    logger.addHandler(_handler)
logger.setLevel(logging.INFO)
logger.propagate = False

BENCHMARK_PATH = Path(os.environ.get("OTT_BENCHMARK_BOT", ROOT / "sample_bots" / "sample_bot.py"))
BENCHMARK_STORE = Path(os.environ.get("OTT_BENCHMARK_BOT_DIR", ROOT / "data" / "storage" / "practice_bots"))
BOT_STORE = Path(os.environ.get("OTT_SCORING_BOT_DIR", ROOT / "data" / "storage" / "submissions"))
MAX_SOURCE_BYTES = 65536
JOB_ID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")
WORKER_COUNT = max(1, int(os.environ.get("OTT_SCORING_WORKERS", "2")))
QUEUE_CAPACITY = max(1, int(os.environ.get("OTT_SCORING_QUEUE_SIZE", "20")))
MATCH_TIMEOUT_SECONDS = max(5, int(os.environ.get("OTT_SCORING_MATCH_TIMEOUT_SECONDS", "15")))
JOB_TIMEOUT_SECONDS = max(MATCH_TIMEOUT_SECONDS, int(os.environ.get("OTT_SCORING_JOB_TIMEOUT_SECONDS", "60")))
QUEUE_POLL_SECONDS = max(0.1, float(os.environ.get("OTT_SCORING_QUEUE_POLL_SECONDS", "0.5")))
_workers = ThreadPoolExecutor(max_workers=WORKER_COUNT)
_tournament_workers = ThreadPoolExecutor(max_workers=max(1, int(os.environ.get("OTT_TOURNAMENT_WORKERS", "4"))))
_match_workers = ThreadPoolExecutor(max_workers=max(1, int(os.environ.get("OTT_TOURNAMENT_MATCH_WORKERS", "4"))))
_capacity = threading.BoundedSemaphore(QUEUE_CAPACITY)
_dedupe_lock = threading.Lock()
_inflight = set()
_tournament_lock = threading.Lock()
_tournament_days = set()
_tournament_reschedule = set()
_tournament_retry_counts = {}
_active_match_ids = set()
_started_at = time.time()
_queue_dispatcher_started = False
_metrics_lock = threading.Lock()
_rejected_jobs = 0
_completed_jobs = 0
_failed_jobs = 0
_last_invalid_claim_log = 0.0

app = FastAPI(title="OTT Scoring Module", version="1.0.0")
origins = [
    value.strip().rstrip("/")
    for value in os.environ.get("OTT_SCORING_CORS_ORIGINS", "").split(",")
    if value.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.exception_handler(HTTPException)
async def log_http_exception(request, exc):
    logger.warning("Request rejected %s %s with HTTP %s: %s", request.method, request.url.path, exc.status_code, exc.detail)
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail}, headers=exc.headers)


@app.middleware("http")
async def log_http_failures(request, call_next):
    try:
        response = await call_next(request)
    except Exception:
        logger.exception("Unhandled request exception: %s %s", request.method, request.url.path)
        raise
    if response.status_code >= 400:
        logger.warning("HTTP %s %s -> %s", request.method, request.url.path, response.status_code)
    return response


@app.middleware("http")
async def limit_job_request_size(request, call_next):
    if request.url.path.startswith("/v1/jobs/"):
        try:
            size = int(request.headers.get("content-length", "0"))
        except ValueError:
            size = 0
        if size > MAX_SOURCE_BYTES + 65536:
            return JSONResponse({"detail": "Request quá lớn"}, status_code=413)
    return await call_next(request)


def _token(authorization):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Cần đăng nhập")
    return authorization[7:].strip()


def _user(token):
    try:
        return get_supabase().get_user(token)
    except Exception as exc:
        logger.warning("Supabase user verification failed (%s)", type(exc).__name__)
        raise HTTPException(status_code=401, detail="Phiên đăng nhập không hợp lệ") from None


def _rpc(name, args):
    last_error = None
    for attempt in range(5):
        try:
            return get_supabase().rpc(name, args)
        except Exception as exc:
            last_error = exc
            if attempt < 4:
                logger.warning("Supabase RPC %s failed (attempt %s/5, %s); retrying", name, attempt + 1, type(exc).__name__)
                time.sleep(0.25 * (2 ** attempt))
    logger.error("Supabase RPC %s failed after 5 attempts: %s", name, last_error)
    raise last_error


def _local_result_path(job_id):
    # UUID validation and fixed directory prevent user-controlled path traversal.
    try:
        normalized_id = str(uuid.UUID(str(job_id)))
    except (ValueError, AttributeError, TypeError):
        raise ValueError("invalid job id")
    return BOT_STORE / normalized_id[:2] / f"{normalized_id}.py"


def _claimed_job_record(value):
    """Normalize PostgREST's composite RPC response to one job dictionary."""
    for _ in range(3):
        if isinstance(value, list):
            value = value[0] if value else None
        if not isinstance(value, dict):
            return None
        if "id" in value:
            break
        # PostgREST can wrap a composite result under the function name or
        # another single response key depending on its schema cache version.
        nested_values = [item for item in value.values() if isinstance(item, (dict, list))]
        value = nested_values[0] if len(nested_values) == 1 else None
    if not isinstance(value, dict) or "id" not in value:
        return None
    if "id" not in value:
        return None
    try:
        value = dict(value)
        raw_id = value["id"]
        if isinstance(raw_id, dict):
            raw_id = raw_id.get("id") or raw_id.get("value")
        value["id"] = str(uuid.UUID(str(raw_id)))
    except (ValueError, AttributeError, TypeError):
        return None
    return value


def _cleanup_reset_source_files(max_batches=None):
    """Delete local bot sources for jobs removed by the latest reset.

    The SQL reset writes job IDs to a durable queue before deleting job rows, so
    a module restart or a temporary disk/DB error can safely retry this cleanup.
    """
    deleted = 0
    batches = 0
    try:
        while True:
            rows = _rpc("admin_list_reset_source_cleanup_ids", {"p_limit": 5000}) or []
            job_ids = [str(row.get("job_id", "")) for row in rows if row.get("job_id")]
            if not job_ids:
                return {"deleted": deleted, "complete": True}

            acknowledged = []
            for job_id in job_ids:
                path = _local_result_path(job_id)
                try:
                    path.unlink(missing_ok=True)
                    try:
                        path.parent.rmdir()
                    except OSError:
                        pass
                    acknowledged.append(job_id)
                    deleted += 1
                except OSError:
                    logger.exception("Could not remove reset bot source %s", path)

            if acknowledged:
                _rpc("admin_ack_reset_source_cleanup_ids", {"p_job_ids": acknowledged})
            if len(acknowledged) != len(job_ids):
                return {"deleted": deleted, "complete": False}
            batches += 1
            if max_batches is not None and batches >= max_batches:
                more = _rpc("admin_list_reset_source_cleanup_ids", {"p_limit": 1}) or []
                return {"deleted": deleted, "complete": not bool(more)}
    except Exception:
        logger.exception("Could not drain reset bot-source cleanup queue")
        return {"deleted": deleted, "complete": False}


def _save_source(job_id, source):
    path = _local_result_path(job_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".py.tmp")
    tmp.write_bytes(source)
    os.replace(tmp, path)
    return path


def _evaluate_result(match, duration):
    """Return the entry-score breakdown using Judge0's recorded BO2 output."""
    import engine

    total_captures = total_losses = total_user_moves = 0
    min_dist = 999
    details = []
    for idx, game in enumerate(match["games"]):
        user_idx = 0 if game["players"][0] == "a" else 1
        goal = (8, 8) if user_idx == 0 else (0, 0)
        board = engine.initial()
        captures = losses = user_moves = 0
        closest = 8
        for player, move in game.get("moves", []):
            x, y, nx, ny = move
            target = board.get((nx, ny))
            if player == user_idx:
                user_moves += 1
                closest = min(closest, max(abs(nx - goal[0]), abs(ny - goal[1])))
                if target is not None and target[0] != user_idx:
                    captures += 1
            elif target is not None and target[0] == user_idx:
                losses += 1
            board = engine.apply(board, tuple(move))
        total_captures += captures
        total_losses += losses
        total_user_moves += user_moves
        min_dist = min(min_dist, closest)
        result = int(game.get("result", 0))
        end_reason = "Hoà sau 200 nước đi cân não."
        if result > 0:
            end_reason = "Thí sinh thắng ván đấu."
        elif result < 0:
            end_reason = "Bot mẫu thắng ván đấu."
        details.append({
            "game_number": idx + 1,
            "role": "Đi trước" if user_idx == 0 else "Đi sau",
            "result": result,
            "result_text": "Thắng (+1)" if result > 0 else ("Thua (-1)" if result < 0 else "Hòa (0)"),
            "total_plies": len(game.get("moves", [])),
            "user_moves": user_moves,
            "user_captures": captures,
            "user_losses": losses,
            "closest_to_goal": closest,
            "end_reason": end_reason,
        })
    min_dist = 8 if min_dist == 999 else min_dist
    score = int(match["match_score"])
    has_fault = any(g.get("fault", False) for g in match["games"])
    validity = 15 if has_fault else 30
    offense = min(30, max(0, total_captures * 6 + max(0, 8 - min_dist) * 2))
    defense = max(0, 25 - total_losses * 4)
    avg_ms = (duration / max(total_user_moves, 1)) * 1000
    speed = 15 if avg_ms < 300 else (10 if avg_ms < 800 else 5)
    converted = max(10, min(100, validity + offense + defense + speed + score * 5))
    passed = score >= -1
    return {
        "ok": True,
        "converted_score": converted,
        "match_score": score,
        "match_pts": (score > 0) - (score < 0),
        "match_result": "THẮNG CHUNG CUỘC" if score > 0 else ("THUA CHUNG CUỘC" if score < 0 else "HÒA CHUNG CUỘC"),
        "passed": passed,
        "status_badge": "ĐẠT CHUẨN THI ĐẤU" if passed else "CẦN TỐI ƯU THÊM",
        "duration_seconds": round(duration, 2),
        "criteria": {
            "validity": {"name": "Tính hợp lệ & Ổn định", "score": f"{validity}/30", "status": "PASS" if not has_fault else "CẢNH BÁO"},
            "offense": {"name": "Năng lực Tấn công", "score": f"{offense}/30", "status": "Tốt" if total_captures >= 2 else "Trung bình"},
            "defense": {"name": "Năng lực Phòng thủ", "score": f"{defense}/25", "status": "Tốt" if total_losses <= 2 else "Cần chú ý"},
            "speed": {"name": "Tốc độ xử lý", "score": f"{speed}/15 ({round(avg_ms, 1)} ms)", "status": "Đạt yêu cầu"},
        },
        "games": details,
        "tips": [],
    }


def _run_job(job_id, source_path, job):
    global _completed_jobs, _failed_jobs
    deadline = time.monotonic() + JOB_TIMEOUT_SECONDS
    try:
        logger.info("Starting scoring job %s (kind=%s)", job_id, job.get("kind"))
        _rpc("mark_scoring_job_running", {"p_job_id": job_id})
        if job.get("kind") == "submission":
            result = {"ok": True, "submitted": True, "job_id": job_id}
            _rpc("complete_scoring_job", {"p_job_id": job_id, "p_result": result})
            logger.info("Submission %s is ready for its scheduled match", job_id)
            if job.get("rnd") and job.get("day"):
                _schedule_tournament_day(int(job["rnd"]), int(job["day"]))
            return
        started = time.monotonic()
        logger.info("Job %s uses Judge0 language id %s", job_id, job.get("language_id"))
        source = source_path.read_bytes()
        if job.get("kind") == "entry":
            weights = (1, 2, 3)
            benchmark_paths = [ROOT / "sample_bots" / f"entry_bot{index}.py" for index in range(3)]
            matches = []
            for path in benchmark_paths:
                if time.monotonic() >= deadline:
                    raise Judge0Error("scoring_job_timeout", "Scoring job exceeded its time limit.")
                matches.append(run_match(
                    source,
                    path.read_bytes(),
                    language_id=job.get("language_id"),
                    max_seconds=min(MATCH_TIMEOUT_SECONDS, max(1, int(deadline - time.monotonic()))),
                ))
            evaluation = _evaluate_entry(matches, weights, time.monotonic() - started)
            games = [game for match in matches for game in match["games"]]
        elif job.get("kind") == "test":
            catalog = {item["id"]: item for item in _benchmark_catalog()}
            selected = job.get("benchmark_ids") or ["sample"]
            selected_benchmarks = [catalog[benchmark_id] for benchmark_id in selected if benchmark_id in catalog]
            if len(selected_benchmarks) != len(selected) or not selected_benchmarks:
                raise ValueError("practice_benchmark_not_found")
            matches = []
            for item in selected_benchmarks:
                if time.monotonic() >= deadline:
                    raise Judge0Error("scoring_job_timeout", "Scoring job exceeded its time limit.")
                matches.append(run_match(
                    source,
                    Path(item["path"]).read_bytes(),
                    language_id=job.get("language_id"),
                    max_seconds=min(MATCH_TIMEOUT_SECONDS, max(1, int(deadline - time.monotonic()))),
                ))
            evaluation = _evaluate_practice(matches, [item["name"] for item in selected_benchmarks])
            games = [game for match in matches for game in match["games"]]
        else:
            match = run_match(
                source,
                BENCHMARK_PATH.read_bytes(),
                language_id=job.get("language_id"),
                max_seconds=min(MATCH_TIMEOUT_SECONDS, max(1, int(deadline - time.monotonic()))),
            )
            evaluation = _evaluate_result(match, match.get("duration_seconds") or (time.monotonic() - started))
            games = match["games"]
        evaluation["judge0_language_id"] = job.get("language_id")
        # Replays are immutable compressed objects in a private Supabase bucket.
        # Upload failure is logged but does not discard a successfully computed score.
        try:
            _store_job_replay(job_id, games)
        except Exception:
            logger.exception("Could not upload replay for scoring job %s", job_id)
        _rpc("complete_scoring_job", {"p_job_id": job_id, "p_result": evaluation})
        with _metrics_lock:
            _completed_jobs += 1
        logger.info("Scoring job %s completed and reported to Supabase", job_id)
    except Judge0Error as exc:
        with _metrics_lock:
            _failed_jobs += 1
        try:
            _rpc("fail_scoring_job", {"p_job_id": job_id, "p_error_code": exc.code, "p_error_message": str(exc)[:500]})
        except Exception:
            logger.exception("Could not report Judge0 failure to Supabase for job %s", job_id)
        logger.warning("Scoring job %s failed in Judge0 [%s]: %s", job_id, exc.code, exc)
    except Exception as exc:
        with _metrics_lock:
            _failed_jobs += 1
        try:
            _rpc("fail_scoring_job", {"p_job_id": job_id, "p_error_code": "module_error", "p_error_message": type(exc).__name__})
        except Exception:
            logger.exception("Could not report module failure to Supabase for job %s", job_id)
        logger.exception("Scoring job %s failed", job_id)
    finally:
        try:
            source_path.unlink(missing_ok=True)
        except OSError:
            logger.exception("Could not remove source file for scoring job %s", job_id)
        with _dedupe_lock:
            _inflight.discard(job_id)
        _capacity.release()


def _queue_depth():
    rows = get_supabase().select(
        "scoring_jobs",
        {
            "select": "id,created_at,status",
            "status": "in.(dispatching,accepted,running)",
            "order": "created_at.asc",
            "limit": str(QUEUE_CAPACITY + 1),
        },
    ) or []
    return rows


def _queue_dispatch_loop():
    global _last_invalid_claim_log
    worker_id = f"{socket.gethostname()}:{os.getpid()}"
    last_requeue = 0.0
    while True:
        try:
            if time.monotonic() - last_requeue >= 5:
                _rpc("requeue_expired_scoring_jobs", {})
                last_requeue = time.monotonic()
            while _capacity.acquire(blocking=False):
                claimed = _rpc("claim_scoring_job", {
                    "p_worker_id": worker_id,
                    "p_lease_seconds": max(90, JOB_TIMEOUT_SECONDS + 30),
                })
                if not claimed:
                    _capacity.release()
                    break
                claimed = _claimed_job_record(claimed)
                if not claimed:
                    now = time.monotonic()
                    if now - _last_invalid_claim_log >= 30:
                        logger.warning(
                            "Scoring queue claim returned an invalid composite response; releasing slot"
                        )
                        _last_invalid_claim_log = now
                    _capacity.release()
                    time.sleep(max(1.0, QUEUE_POLL_SECONDS))
                    break
                job_id = str(claimed["id"])
                source_path = _local_result_path(job_id)
                if not source_path.is_file():
                    _rpc("fail_scoring_job", {
                        "p_job_id": job_id,
                        "p_error_code": "source_missing",
                        "p_error_message": "Scoring source file is missing on the module host.",
                    })
                    try:
                        source_path.unlink(missing_ok=True)
                    except OSError:
                        logger.exception("Could not remove missing source path for %s", job_id)
                    _capacity.release()
                    continue
                job = dict(claimed)
                job["language_id"] = int(os.environ.get("OTT_JUDGE0_PYTHON_ID", "71"))
                with _dedupe_lock:
                    _inflight.add(job_id)
                try:
                    _workers.submit(_run_job, job_id, source_path, job)
                except Exception:
                    with _dedupe_lock:
                        _inflight.discard(job_id)
                    _capacity.release()
                    raise
            time.sleep(QUEUE_POLL_SECONDS)
        except Exception:
            logger.exception("Scoring queue dispatcher failed; retrying")
            time.sleep(max(1.0, QUEUE_POLL_SECONDS))


def _evaluate_entry(matches, weights, duration):
    scores = [int(match.get("match_score", 0)) for match in matches]
    qualification_score = sum(weight * score for weight, score in zip(weights, scores))
    return {
        "ok": True,
        "qualification_score": qualification_score,
        "converted_score": qualification_score,
        "benchmark_scores": scores,
        "entry_weights": list(weights),
        "passed": qualification_score >= -2,
        "status_badge": "ĐẠT VÒNG LOẠI" if qualification_score >= -2 else "BỊ LOẠI",
        "duration_seconds": round(duration, 2),
        "criteria": {
            "qualification": {
                "name": "Điểm đầu vào có trọng số",
                "score": f"{qualification_score}/12",
                "status": "PASS" if qualification_score >= -2 else "FAIL",
                "breakdown": scores,
            }
        },
        "games": [game for match in matches for game in match.get("games", [])],
    }


def _evaluate_practice(matches, names):
    scores = [int(match.get("match_score", 0)) for match in matches]
    return {
        "ok": True,
        "practice": True,
        "opponents": [{"name": names[index] if index < len(names) else f"Bot {index + 1}",
                       "match_score": score, "match_pts": (score > 0) - (score < 0)}
                      for index, score in enumerate(scores)],
        "total_match_pts": sum((score > 0) - (score < 0) for score in scores),
        "games": [game for match in matches for game in match.get("games", [])],
    }


def _benchmark_catalog():
    catalog = [{"id": "btc0", "name": "Bot BTC 1", "path": str(ROOT / "sample_bots" / "entry_bot0.py")},
               {"id": "btc1", "name": "Bot BTC 2", "path": str(ROOT / "sample_bots" / "entry_bot1.py")},
               {"id": "btc2", "name": "Bot BTC 3", "path": str(ROOT / "sample_bots" / "entry_bot2.py")},
               {"id": "sample", "name": "Bot mẫu", "path": str(BENCHMARK_PATH)}]
    try:
        BENCHMARK_STORE.mkdir(parents=True, exist_ok=True)
        for path in sorted(BENCHMARK_STORE.glob("*.py")):
            parts = path.stem.split("_", 1)
            catalog.append({"id": parts[0], "name": parts[1] if len(parts) > 1 else path.stem, "path": str(path)})
    except OSError:
        logger.exception("Could not enumerate practice benchmark bots")
    return catalog


def _store_job_replay(job_id, games):
    raw = json.dumps(games, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    compressed = gzip.compress(raw, compresslevel=6, mtime=0)
    path = f"jobs/{job_id}.json.gz"
    sb = get_supabase()
    sb.upload_storage_object("replays", path, compressed, "application/gzip")
    metadata = {
        "job_id": job_id,
        "storage_path": path,
        "content_type": "application/gzip",
        "size_bytes": len(compressed),
        "sha256": hashlib.sha256(compressed).hexdigest(),
        "state": "ready",
    }
    updated = sb.update("replay_objects", {"job_id": f"eq.{job_id}"}, metadata)
    if not updated:
        sb.insert("replay_objects", [metadata])


def _store_match_replay(match_id, games):
    raw = json.dumps(games, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    compressed = gzip.compress(raw, compresslevel=6, mtime=0)
    path = f"matches/{match_id}.json.gz"
    sb = get_supabase()
    sb.upload_storage_object("replays", path, compressed, "application/gzip")
    metadata = {
        "match_id": match_id,
        "storage_path": path,
        "content_type": "application/gzip",
        "size_bytes": len(compressed),
        "sha256": hashlib.sha256(compressed).hexdigest(),
        "state": "ready",
    }
    updated = sb.update("replay_objects", {"match_id": f"eq.{match_id}"}, metadata)
    if not updated:
        sb.insert("replay_objects", [metadata])
    sb.update("matches", {"id": f"eq.{match_id}"}, {"has_replay": True})


def _match_source(job_id):
    if not job_id:
        return None
    path = _local_result_path(str(job_id))
    if not path.is_file():
        logger.error("Missing local bot source for completed submission job %s", job_id)
        return None
    return path.read_bytes()


def _process_tournament_day(round_number, day_number):
    sb = get_supabase()
    day_rows = sb.select("contest_days", {
        "rnd": f"eq.{round_number}", "day": f"eq.{day_number}",
        "select": "state", "limit": "1",
    })
    if not day_rows:
        return
    day_state = day_rows[0]["state"]
    if day_state == "closed":
        # Recover a day if the module stopped between the admin close action and
        # its grading transition. The RPC is idempotent for open/closed days.
        _rpc("admin_close_tournament_day", {})
        day_rows = sb.select("contest_days", {
            "rnd": f"eq.{round_number}", "day": f"eq.{day_number}",
            "select": "state", "limit": "1",
        })
        if not day_rows:
            return
        day_state = day_rows[0]["state"]
    if day_state not in ("open", "grading"):
        return
    for rd in range(1, 8):
        matches = _rpc("prepare_swiss_round", {"p_rnd": round_number, "p_day": day_number, "p_rd": rd}) or []
        pending = [row for row in matches if row.get("match_state") in ("pending", "running")]
        def process_match(row):
            source_a = _match_source(row.get("job_a")) if row.get("job_a") else None
            source_b = _match_source(row.get("job_b")) if row.get("job_b") else None
            ready_a, ready_b = source_a is not None, source_b is not None
            if not (ready_a and ready_b) and day_state != "grading":
                return
            if ready_a and ready_b:
                if not _rpc("mark_tournament_match_running", {"p_match_id": row["match_id"]}):
                    return
                try:
                    with _tournament_lock:
                        _active_match_ids.add(int(row["match_id"]))
                    result = run_match(source_a, source_b)
                    try:
                        # Keep the match leased as running until replay persistence
                        # has finished, so an admin reset cannot orphan its upload.
                        _store_match_replay(row["match_id"], result["games"])
                    except Exception:
                        logger.exception("Could not upload replay for tournament match %s", row["match_id"])
                    _rpc("record_tournament_match", {
                        "p_match_id": row["match_id"], "p_score_a": result["match_score"],
                        "p_a_ready": True, "p_b_ready": True,
                    })
                finally:
                    with _tournament_lock:
                        _active_match_ids.discard(int(row["match_id"]))
            else:
                if day_state != "grading":
                    return
                # Claim pending work or an expired lease before awarding a
                # forfeit. A still-running worker keeps its match protected.
                if not _rpc("mark_tournament_match_running", {"p_match_id": row["match_id"]}):
                    return
                with _tournament_lock:
                    _active_match_ids.add(int(row["match_id"]))
                try:
                    _rpc("record_tournament_match", {
                        "p_match_id": row["match_id"], "p_score_a": 0,
                        "p_a_ready": ready_a, "p_b_ready": ready_b,
                    })
                finally:
                    with _tournament_lock:
                        _active_match_ids.discard(int(row["match_id"]))

        # Keep the Judge0 load bounded while allowing independent pairs to run concurrently.
        futures = [_match_workers.submit(process_match, row) for row in pending]
        for future in futures:
            future.result()
        refreshed = _rpc("prepare_swiss_round", {"p_rnd": round_number, "p_day": day_number, "p_rd": rd}) or []
        unresolved = [row for row in refreshed if row.get("match_state") not in ("completed", "forfeit")]
        if unresolved and day_state != "grading":
            return
        if unresolved:
            # A worker may have died while a match was marked running. Its DB lease
            # expires after five minutes; retry once that claim can be recovered.
            retry = threading.Timer(125, _schedule_tournament_day, args=(round_number, day_number))
            retry.daemon = True
            retry.start()
            return
    # Final rankings and advancement are committed in one Supabase transaction after the day is closed.
    if day_state == "grading":
        result = _rpc("finalize_tournament_day", {"p_rnd": round_number, "p_day": day_number})
        logger.info("Tournament day r%s/d%s finalized: %s", round_number, day_number, result)
        next_round = result.get("next_round") if isinstance(result, dict) else None
        if next_round:
            _schedule_tournament_day(int(next_round), 1)


def _schedule_tournament_day(round_number, day_number):
    key = (round_number, day_number)
    with _tournament_lock:
        if key in _tournament_days:
            _tournament_reschedule.add(key)
            return
        _tournament_days.add(key)

    def run():
        try:
            logger.info("Processing Supabase tournament day r%s/d%s", round_number, day_number)
            _process_tournament_day(round_number, day_number)
            _tournament_retry_counts.pop(key, None)
        except Exception:
            logger.exception("Tournament day processing failed for r%s/d%s", round_number, day_number)
            retries = _tournament_retry_counts.get(key, 0) + 1
            _tournament_retry_counts[key] = retries
            retry_seconds = min(120, 5 * (2 ** min(retries - 1, 5)))
            retry = threading.Timer(retry_seconds, _schedule_tournament_day, args=key)
            retry.daemon = True
            retry.start()
        finally:
            rerun = False
            with _tournament_lock:
                _tournament_days.discard(key)
                if key in _tournament_reschedule:
                    _tournament_reschedule.discard(key)
                    rerun = True
            if rerun:
                _schedule_tournament_day(round_number, day_number)

    _tournament_workers.submit(run)


@app.on_event("startup")
def resume_tournament_work_after_restart():
    global _queue_dispatcher_started
    if not _queue_dispatcher_started:
        _queue_dispatcher_started = True
        threading.Thread(target=_queue_dispatch_loop, name="scoring-queue", daemon=True).start()
    try:
        _tournament_workers.submit(_cleanup_reset_source_files)
        rows = get_supabase().select("tournament_state", {
            "id": "eq.1", "select": "phase,current_round,current_day", "limit": "1",
        })
        if rows and rows[0].get("phase") == "round" and int(rows[0].get("current_day") or 0) > 0:
            _schedule_tournament_day(int(rows[0]["current_round"]), int(rows[0]["current_day"]))
    except Exception:
        logger.exception("Could not resume tournament work during startup")


@app.get("/health")
@app.get("/v1/health")
async def health():
    return {"ok": True, "service": "ott-scoring-module"}


@app.get("/v1/admin/metrics")
async def admin_metrics(authorization: str | None = Header(None)):
    token = _token(authorization)
    user = await asyncio.to_thread(_user, token)
    profiles = await asyncio.to_thread(
        get_supabase().select,
        "profiles",
        {"id": f"eq.{user.get('id')}", "select": "role", "limit": "1"},
    )
    if not profiles or profiles[0].get("role") != "admin":
        raise HTTPException(status_code=403, detail="Chỉ admin được xem metrics")
    with _dedupe_lock:
        active = len(_inflight)
    try:
        queue_rows = _queue_depth()
    except Exception:
        logger.exception("Could not read scoring queue metrics")
        queue_rows = []
    with _metrics_lock:
        rejected = _rejected_jobs
        completed = _completed_jobs
        failed = _failed_jobs
    queued = len(queue_rows)
    oldest_age = 0
    if queue_rows:
        oldest = queue_rows[0].get("created_at")
        if oldest:
            try:
                oldest_age = max(0, int(time.time() - __import__("datetime").datetime.fromisoformat(oldest.replace("Z", "+00:00")).timestamp()))
            except (TypeError, ValueError):
                oldest_age = 0
    try:
        judge0 = {"status": "online", **judge0_status()}
    except Exception as exc:
        logger.warning("Admin metrics could not reach Judge0 (%s)", type(exc).__name__)
        judge0 = {"status": "offline"}
    return {
        "status": "online",
        "uptime_seconds": max(0, int(time.time() - _started_at)),
        "workers": WORKER_COUNT,
        "active_jobs": active,
        "job_capacity": QUEUE_CAPACITY,
        "available_slots": _capacity._value,
        "queue_depth": queued,
        "queue_limit": QUEUE_CAPACITY,
        "queued_jobs": max(0, queued - active),
        "oldest_queued_seconds": oldest_age,
        "rejected_jobs": rejected,
        "completed_jobs": completed,
        "failed_jobs": failed,
        "match_timeout_seconds": MATCH_TIMEOUT_SECONDS,
        "job_timeout_seconds": JOB_TIMEOUT_SECONDS,
        "judge0": judge0,
    }


def _require_scoring_admin(authorization):
    token = _token(authorization)
    user = _user(token)
    profiles = get_supabase().select("profiles", {"id": f"eq.{user.get('id')}", "select": "role", "limit": "1"})
    if not profiles or profiles[0].get("role") != "admin":
        raise HTTPException(status_code=403, detail="Chỉ admin được điều hành giải đấu")
    return user


@app.post("/v1/admin/tournament/close-entry")
async def close_qualification(authorization: str | None = Header(None)):
    _require_scoring_admin(authorization)
    try:
        result = _rpc("admin_close_qualification", {})
        _schedule_tournament_day(1, 1)
        return {"ok": True, "result": result}
    except Exception as exc:
        logger.exception("Could not close tournament qualification")
        raise HTTPException(status_code=409, detail=str(exc)[:300]) from None


@app.post("/v1/admin/tournament/reset")
async def reset_tournament(authorization: str | None = Header(None)):
    _require_scoring_admin(authorization)
    try:
        with _dedupe_lock:
            live_job_ids = sorted(_inflight)
        with _tournament_lock:
            live_match_ids = sorted(_active_match_ids)
        result = _rpc("admin_reset_tournament_to_entry", {
            "p_live_job_ids": live_job_ids,
            "p_live_match_ids": live_match_ids,
        })
        source_cleanup = _cleanup_reset_source_files(max_batches=1)
        if not source_cleanup["complete"]:
            logger.error("Tournament reset committed; some local bot sources remain queued for cleanup")
        return {"ok": True, "result": result, "source_cleanup": source_cleanup}
    except Exception as exc:
        logger.exception("Could not reset tournament")
        raise HTTPException(status_code=409, detail=str(exc)[:300]) from None


@app.post("/v1/admin/tournament/cleanup-reset-artifacts")
async def cleanup_reset_artifacts(authorization: str | None = Header(None)):
    _require_scoring_admin(authorization)
    return {"ok": True, "source_cleanup": _cleanup_reset_source_files(max_batches=1)}


@app.post("/v1/admin/tournament/open-day")
async def open_tournament_day(payload: dict, authorization: str | None = Header(None)):
    _require_scoring_admin(authorization)
    try:
        round_number, day_number = int(payload["round"]), int(payload["day"])
        _rpc("admin_open_tournament_day", {"p_rnd": round_number, "p_day": day_number})
        _schedule_tournament_day(round_number, day_number)
        return {"ok": True, "round": round_number, "day": day_number}
    except Exception as exc:
        logger.exception("Could not open tournament day")
        raise HTTPException(status_code=409, detail=str(exc)[:300]) from None


@app.post("/v1/admin/tournament/close-day")
async def close_tournament_day(authorization: str | None = Header(None)):
    _require_scoring_admin(authorization)
    try:
        result = _rpc("admin_close_tournament_day", {})
        _schedule_tournament_day(int(result["round"]), int(result["day"]))
        return {"ok": True, "result": result}
    except Exception as exc:
        logger.exception("Could not close tournament day")
        raise HTTPException(status_code=409, detail=str(exc)[:300]) from None


@app.post("/v1/admin/tournament/resume-day")
async def resume_tournament_day(payload: dict, authorization: str | None = Header(None)):
    _require_scoring_admin(authorization)
    try:
        round_number, day_number = int(payload["round"]), int(payload["day"])
        _schedule_tournament_day(round_number, day_number)
        return {"ok": True, "round": round_number, "day": day_number}
    except Exception as exc:
        logger.exception("Could not resume tournament day")
        raise HTTPException(status_code=409, detail=str(exc)[:300]) from None


@app.get("/v1/languages")
async def get_default_bot_language():
    try:
        return {"language": default_bot_language()}
    except Judge0Error as exc:
        logger.warning("Could not load supported Judge0 languages: %s", exc)
        raise HTTPException(status_code=503, detail="Không lấy được danh sách ngôn ngữ từ Judge0") from None


@app.get("/v1/benchmarks")
async def get_benchmarks():
    return {"benchmarks": [{"id": item["id"], "name": item["name"]} for item in _benchmark_catalog()]}


@app.post("/v1/admin/benchmarks")
async def upload_benchmark(file: UploadFile = File(...), authorization: str | None = Header(None)):
    _require_scoring_admin(authorization)
    if not file.filename or Path(file.filename).suffix.lower() != ".py":
        raise HTTPException(status_code=400, detail="Chỉ nhận file Python .py")
    source = await file.read(MAX_SOURCE_BYTES + 1)
    if not source or len(source) > MAX_SOURCE_BYTES:
        raise HTTPException(status_code=413, detail="File bot phải có kích thước tối đa 64 KB")
    try:
        tree = ast.parse(source, filename="benchmark.py")
        compile(tree, "benchmark.py", "exec")
        if not any(isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "choose_move" for node in tree.body):
            raise ValueError("Bot cần khai báo hàm choose_move(state)")
    except (SyntaxError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"Lỗi cú pháp Python: {exc}") from None
    name = re.sub(r"[^A-Za-z0-9_-]+", "-", Path(file.filename).stem).strip("-_")[:40] or "bot-mau"
    benchmark_id = str(uuid.uuid4())
    BENCHMARK_STORE.mkdir(parents=True, exist_ok=True)
    target = BENCHMARK_STORE / f"{benchmark_id}_{name}.py"
    target.write_bytes(source)
    logger.info("Admin uploaded practice benchmark %s (%s bytes)", benchmark_id, len(source))
    return {"ok": True, "benchmark": {"id": benchmark_id, "name": name}}


@app.post("/v1/jobs/{job_id}", status_code=202)
async def accept_job(
    job_id: str,
    file: UploadFile = File(...),
    benchmark_ids: str = Form(""),
    authorization: str | None = Header(None),
):
    if not JOB_ID_RE.fullmatch(job_id):
        raise HTTPException(status_code=400, detail="Job ID không hợp lệ")
    token = _token(authorization)
    user = _user(token)
    source = await file.read(MAX_SOURCE_BYTES + 1)
    if not file.filename or not file.filename.lower().endswith(".py"):
        raise HTTPException(status_code=400, detail="Chỉ nhận file .py")
    if not source or len(source) > MAX_SOURCE_BYTES:
        raise HTTPException(status_code=413, detail="File bot phải có kích thước tối đa 64 KB")
    try:
        compile(source, "submission.py", "exec")
    except (SyntaxError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"Lỗi cú pháp Python: {exc}") from None

    digest = hashlib.sha256(source).hexdigest()
    sb = get_supabase()
    rows = await asyncio.to_thread(
        sb.select,
        "scoring_jobs",
        {"id": f"eq.{job_id}", "user_id": f"eq.{user.get('id')}", "limit": "1"},
    )
    if not rows:
        # The browser sends the Supabase insert and this request concurrently.
        # Give the insert a short window to commit, then reject and do not score.
        for _ in range(20):
            await __import__("asyncio").sleep(0.1)
            rows = await asyncio.to_thread(
                sb.select,
                "scoring_jobs",
                {"id": f"eq.{job_id}", "user_id": f"eq.{user.get('id')}", "limit": "1"},
            )
            if rows:
                break
    if not rows:
        raise HTTPException(status_code=409, detail="Supabase chưa ghi nhận yêu cầu chấm")
    job = rows[0]
    if job.get("status") != "dispatching" or job.get("sha256") != digest or job.get("size_bytes") != len(source):
        raise HTTPException(status_code=409, detail="Thông tin job không khớp hoặc job đã được xử lý")
    if job.get("kind") not in ("entry", "submission", "test"):
        raise HTTPException(status_code=400, detail="Loại job không được hỗ trợ")
    if job.get("kind") == "test":
        selected_ids = list(dict.fromkeys(item for item in benchmark_ids.split(",") if item)) or ["sample"]
        available_ids = {item["id"] for item in _benchmark_catalog()}
        if len(selected_ids) > 8 or any(item not in available_ids for item in selected_ids):
            raise HTTPException(status_code=400, detail="Danh sách bot luyện tập không hợp lệ")
        job["benchmark_ids"] = selected_ids
        try:
            await asyncio.to_thread(
                get_supabase().update,
                "scoring_jobs",
                {"id": f"eq.{job_id}"},
                {"benchmark_ids": selected_ids},
            )
        except Exception:
            logger.exception("Could not persist practice benchmark selection for job %s", job_id)
            raise HTTPException(status_code=503, detail="Không lưu được cấu hình bot luyện tập") from None

    try:
        queued_rows = await asyncio.to_thread(_queue_depth)
    except Exception:
        logger.exception("Could not inspect queue before accepting job %s", job_id)
        raise HTTPException(status_code=503, detail="Không kiểm tra được sức chứa hàng đợi") from None
    if len(queued_rows) >= QUEUE_CAPACITY:
        with _metrics_lock:
            _rejected_jobs += 1
        raise HTTPException(status_code=503, detail="Hàng đợi chấm đang đầy; vui lòng thử lại")
    source_path = _save_source(job_id, source)
    try:
        accepted = await asyncio.to_thread(
            _rpc,
            "mark_scoring_job_accepted",
            {"p_job_id": job_id},
        )
        if accepted is False:
            source_path.unlink(missing_ok=True)
            raise HTTPException(status_code=409, detail="Job đã được nhận hoặc không còn chờ")
    except HTTPException:
        raise
    except Exception:
        source_path.unlink(missing_ok=True)
        logger.exception("Could not enqueue scoring job %s", job_id)
        raise HTTPException(status_code=503, detail="Không thể đưa job vào hàng đợi") from None
    logger.info("Queued scoring job %s (kind=%s, user=%s)", job_id, job.get("kind"), user.get("id"))
    return {"ok": True, "job_id": job_id, "status": "queued", "queue_depth": len(queued_rows) + 1}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("servers.scoring.module:app", host="127.0.0.1", port=int(os.environ.get("OTT_SCORING_PORT", "8110")))
