/**
 * Cloudflare Worker proxy and Durable Object queue for the OTT BO2 scorer.
 *
 * The browser calls this Worker directly. Supabase JWTs authenticate
 * contestants; OnlineCompiler credentials remain Worker secrets.
 */

const MAX_SOURCE_BYTES = 65536;
const MAX_REQUEST_BYTES = MAX_SOURCE_BYTES * 2 + 4096;
const MAX_QUEUE_SIZE = 200;
const UPSTREAM_CONCURRENCY = 2;
// Two submissions every 4.2 seconds stays below the Free-plan limit of
// 30 submissions/minute while using both execution slots.
const UPSTREAM_INTERVAL_MS = 4200;
const MAX_RETRIES = 5;
const MATCH_MAX_RETRIES = 2;
const UPSTREAM_REQUEST_TIMEOUT_MS = 120_000;
const MATCH_SCORING_MAX_MS = 8 * 60_000;
const MATCH_SUBMISSION_WINDOW_MS = 90_000;
const MATCH_TIMEOUT_GRACE_MS = 5_000;
const ONLINECOMPILER_URL = "https://api.onlinecompiler.io/api/run-code-sync/";

async function authenticate(request, env) {
  const token = request.headers.get("authorization");
  if (!token?.match(/^Bearer\s+\S+$/i)) return null;
  if (
    !env.SUPABASE_URL ||
    env.SUPABASE_URL === "https://your-project.supabase.co" ||
    !env.SUPABASE_ANON_KEY
  ) {
    throw new Error("supabase_auth_not_configured");
  }
  const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, authorization: token },
  });
  if (!response.ok) return null;
  const user = await response.json();
  return user?.id ? { id: user.id, token } : null;
}

async function supabaseRpc(env, token, name, body) {
  const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      authorization: token,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`supabase_${name}_${response.status}:${payload?.message || payload?.hint || "request failed"}`);
  return payload;
}

async function supabaseServiceRpc(env, name, body) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("supabase_service_role_not_configured");
  const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`supabase_${name}_${response.status}:${payload?.message || payload?.hint || "request failed"}`);
  return payload;
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
  };
}

function supabaseAuthConfigured(env) {
  return Boolean(
    env.SUPABASE_URL &&
    env.SUPABASE_URL !== "https://your-project.supabase.co" &&
    env.SUPABASE_ANON_KEY,
  );
}

