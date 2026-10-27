#!/usr/bin/env python3
"""Concurrent Cloudflare scoring proxy load test.

This test does not use Supabase. Each request represents one independent BO2
match and sends the two real repository bots to the configured Worker URL.
The test can consume one upstream compiler execution per request.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_URL = "https://uetrps-scoring-proxy.huylekq11.workers.dev/v1/score"
MAX_SOURCE_BYTES = 65536


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Load-test the Cloudflare scoring proxy")
    parser.add_argument("--url", default=os.environ.get("PROXY_URL", DEFAULT_URL))
    parser.add_argument("--requests", type=int, default=200)
    parser.add_argument("--concurrency", type=int, default=200)
    parser.add_argument("--timeout", type=float, default=180.0)
    parser.add_argument("--output", type=Path, default=Path("load-test-results.json"))
    parser.add_argument("--contestant", type=Path, default=REPO_ROOT / "sample_bots" / "sample_bot.py")
    parser.add_argument("--benchmark", type=Path, default=REPO_ROOT / "sample_bots" / "entry_bot0.py")
    return parser.parse_args()


def read_source(path: Path) -> str:
    source = path.read_text(encoding="utf-8")
    if not source.strip():
        raise ValueError(f"Source file is empty: {path}")
    if len(source.encode("utf-8")) > MAX_SOURCE_BYTES:
        raise ValueError(f"Source exceeds 64 KiB: {path}")
    return source


def percentile(values: list[float], percentile_value: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    rank = (len(ordered) - 1) * percentile_value / 100
    lower = int(rank)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (rank - lower)


def metric_summary(values: list[float]) -> dict[str, float | None]:
    if not values:
        return {}
    return {
        "mean": sum(values) / len(values),
        "p50": percentile(values, 50),
        "p95": percentile(values, 95),
        "p99": percentile(values, 99),
        "max": max(values),
    }


def run_one(
    index: int,
    queued_at: float,
    start_barrier: threading.Barrier,
    url: str,
    payload: bytes,
    timeout: float,
) -> dict:
    try:
        start_barrier.wait()
    except threading.BrokenBarrierError:
        pass
    request_started = time.perf_counter()
    request = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "OTT-Scoring-Load-Test/1.0",
            "X-Load-Test-Request": str(index),
        },
        method="POST",
    )
    status = None
    body = ""
    error = None
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = response.status
            body = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        status = exc.code
        body = exc.read().decode("utf-8", errors="replace")
        error = f"HTTP {exc.code}"
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        error = f"{type(exc).__name__}: {exc}"
    completed_at = time.perf_counter()
    parsed = None
    try:
        parsed = json.loads(body) if body else None
    except json.JSONDecodeError:
        error = error or "invalid_json"

    return {
        "request_id": str(uuid.uuid4()),
        "index": index,
        "status": status,
        "success": status == 200 and isinstance(parsed, dict) and parsed.get("ok") is True,
        "match_score": parsed.get("match_score") if isinstance(parsed, dict) else None,
        "queue_time_ms": (request_started - queued_at) * 1000,
        "latency_ms": (completed_at - request_started) * 1000,
        "total_time_ms": (completed_at - queued_at) * 1000,
        "started_at": request_started,
        "completed_at": completed_at,
        "error": error or (parsed.get("detail") if isinstance(parsed, dict) else None),
        "response_bytes": len(body.encode("utf-8")),
    }


def main() -> int:
    args = parse_args()
    if args.requests < 1 or args.concurrency < 1:
        raise SystemExit("--requests and --concurrency must be positive")
    concurrency = min(args.concurrency, args.requests)
    url = args.url.rstrip("/")
    contestant = read_source(args.contestant)
    benchmark = read_source(args.benchmark)
    payload = json.dumps({
        "contestant_code": contestant,
        "benchmark_code": benchmark,
    }).encode("utf-8")

    print(f"Starting {args.requests} requests with concurrency {concurrency}")
    print(f"Endpoint: {url}")
    wall_started = time.perf_counter()
    barrier = threading.Barrier(concurrency)
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = []
        for index in range(args.requests):
            futures.append(executor.submit(
                run_one,
                index,
                time.perf_counter(),
                barrier,
                url,
                payload,
                args.timeout,
            ))
        results = [future.result() for future in futures]
    wall_seconds = time.perf_counter() - wall_started

    latency = [item["latency_ms"] for item in results]
    queue_time = [item["queue_time_ms"] for item in results]
    total_time = [item["total_time_ms"] for item in results]
    summary = {
        "requests": args.requests,
        "concurrency": concurrency,
        "wall_time_seconds": wall_seconds,
        "throughput_completed_per_second": len(results) / wall_seconds if wall_seconds else None,
        "successes": sum(1 for item in results if item["success"]),
        "failures": sum(1 for item in results if not item["success"]),
        "status_counts": {
            str(status): sum(1 for item in results if item["status"] == status)
            for status in sorted({item["status"] for item in results}, key=str)
        },
        "latency_ms": metric_summary(latency),
        "client_queue_time_ms": metric_summary(queue_time),
        "total_time_ms": metric_summary(total_time),
    }
    document = {
        "schema_version": 1,
        "config": {
            "url": url,
            "requests": args.requests,
            "concurrency": concurrency,
            "timeout_seconds": args.timeout,
            "contestant": str(args.contestant),
            "benchmark": str(args.benchmark),
        },
        "summary": summary,
        "results": results,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(document, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    print(f"Saved results to {args.output}")
    return 0 if summary["failures"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
