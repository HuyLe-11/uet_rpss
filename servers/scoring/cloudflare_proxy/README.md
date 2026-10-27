# Cloudflare scoring proxy

The web-facing scoring module authenticates contestants and keeps Supabase
tournament state. When `OTT_SCORING_PROXY_URL` and
`OTT_SCORING_PROXY_TOKEN` are configured on that module, every qualification,
practice, and official BO2 is executed by this Worker through OnlineCompiler.
The browser never receives the Worker service token or the OnlineCompiler key.

The JavaScript entrypoint is [`worker.js`](./worker.js).

## Deploy

Deploy the JavaScript Worker from this directory:

```sh
npx wrangler secret put ONLINECOMPILER_API_KEY
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler dev
npx wrangler deploy
```

The upstream API uses
`https://api.onlinecompiler.io/api/run-code-sync/` with the bare API key in
the `Authorization` header. The request uses `compiler: "python-3.14"` and
`code`; the synchronous response returns `output`.

The default `wrangler.toml` deploys `uetrps-scoring-proxy`. The public URL is:

```text
https://uetrps-scoring-proxy.huylekq11.workers.dev
```

For local development, create `.dev.vars` (do not commit it):

```text
ONLINECOMPILER_API_KEY=your-api-key
```

## Browser request contract

``POST /v1/score` with JSON:

```json
{"contestant_code": "...", "benchmark_code": "..."}
```

The request must include the contestant's `Authorization: Bearer <Supabase JWT>`.
Configure `SUPABASE_URL` and `SUPABASE_ANON_KEY` as Worker variables/secrets.
The Worker validates the JWT through Supabase before accepting a job. The
response is initially `202` with a `job_id`; the browser polls
`GET /v1/score/{job_id}` with the same JWT.

For an official match, send `match_id`; the Worker calls the
`proxy_prepare_match` RPC and waits for the other contestant's source for up
to 90 seconds. For a standalone practice request, send `benchmark_code`
instead. The Worker records the result through `proxy_complete_match`; the
official match UI polls Supabase rather than repeatedly polling this Worker.
After all matches in a Swiss round finish, the Worker schedules the next round
after a one-minute cooldown and asks Supabase to create its pairings.

Official match jobs are keyed by `match_id` inside the Durable Object. If both
contestants submit at nearly the same time, their requests share one queue job
and one OnlineCompiler execution; both contestants can poll that job.

Apply the Supabase migration `0018_proxy_match_opponent_id.sql` before
deploying this Worker version so the preparation RPC returns the opponent ID
needed for that shared-job authorization.

To run a real BO2 request using the repository's bots:

```sh
PROXY_URL=https://uetrps-scoring-proxy.huylekq11.workers.dev sh test_05_real_match.sh
```

The script loads `sample_bots/sample_bot.py` and
`sample_bots/entry_bot0.py`, sends them through the Worker, and validates the
returned score and two-game replay. It consumes one OnlineCompiler request.

To bypass Cloudflare and test OnlineCompiler directly:

```sh
python3 test_onlinecompiler.py --api-key 'YOUR_API_KEY'
```

The script can also read `ONLINECOMPILER_API_KEY` from the environment, or
prompt for it without echoing:

```sh
export ONLINECOMPILER_API_KEY='YOUR_API_KEY'
python3 test_onlinecompiler.py
```

It uses `sample_bots/sample_bot.py` versus
`sample_bots/entry_bot0.py` by default and sends one real API request.

The direct script sends a browser-compatible User-Agent instead of
Python's default `Python-urllib/...`, which some Cloudflare configurations
block. You can override it with `--user-agent` if OneCompiler requires a
different client signature.

If the upstream response is not an execution result, the Worker returns HTTP
`502` with the upstream `status`, `error`, `stderr`, or `exception` summary.

## Load testing

The legacy direct load test is useful only for measuring the old synchronous
endpoint shape. For the deployed queue, use `queue_load_test.py` below.

```sh
python3 load_test.py --requests 5 --concurrency 2 --output results-5.json
python3 report_load_test.py results-5.json --output report-5.html
```

The report includes throughput, success/failure counts, HTTP statuses, mean,
p95, p99 and max latency, plus client-side queue-time metrics and SVG charts.

## Durable Object queue

`POST /v1/score` now returns `202` with a `job_id`; poll
`GET /v1/score/{job_id}` for the result. The Durable Object stores up to 200
jobs, allows at most two OnlineCompiler executions, and starts at most one new
batch of up to two submissions every 4.2 seconds to stay below the Free-plan
limit of 30 submissions per minute. This uses both execution slots while
keeping the submission rate at about 28.6 per minute.

After changing `wrangler.toml`, deploy the Worker so Cloudflare applies the
Durable Object migration:

```sh
npx wrangler deploy
```

Run a queue-aware 200-submission test:

```sh
python3 queue_load_test.py \
  --url https://uetrps-scoring-proxy.huylekq11.workers.dev \
  --requests 200 \
  --submit-concurrency 200 \
  --output queue-results-200.json
python3 report_queue_load_test.py \
  queue-results-200.json \
  --output queue-report-200.html
```

This takes several minutes on the Free plan because the account limit is 30
submissions per minute. It measures submit latency, queue wait, completion
time, throughput, and timeout/failure counts. The HTML report contains the
summary table and a CSV link with each job's timestamps and error.

The client uses one persistent `tqdm` progress bar for completed jobs, has a
1800-second overall timeout, and stops after 90 polling rounds with no
terminal job by default. These guards prevent a broken deployment or missing
job from creating an unbounded client loop.

By default, the load test models a burst: all simulated contestants submit at
once, subject to `--submit-concurrency`. To model contestants arriving one
after another, add for example:

```sh
python3 queue_load_test.py --requests 50 --submit-concurrency 50 \
  --submit-interval 0.5
```

This schedules contestant `i` at approximately `i * 0.5` seconds after the
start. Polling remains parallel for all accepted jobs.

Each queue load test also writes a timestamped JSONL event log under `log/` by
default. Use `--log-file` to choose another path. The Worker logs upstream
HTTP status and response details; an upstream `429` means OnlineCompiler
received the request but rejected it for rate, concurrency, or quota limits.

The queue test displays submit/poll progress with `tqdm` when installed:

```sh
python3 -m pip install tqdm
```

### Clear a queue after Ctrl-C

Ctrl-C stops only the client; already accepted jobs remain in the Durable
Object. Configure a separate admin secret and deploy:

```sh
npx wrangler secret put QUEUE_ADMIN_TOKEN
npx wrangler deploy
```

Inspect the queue:

```sh
python3 clear_queue.py
```

Clear queued and running job records:

```sh
python3 clear_queue.py --clear
```

The clear operation prevents running jobs from being recorded after the
clear, but an upstream request already in flight may still finish at
OnlineCompiler. Do not expose or reuse the admin token in client code.

The queue admin script sends a browser-compatible User-Agent because the
Cloudflare edge may reject Python's default `Python-urllib/...` signature. If
the edge still returns Error 1010, try:

```sh
python3 clear_queue.py --clear --user-agent 'Mozilla/5.0'
```