function utf8Base64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function runnerSource(contestant, benchmark) {
  const contestantBase64 = utf8Base64(contestant);
  const benchmarkBase64 = utf8Base64(benchmark);

  return `import base64, contextlib, io, json, os, queue, signal, subprocess, sys, tempfile, threading

BEAT = {0: 2, 1: 0, 2: 1}
DIRS = [(dx, dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1) if dx or dy]
MAX_PLIES = 200
CONTESTANT = base64.b64decode("${contestantBase64}")
BENCHMARK = base64.b64decode("${benchmarkBase64}")

DRIVER = r"""import base64, contextlib, io, json, random, sys
random.seed(0)
ns = {"__name__": "ott_contestant"}
code = base64.b64decode("__BOT_CODE__")
try:
    with contextlib.redirect_stdout(io.StringIO()):
        exec(compile(code, "contestant.py", "exec"), ns, ns)
    fn = ns.get("choose_move") or ns.get("choose_best_move")
    if not callable(fn):
        raise ValueError("Bot must define choose_move(state)")
except BaseException:
    fn = None
for line in sys.stdin:
    try:
        state = json.loads(line)
        if fn is None:
            raise ValueError("Bot initialization failed")
        with contextlib.redirect_stdout(io.StringIO()):
            move = fn(state)
        if not isinstance(move, (tuple, list)) or len(move) != 4:
            raise ValueError("choose_move must return four coordinates")
        print(" ".join(str(int(value)) for value in move), flush=True)
    except BaseException:
        print("-1 -1 -1 -1", flush=True)
"""

def start_bot(code, name, workdir):
    encoded = base64.b64encode(code).decode("ascii")
    path = os.path.join(workdir, name + "_driver.py")
    with open(path, "w", encoding="utf-8") as stream:
        stream.write(DRIVER.replace("__BOT_CODE__", encoded))
    return ProcBot(path, workdir)

class ProcBot:
    def __init__(self, path, workdir):
        self.lines = queue.Queue(maxsize=8)
        self.process = subprocess.Popen(
            [sys.executable, "-I", path], cwd=workdir, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
            start_new_session=True, env={},
        )
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._drain, daemon=True).start()
    def _read(self):
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
    def _drain(self):
        try:
            while self.process.stderr.read(4096):
                pass
        except Exception:
            pass
    def move(self, state, timeout):
        try:
            self.process.stdin.write((json.dumps(state) + "\\n").encode())
            self.process.stdin.flush()
            line = self.lines.get(timeout=timeout)
            if line is None:
                return None
            values = [int(value) for value in line.decode(errors="replace").split()]
            return tuple(values) if len(values) == 4 else None
        except Exception:
            return None
    def close(self):
        try:
            os.killpg(self.process.pid, signal.SIGKILL)
        except Exception:
            try:
                self.process.kill()
            except Exception:
                pass
        try:
            self.process.wait(timeout=1)
        except Exception:
            pass

def initial():
    board = {}
    for x in range(9):
        board[(x, 0)] = (0, x % 3)
        board[(x, 8)] = (1, x % 3)
    return board

def legal_moves(board, player):
    moves = []
    for (x, y), (owner, kind) in board.items():
        if owner != player:
            continue
        for dx, dy in DIRS:
            nx, ny = x + dx, y + dy
            if not (0 <= nx < 9 and 0 <= ny < 9):
                continue
            target = board.get((nx, ny))
            if target is None or (target[0] != player and BEAT[kind] == target[1]):
                moves.append((x, y, nx, ny))
    return moves

def state(board, me, ply):
    return {"me": me, "ply": ply, "goal": [8, 8] if me == 0 else [0, 0],
            "pieces": [[x, y, owner, kind] for (x, y), (owner, kind) in board.items()]}

def play(user_code, sample_code, user_first, workdir):
    board = initial()
    user_bot = start_bot(user_code, "contestant", workdir)
    sample_bot = start_bot(sample_code, "benchmark", workdir)
    bots = [user_bot, sample_bot] if user_first else [sample_bot, user_bot]
    user_idx = 0 if user_first else 1
    games = []
    try:
        for ply in range(MAX_PLIES):
            player = ply % 2
            moves = legal_moves(board, player)
            if not moves:
                raw = -1 if player == 0 else 1
                return (raw if user_first else -raw), games, player == user_idx
            move = bots[player].move(state(board, player, ply), 3.0 if ply < 2 else 1.0)
            if move not in moves:
                raw = -1 if player == 0 else 1
                return (raw if user_first else -raw), games, player == user_idx
            x, y, nx, ny = move
            board[(nx, ny)] = board.pop((x, y))
            games.append([player, list(move)])
            if (nx, ny) == ((8, 8) if player == 0 else (0, 0)) or len({kind for owner, kind in board.values() if owner != player}) < 3:
                raw = 1 if player == 0 else -1
                return (raw if user_first else -raw), games, False
        return 0, games, False
    finally:
        user_bot.close()
        sample_bot.close()

try:
    workdir = tempfile.mkdtemp(prefix="ott_match_")
    results, all_games = [], []
    for user_first in (True, False):
        result, games, fault = play(CONTESTANT, BENCHMARK, user_first, workdir)
        results.append(result)
        all_games.append({"players": ["a", "b"] if user_first else ["b", "a"],
                          "result": result, "moves": games, "fault": fault})
    print("OTT_RESULT:" + json.dumps({"match_score": sum(results), "games": all_games}, separators=(",", ":")))
except BaseException as exc:
    print("OTT_ERROR:" + type(exc).__name__ + ":" + str(exc))
`;
}

function extractStdout(payload) {
  if (!payload || typeof payload !== "object") return null;
  for (const key of ["output", "stdout", "stdout_text"]) {
    if (typeof payload[key] === "string") return payload[key];
  }
  for (const key of ["result", "data"]) {
    const output = extractStdout(payload[key]);
    if (output !== null) return output;
  }
  return null;
}

