#!/usr/bin/env python3
"""Burst-submit jobs to the Durable Object queue and poll them to completion."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT_DIR = Path(__file__).resolve().parent
LOG_DIR = SCRIPT_DIR / "log"
DEFAULT_URL = "https://uetrps-scoring-proxy.huylekq11.workers.dev"

class NullProgress:
    def __init__(self, *_args, **_kwargs):
        pass

    def update(self, *_args, **_kwargs):
        pass

    def set_description(self, *_args, **_kwargs):
        pass

    def close(self):
        pass

try:
    from tqdm import tqdm
except ImportError:
    tqdm = NullProgress


def parse_args():
    parser = argparse.ArgumentParser(description="Load-test the queued scoring Worker")
    parser.add_argument("--url", default=os.environ.get("PROXY_URL", DEFAULT_URL))
    parser.add_argument("--requests", type=int, default=200)
    parser.add_argument("--submit-concurrency", type=int, default=200)
    parser.add_argument(
        "--submit-interval",
        type=float,
        default=0,
        help="Delay between simulated contestant arrivals in seconds (default: burst)",
    )
    parser.add_argument("--poll-interval", type=float, default=2.0)
    parser.add_argument("--timeout", type=float, default=1800.0)
    parser.add_argument(
        "--max-idle-polls",
        type=int,
        default=90,
        help="Stop polling after this many rounds with no terminal job (default: 90)",
    )
    parser.add_argument("--output", type=Path, default=Path("queue-load-results.json"))
    parser.add_argument(
        "--log-file",
        type=Path,
        help="JSONL event log; defaults to log/queue-load-YYYYMMDD-HHMMSS.jsonl",
    )
    return parser.parse_args()


def source(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def request(url: str, payload: bytes | None = None, timeout: float = 30) -> tuple[int, dict]:
    method = "POST" if payload is not None else "GET"
    headers = {"Accept": "application/json", "User-Agent": "OTT-Queue-Load-Test/1.0"}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            parsed = {"detail": body[:500]}
        return error.code, parsed
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        return 0, {"detail": f"{type(error).__name__}: {error}"}


def iso_seconds(value: str | None) -> float | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def percentile(values: list[float], value: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * value / 100
    low = int(position)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def metrics(values: list[float]) -> dict:
    return {
        "mean": sum(values) / len(values) if values else None,
        "p95": percentile(values, 95),
        "p99": percentile(values, 99),
        "max": max(values) if values else None,
    }


def main() -> int:
    args = parse_args()
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_file = args.log_file or LOG_DIR / (
        f"queue-load-{datetime.now().strftime('%Y%m%d-%H%M%S')}.jsonl"
    )
    log_file.parent.mkdir(parents=True, exist_ok=True)
    log_lock = threading.Lock()

    def log_event(event: str, **fields):
        record = {
            "timestamp": datetime.now().isoformat(timespec="milliseconds"),
            "event": event,
            **fields,
        }
        with log_lock:
            with log_file.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(record, ensure_ascii=False) + "\n")

    base = args.url.rstrip("/")
    payload = json.dumps({
        "contestant_code": source(REPO_ROOT / "sample_bots" / "sample_bot.py"),
        "benchmark_code": source(REPO_ROOT / "sample_bots" / "entry_bot0.py"),
    }).encode()
    started = time.time()

    def submit(index: int) -> dict:
        if args.submit_interval > 0:
            time.sleep(index * args.submit_interval)
        sent = time.time()
        status, body = request(f"{base}/v1/score", payload)
        accepted = time.time()
        log_event(
            "submit",
            index=index,
            http_status=status,
            job_id=body.get("job_id"),
            latency_ms=(accepted - sent) * 1000,
            error=body.get("detail") if status != 202 else None,
        )
        return {
            "index": index,
            "request_id": str(uuid.uuid4()),
            "http_status": status,
            "job_id": body.get("job_id"),
            "submit_latency_ms": (accepted - sent) * 1000,
            "submitted_at": accepted,
            "error": body.get("detail") if status != 202 else None,
        }

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(args.submit_concurrency, args.requests)) as pool:
        jobs = list(tqdm(
            pool.map(submit, range(args.requests)),
            total=args.requests,
            desc="submit",
            unit="job",
        ))
    pending = {item["job_id"]: item for item in jobs if item["job_id"]}
    print(f"Submitted {len(jobs)} jobs; accepted {len(pending)}")

    deadline = time.time() + args.timeout
    idle_polls = 0
    progress = tqdm(total=len(pending), desc="complete", unit="job")
    while pending and time.time() < deadline:
        def poll(item):
            status, body = request(f"{base}/v1/score/{item['job_id']}")
            item["last_status"] = status
            item["state"] = body.get("status")
            log_event(
                "poll",
                job_id=item["job_id"],
                http_status=status,
                state=body.get("status"),
                error=body.get("detail"),
            )
            if body.get("started_at") and not item.get("started_at"):
                item["started_at"] = body["started_at"]
            if body.get("completed_at"):
                item["completed_at"] = body["completed_at"]
            if body.get("status") in ("succeeded", "failed"):
                item["result"] = body
                log_event(
                    "terminal",
                    job_id=item["job_id"],
                    state=body.get("status"),
                    error=body.get("error"),
                    error_code=body.get("error_code"),
                )
                return item["job_id"]
            if status not in (200, 202) or body.get("status") not in ("queued", "running"):
                item["state"] = "poll_error"
                item["error"] = body.get("detail") or f"unexpected_poll_response_http_{status}"
                return item["job_id"]
            return None

        with concurrent.futures.ThreadPoolExecutor(max_workers=min(32, len(pending))) as pool:
            polled = list(pool.map(poll, list(pending.values())))
            finished = [job_id for job_id in polled if job_id]
        for job_id in finished:
            pending.pop(job_id, None)
        if finished:
            progress.update(len(finished))
            idle_polls = 0
        else:
            idle_polls += 1
        if pending and idle_polls >= args.max_idle_polls:
            print(
                f"Stopping after {idle_polls} idle polls; "
                f"{len(pending)} jobs remain in the queue.",
                file=sys.stderr,
            )
            break
        if pending:
            progress.set_description(f"complete ({len(pending)} pending)")
            time.sleep(args.poll_interval)
    progress.close()

    for item in pending.values():
        item["state"] = "client_timeout"
    completed = [item for item in jobs if item.get("completed_at")]
    queue_wait = [
        (iso_seconds(item["started_at"]) - item["submitted_at"]) * 1000
        for item in completed if item.get("started_at")
    ]
    completion = [
        (iso_seconds(item["completed_at"]) - item["submitted_at"]) * 1000
        for item in completed
    ]
    summary = {
        "requested": args.requests,
        "accepted": len([item for item in jobs if item["job_id"]]),
        "succeeded": sum(item.get("state") == "succeeded" for item in jobs),
        "failed": sum(item.get("state") in ("failed", "poll_error") for item in jobs),
        "timed_out": sum(item.get("state") == "client_timeout" for item in jobs),
        "wall_time_seconds": time.time() - started,
        "submit_latency_ms": metrics([item["submit_latency_ms"] for item in jobs]),
        "queue_wait_ms": metrics(queue_wait),
        "completion_time_ms": metrics(completion),
        "throughput_completed_per_second": len(completed) / max(time.time() - started, 0.001),
    }
    args.output.write_text(json.dumps({"summary": summary, "jobs": jobs}, indent=2), encoding="utf-8")
    log_event("summary", **summary)
    print(json.dumps(summary, indent=2))
    print(f"Saved results to {args.output}")
    print(f"Saved event log to {log_file}")
    return 0 if not pending and summary["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