function parseCompilerResult(payload) {
  const stdout = extractStdout(payload);
  if (stdout === null) {
    const detail = payload && typeof payload === "object"
      ? payload.error || payload.exception || payload.stderr || payload.status
      : null;
    throw new Error(
      `OnlineCompiler returned no output${detail ? `: ${String(detail).slice(0, 400)}` : ""}`,
    );
  }

  const lines = stdout.split(/\r?\n/);
  const resultLine = [...lines].reverse().find((line) => line.startsWith("OTT_RESULT:"));
  const errorLine = lines.find((line) => line.startsWith("OTT_ERROR:"));
  if (errorLine) throw new Error(errorLine.slice("OTT_ERROR:".length).slice(0, 500));
  if (!resultLine) throw new Error("Compiler output did not contain OTT_RESULT");

  const result = JSON.parse(resultLine.slice("OTT_RESULT:".length));
  if (!Number.isInteger(result.match_score) || ![-2, -1, 0, 1, 2].includes(result.match_score)) {
    throw new Error("Compiler returned an invalid match score");
  }
  if (!Array.isArray(result.games) || result.games.length !== 2) {
    throw new Error("Compiler returned an invalid BO2 replay");
  }
  const matchResult = result.match_score > 0 ? "win" : result.match_score < 0 ? "loss" : "draw";
  return {
    ok: true,
    match_score: result.match_score,
    qualification_score: result.match_score,
    passed: result.match_score > 0,
    match_result: matchResult,
    games: result.games,
  };
}

function publicJob(job) {
  const result = {
    job_id: job.job_id,
    status: job.status,
    position: job.position ?? null,
    created_at: job.created_at,
    started_at: job.started_at ?? null,
    completed_at: job.completed_at ?? null,
    attempts: job.attempts ?? 0,
  };
  if (job.status === "succeeded") {
    result.match_score = job.result.match_score;
    result.qualification_score = job.result.qualification_score;
    result.passed = job.result.passed;
    result.match_result = job.result.match_result;
    result.games = job.result.games;
  }
  if (job.status === "failed") {
    result.error_code = job.error_code;
    result.error = job.error;
  }
  return result;
}

class ScoringQueue {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.running = new Set();
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/schedule-advance") {
      const body = await request.json();
      if (!Number.isInteger(body?.match_id)) return jsonResponse({ detail: "Invalid match_id" }, 400);
      await this.scheduleRoundAdvance(body.match_id);
      return jsonResponse({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/enqueue-waiting") {
      return this.enqueueWaiting(await request.json());
    }
    if (request.method === "POST" && url.pathname === "/enqueue") {
      return this.enqueue(await request.json());
    }
    if (request.method === "GET" && url.pathname.startsWith("/jobs/")) {
      const jobId = url.pathname.slice(6);
      let job = await this.state.storage.get(`job:${jobId}`);
      const userId = request.headers.get("x-user-id");
      if (job?.user_id && job.user_id !== userId &&
          !(Array.isArray(job.user_ids) && job.user_ids.includes(userId))) {
        return jsonResponse({ detail: "Job not found" }, 404);
      }
      if (job?.status === "waiting") {
        job = await this.tryStartWaiting(job);
      }
      return job ? jsonResponse(publicJob(job)) : jsonResponse({ detail: "Job not found" }, 404);
    }
    if (request.method === "GET" && url.pathname === "/admin/queue") {
      return this.queueStatus();
    }
    if (request.method === "DELETE" && url.pathname === "/admin/queue") {
      return this.clearQueue();
    }
    return jsonResponse({ detail: "Not found" }, 404);
  }

  async queueStatus() {
    const queue = await this.state.storage.get("queue") || [];
    let running = 0;
    let queued = 0;
    const entries = await this.state.storage.list({ prefix: "job:" });
    for (const job of entries.values()) {
      if (job.status === "running") running += 1;
      if (job.status === "queued") queued += 1;
    }
    return jsonResponse({ queued, running, queue_size: queue.length, max_queue_size: MAX_QUEUE_SIZE });
  }

  async clearQueue() {
    const entries = await this.state.storage.list({ prefix: "job:" });
    let deleted = 0;
    for (const [key, job] of entries) {
      if (job.status === "waiting" || job.status === "queued" || job.status === "running") {
        await this.state.storage.delete(key);
        if (Number.isInteger(job.match_id)) {
          await this.state.storage.delete(`match:${job.match_id}`);
        }
        deleted += 1;
      }
    }
    await this.state.storage.put("queue", []);
    return jsonResponse({ ok: true, cleared: deleted, running_requests_may_finish: true });
  }

  async enqueue(body) {
    if (Number.isInteger(body.match_id)) {
      const existingId = await this.state.storage.get(`match:${body.match_id}`);
      if (existingId) {
        const existing = await this.state.storage.get(`job:${existingId}`);
        if (existing) {
          const userIds = new Set(existing.user_ids || []);
          if (existing.user_id) userIds.add(existing.user_id);
          if (body.user_id) userIds.add(body.user_id);
          if (body.opponent_id) userIds.add(body.opponent_id);
          existing.user_ids = [...userIds];
          if (existing.status === "waiting") {
            existing.status = "queued";
            // A waiting job was created from the first contestant's POST.
            // Execute the second contestant's code against the first source;
            // auth_token then maps that score back to player_a in the RPC.
            existing.contestant_code = body.contestant_code;
            existing.benchmark_code = body.benchmark_code;
            existing.auth_token = body.auth_token;
            existing.scoring_user_id = body.user_id;
            const queue = await this.state.storage.get("queue") || [];
            if (!queue.includes(existing.job_id)) {
              if (queue.length >= MAX_QUEUE_SIZE) {
                return jsonResponse({ detail: "Scoring queue is full" }, 503);
              }
              queue.push(existing.job_id);
              await this.state.storage.put("queue", queue);
            }
            await this.state.storage.setAlarm(Date.now());
          }
          await this.state.storage.put(`job:${existing.job_id}`, existing);
          return jsonResponse(publicJob(existing), 202);
        }
        await this.state.storage.delete(`match:${body.match_id}`);
      }
    }
    const queue = await this.state.storage.get("queue") || [];
    if (queue.length >= MAX_QUEUE_SIZE) {
      return jsonResponse({ detail: "Scoring queue is full" }, 503);
    }
    const jobId = body.job_id || crypto.randomUUID();
    const job = {
      job_id: jobId,
      status: "queued",
      contestant_code: body.contestant_code,
      benchmark_code: body.benchmark_code,
      user_id: body.user_id,
      scoring_user_id: body.user_id,
      user_ids: [body.user_id, body.opponent_id].filter(Boolean),
      auth_token: body.auth_token,
      match_id: Number.isInteger(body.match_id) ? body.match_id : null,
      created_at: new Date().toISOString(),
      attempts: 0,
    };
    queue.push(jobId);
    await this.state.storage.put(`job:${jobId}`, job);
    if (Number.isInteger(job.match_id)) {
      await this.state.storage.put(`match:${job.match_id}`, jobId);
    }
    await this.state.storage.put("queue", queue);
    await this.state.storage.setAlarm(Date.now());
    return jsonResponse(publicJob({ ...job, position: queue.length }), 202);
  }

  async enqueueWaiting(body) {
    const existingId = Number.isInteger(body.match_id)
      ? await this.state.storage.get(`match:${body.match_id}`)
      : null;
    if (existingId) {
      const existing = await this.state.storage.get(`job:${existingId}`);
      if (existing && existing.status !== "failed") {
        return jsonResponse(publicJob(existing), 202);
      }
      await this.state.storage.delete(`match:${body.match_id}`);
    }
    const job = {
      job_id: body.job_id || crypto.randomUUID(),
      status: "waiting",
      user_id: body.user_id,
      user_ids: [body.user_id, body.opponent_id].filter(Boolean),
      match_id: body.match_id,
      contestant_code: body.contestant_code || null,
      sha256: body.sha256 || null,
      auth_token: body.auth_token,
      created_at: new Date().toISOString(),
      attempts: 0,
    };
    await this.state.storage.put(`job:${job.job_id}`, job);
    if (Number.isInteger(job.match_id)) {
      await this.state.storage.put(`match:${job.match_id}`, job.job_id);
    }
    await this.state.storage.setAlarm(Date.now() + MATCH_SUBMISSION_WINDOW_MS + MATCH_TIMEOUT_GRACE_MS);
    return jsonResponse(publicJob(job), 202);
  }

  async tryStartWaiting(job) {
    try {
      const match = await supabaseRpc(this.env, job.auth_token, "proxy_prepare_match", {
        p_match_id: job.match_id,
        p_source: job.contestant_code,
        p_sha256: job.sha256,
      });
      if (match?.expired) {
        await this.scheduleRoundAdvance(job.match_id);
        job.status = "failed";
        job.error_code = "opponent_timeout";
        job.error = "Opponent submission deadline passed";
        await this.state.storage.put(`job:${job.job_id}`, job);
        return job;
      }
      if (match?.ready) {
        job.status = "queued";
        job.benchmark_code = match.opponent_code;
        if (match.opponent_id && !job.user_ids?.includes(match.opponent_id)) {
          job.user_ids = [...(job.user_ids || []), match.opponent_id];
        }
        const queue = await this.state.storage.get("queue") || [];
        if (!queue.includes(job.job_id)) queue.push(job.job_id);
        await this.state.storage.put("queue", queue);
        await this.state.storage.put(`job:${job.job_id}`, job);
        await this.state.storage.setAlarm(Date.now());
        return job;
      }
      if (Date.now() - Date.parse(job.created_at) > MATCH_SUBMISSION_WINDOW_MS + MATCH_TIMEOUT_GRACE_MS) {
        const resolution = await supabaseRpc(this.env, job.auth_token, "proxy_resolve_match_timeout", {
          p_match_id: job.match_id,
        });
        if (resolution?.resolved) await this.scheduleRoundAdvance(job.match_id);
        job.status = "failed";
        job.error_code = "opponent_timeout";
        job.error = "Opponent did not submit within 90 seconds";
        await this.state.storage.put(`job:${job.job_id}`, job);
      }
    } catch (error) {
      console.log(`waiting_job_check_failed:${String(error).slice(0, 200)}`);
    }
    return job;
  }

  async alarm() {
    await this.recoverInterruptedJobs();
    await this.processDueRoundAdvances();
    const waiting = [...(await this.state.storage.list({ prefix: "job:" })).values()]
      .filter((job) => job.status === "waiting");
    let nextWaitingAlarm = null;
    for (const job of waiting) {
      await this.tryStartWaiting(job);
      if (job.status === "waiting") {
        const timeoutAt = Date.parse(job.created_at) + MATCH_SUBMISSION_WINDOW_MS + MATCH_TIMEOUT_GRACE_MS;
        nextWaitingAlarm = nextWaitingAlarm === null ? timeoutAt : Math.min(nextWaitingAlarm, timeoutAt);
      }
    }
    await this.dispatch();
    const queueAfterDispatch = await this.state.storage.get("queue") || [];
    await this.scheduleNextTournamentWake(nextWaitingAlarm, queueAfterDispatch.length > 0 || this.running.size > 0);
  }

  async scheduleRoundAdvance(matchId) {
    const key = `advance:${matchId}`;
    const dueAt = Date.now() + 60_000;
    const waitingJobId = await this.state.storage.get(`match:${matchId}`);
    if (waitingJobId) {
      const waitingJob = await this.state.storage.get(`job:${waitingJobId}`);
      if (waitingJob?.status === "waiting") {
        waitingJob.status = "failed";
        waitingJob.error_code = "opponent_timeout";
        waitingJob.error = "Opponent submission deadline passed";
        waitingJob.completed_at = new Date().toISOString();
        await this.state.storage.put(`job:${waitingJobId}`, waitingJob);
      }
    }
    const existing = await this.state.storage.get(key);
    if (existing && existing >= dueAt) return;
    await this.state.storage.put(key, dueAt);
    const currentAlarm = await this.state.storage.getAlarm();
    if (currentAlarm === null || dueAt < currentAlarm) await this.state.storage.setAlarm(dueAt);
  }

  async processDueRoundAdvances() {
    const now = Date.now();
    const entries = await this.state.storage.list({ prefix: "advance:" });
    for (const [key, dueAt] of entries) {
      if (dueAt > now) continue;
      const matchId = Number(key.slice("advance:".length));
      try {
        await supabaseServiceRpc(this.env, "proxy_advance_match_round", { p_match_id: matchId });
        await this.state.storage.delete(key);
      } catch (error) {
        console.log(`swiss_round_advance_failed:${matchId}:${String(error).slice(0, 200)}`);
        await this.state.storage.put(key, now + 30_000);
      }
    }
  }

  async scheduleNextTournamentWake(nextWaitingAlarm, dispatchActive) {
    const entries = await this.state.storage.list({ prefix: "advance:" });
    let nextDue = nextWaitingAlarm;
    for (const dueAt of entries.values()) {
      nextDue = nextDue === null ? dueAt : Math.min(nextDue, dueAt);
    }
    if (nextDue === null) return;
    const currentAlarm = await this.state.storage.getAlarm();
    if (dispatchActive && currentAlarm !== null && currentAlarm < nextDue) return;
    const alarmAt = Math.max(Date.now() + 1000, nextDue);
    if (currentAlarm === null || currentAlarm > alarmAt) await this.state.storage.setAlarm(alarmAt);
  }

  async notifyRoundAdvance(matchId) {
    const id = this.env.SCORING_QUEUE.idFromName("global");
    await this.env.SCORING_QUEUE.get(id).fetch("https://queue/schedule-advance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ match_id: matchId }),
    });
  }

  async recoverInterruptedJobs() {
    if (this.running.size) return;
    const entries = await this.state.storage.list({ prefix: "job:" });
    const queue = await this.state.storage.get("queue") || [];
    let changed = false;
    for (const [key, job] of entries) {
      if (job.status !== "running") continue;
      job.status = "queued";
      job.started_at = null;
      await this.state.storage.put(key, job);
      if (!queue.includes(job.job_id)) queue.push(job.job_id);
      changed = true;
    }
    if (changed) await this.state.storage.put("queue", queue);
  }

  async finishMatchWithScoringException(job, errorCode, message) {
    const completion = await supabaseServiceRpc(this.env, "proxy_fail_match", {
      p_match_id: job.match_id,
      p_error_code: errorCode,
      p_error_message: String(message || "scoring did not complete").slice(0, 500),
    });
    if (completion?.finalized) await this.scheduleRoundAdvance(job.match_id);
    else await this.state.storage.delete(`match:${job.match_id}`);
    job.status = "failed";
    job.error_code = errorCode;
    job.error = String(message || "Scoring did not complete").slice(0, 500);
    job.completed_at = new Date().toISOString();
    await this.state.storage.put(`job:${job.job_id}`, job);
  }

  async dispatch() {
    const queue = await this.state.storage.get("queue") || [];
    if (!queue.length) return;
    if (this.running.size >= UPSTREAM_CONCURRENCY) {
      await this.state.storage.setAlarm(Date.now() + UPSTREAM_INTERVAL_MS);
      return;
    }

    const lastDispatch = await this.state.storage.get("last_dispatch_at") || 0;
    const wait = UPSTREAM_INTERVAL_MS - (Date.now() - lastDispatch);
    if (wait > 0) {
      await this.state.storage.setAlarm(Date.now() + wait);
      return;
    }

    const jobs = [];
    let nextRetryAt = null;
    const scanLimit = queue.length;
    let scanned = 0;
    const availableSlots = UPSTREAM_CONCURRENCY - this.running.size;
    while (queue.length && jobs.length < availableSlots && scanned < scanLimit) {
      const jobId = queue.shift();
      scanned += 1;
      const job = await this.state.storage.get(`job:${jobId}`);
      if (!job || job.status !== "queued") continue;
      if (job.match_id && job.match_scoring_deadline && Date.now() >= job.match_scoring_deadline) {
        await this.finishMatchWithScoringException(
          job, "scoring_timeout", "No scoring result within eight minutes after processing began",
        );
        continue;
      }
      if (job.retry_at && job.retry_at > Date.now()) {
        nextRetryAt = nextRetryAt === null
          ? job.retry_at
          : Math.min(nextRetryAt, job.retry_at);
        queue.push(jobId);
        continue;
      }
      job.status = "running";
      if (job.match_id && !job.match_scoring_deadline) {
        job.match_scoring_deadline = Date.now() + MATCH_SCORING_MAX_MS;
      }
      job.started_at = new Date().toISOString();
      job.retry_at = null;
      job.attempts += 1;
      await this.state.storage.put(`job:${jobId}`, job);
      this.running.add(jobId);
      jobs.push(job);
    }
    await this.state.storage.put("queue", queue);
    if (!jobs.length) {
      if (nextRetryAt !== null) await this.state.storage.setAlarm(nextRetryAt);
      await this.state.storage.put("queue", queue);
      return;
    }
    await this.state.storage.put("last_dispatch_at", Date.now());
    await this.state.storage.setAlarm(Date.now() + UPSTREAM_INTERVAL_MS);
    await Promise.all(jobs.map((job) => this.execute(job)));
    const remaining = await this.state.storage.get("queue") || [];
    if (remaining.length) await this.state.storage.setAlarm(Date.now());
  }

  async execute(job) {
    try {
      const upstream = await fetch(ONLINECOMPILER_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          Authorization: this.env.ONLINECOMPILER_API_KEY,
          "User-Agent": "Mozilla/5.0 (compatible; OTT-Scoring-Proxy/1.0)",
        },
        body: JSON.stringify({
          compiler: "python-3.14",
          code: runnerSource(job.contestant_code, job.benchmark_code),
          input: "",
        }),
        signal: AbortSignal.timeout(UPSTREAM_REQUEST_TIMEOUT_MS),
      });
      const responseText = await upstream.text();
      let payload;
      try {
        payload = JSON.parse(responseText);
      } catch {
        payload = { raw_response: responseText.slice(0, 1000) };
      }
      if (!upstream.ok) {
        const retryAfter = Number(upstream.headers.get("retry-after"));
        const detail = payload.error || payload.detail || payload.message ||
          payload.raw_response || "no response body";
        const error = new Error(
          `upstream_http_${upstream.status}:${String(detail).slice(0, 300)}`,
        );
        error.retryAfterSeconds = Number.isFinite(retryAfter) ? retryAfter : null;
        throw error;
      }
      const result = parseCompilerResult(payload);
      if (job.match_id) {
        const completion = await supabaseServiceRpc(this.env, "proxy_complete_match", {
          p_match_id: job.match_id,
          p_score_a: result.match_score,
          p_scoring_user_id: job.scoring_user_id || job.user_id,
        });
        if (completion?.finalized) await this.scheduleRoundAdvance(job.match_id);
        else await this.state.storage.delete(`match:${job.match_id}`);
      }
      await this.finish(job, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "upstream_error";
      console.log(JSON.stringify({
        event: "upstream_error",
        job_id: job.job_id,
        attempt: job.attempts,
        message,
        retry_after_seconds: error instanceof Error ? error.retryAfterSeconds ?? null : null,
      }));
      const current = await this.state.storage.get(`job:${job.job_id}`);
      if (!current) return;
      const retryable = /upstream_http_(429|500|502|503|504)|fetch|abort|timeout/i.test(message);
      const retryLimit = job.match_id ? MATCH_MAX_RETRIES : MAX_RETRIES;
      const upstreamRetrySeconds = error instanceof Error && error.retryAfterSeconds !== null &&
        error.retryAfterSeconds !== undefined
        ? Math.max(5, error.retryAfterSeconds)
        : message.startsWith("upstream_http_429") ? 30 : UPSTREAM_INTERVAL_MS / 1000;
      const retrySeconds = job.match_id ? Math.min(60, upstreamRetrySeconds) : upstreamRetrySeconds;
      const retryWithinDeadline = !job.match_id || !job.match_scoring_deadline ||
        Date.now() + retrySeconds * 1000 < job.match_scoring_deadline;
      if (retryable && job.attempts <= retryLimit && retryWithinDeadline) {
        job.status = "queued";
        job.error = message;
        job.error_code = "retry_scheduled";
        job.retry_at = Date.now() + retrySeconds * 1000;
        const queue = await this.state.storage.get("queue") || [];
        queue.push(job.job_id);
        await this.state.storage.put(`job:${job.job_id}`, job);
        await this.state.storage.put("queue", queue);
        await this.state.storage.setAlarm(job.retry_at);
      } else {
        if (job.match_id) {
          await this.finishMatchWithScoringException(
            job,
            retryable ? "onlinecompiler_timeout" : "onlinecompiler_error",
            message,
          );
        }
        job.status = "failed";
        job.error_code = retryable ? "upstream_retry_exhausted" : "upstream_rejected";
        job.error = message.slice(0, 500);
        job.completed_at = new Date().toISOString();
        await this.state.storage.put(`job:${job.job_id}`, job);
      }
    } finally {
      this.running.delete(job.job_id);
    }
  }

  async finish(job, result) {
    const current = await this.state.storage.get(`job:${job.job_id}`);
    if (!current || current.status !== "running") return;
    job.status = "succeeded";
    job.result = result;
    job.completed_at = new Date().toISOString();
    await this.state.storage.put(`job:${job.job_id}`, job);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/health") {
      return jsonResponse({ ok: true, service: "ott-cloudflare-proxy" });
    }
    if (
      url.pathname.startsWith("/v1/score") &&
      !supabaseAuthConfigured(env)
    ) {
      return jsonResponse({ detail: "Worker Supabase authentication is not configured" }, 503);
    }
    if (request.method === "GET" && url.pathname.startsWith("/v1/score/")) {
      const user = await authenticate(request, env);
      if (!user) return jsonResponse({ detail: "Supabase login required" }, 401);
      const id = env.SCORING_QUEUE.idFromName("global");
      return env.SCORING_QUEUE.get(id).fetch(`https://queue/jobs/${url.pathname.slice(10)}`, {
        headers: { "x-user-id": user.id },
      });
    }
    if ((request.method === "GET" || request.method === "DELETE") && url.pathname === "/v1/admin/queue") {
      const expected = env.QUEUE_ADMIN_TOKEN;
      const received = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      if (!expected || received !== expected) {
        return jsonResponse({ detail: "Admin token required" }, 401);
      }
      const id = env.SCORING_QUEUE.idFromName("global");
      return env.SCORING_QUEUE.get(id).fetch(`https://queue/admin/queue`, {
        method: request.method,
      });
    }
    if (request.method !== "POST" || url.pathname !== "/v1/score") {
      return jsonResponse({ detail: "Not found" }, 404);
    }

    try {
      const user = await authenticate(request, env);
      if (!user) return jsonResponse({ detail: "Supabase login required" }, 401);
      const contentLength = Number(request.headers.get("content-length") || 0);
      if (contentLength > MAX_REQUEST_BYTES) {
        return jsonResponse({ detail: "Request too large" }, 413);
      }

      const body = await request.json();
      const contestant = body?.contestant_code;
      const benchmark = body?.benchmark_code;
      const matchId = body?.match_id;
      if (typeof contestant !== "string" || (typeof benchmark !== "string" && !Number.isInteger(matchId))) {
        return jsonResponse({ detail: "contestant_code and either benchmark_code or match_id are required" }, 400);
      }
      if (!contestant.trim() || (typeof benchmark === "string" && !benchmark.trim())) {
        return jsonResponse({ detail: "Source code must not be empty" }, 400);
      }
      if (new TextEncoder().encode(contestant).byteLength > MAX_SOURCE_BYTES ||
          (typeof benchmark === "string" && new TextEncoder().encode(benchmark).byteLength > MAX_SOURCE_BYTES)) {
        return jsonResponse({ detail: "Each source file is limited to 64 KiB" }, 413);
      }
      if (!env.ONLINECOMPILER_API_KEY) {
        return jsonResponse({ detail: "ONLINECOMPILER_API_KEY is not configured" }, 503);
      }

      let opponentCode = benchmark;
      let opponentUserId = null;
      const requestedJobId = typeof body?.job_id === "string" && body.job_id.trim()
        ? body.job_id.trim()
        : null;
      if (Number.isInteger(matchId)) {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(contestant));
        const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        const match = await supabaseRpc(env, user.token, "proxy_prepare_match", {
          p_match_id: matchId, p_source: contestant, p_sha256: sha256,
        });
        if (match?.expired) {
          const queue = env.SCORING_QUEUE.idFromName("global");
          await env.SCORING_QUEUE.get(queue).fetch("https://queue/schedule-advance", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ match_id: matchId }),
          });
          return jsonResponse({ detail: "Hết thời gian nộp cho trận này; hệ thống đã chốt kết quả." }, 409);
        }
        if (match?.cooldown) {
          return jsonResponse({ detail: "Lượt BO2 kế tiếp chưa mở; thời gian nghỉ giữa hai lượt là 1 phút." }, 409);
        }
        opponentUserId = match?.opponent_id || null;
        if (!match?.ready) {
          const queue = env.SCORING_QUEUE.idFromName("global");
          return env.SCORING_QUEUE.get(queue).fetch("https://queue/enqueue-waiting", {
            method: "POST",
            headers: { "content-type": "application/json", "x-user-id": user.id },
            body: JSON.stringify({
              job_id: requestedJobId || crypto.randomUUID(), user_id: user.id, match_id: matchId,
              opponent_id: match?.opponent_id,
              auth_token: user.token, contestant_code: contestant, sha256,
            }),
          });
        }
        opponentCode = match.opponent_code;
      }

      const id = env.SCORING_QUEUE.idFromName("global");
      const queueResponse = await env.SCORING_QUEUE.get(id).fetch("https://queue/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          job_id: requestedJobId,
          contestant_code: contestant,
          benchmark_code: opponentCode,
          user_id: user.id,
          opponent_id: opponentUserId,
          auth_token: user.token,
          match_id: matchId ?? null,
        }),
      });
      return queueResponse;
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError) {
        return jsonResponse({ detail: String(error.message || error).slice(0, 500) }, 400);
      }
      return jsonResponse({ detail: "OnlineCompiler request failed" }, 502);
    }
  },
};

export { ScoringQueue };
