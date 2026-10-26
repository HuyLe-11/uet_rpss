#!/usr/bin/env python3
"""Create an HTML/CSV report for queue_load_test.py."""

from __future__ import annotations

import argparse
import csv
import html
import json
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Report Durable Object queue load results")
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path, default=Path("queue-load-report.html"))
    args = parser.parse_args()
    document = json.loads(args.input.read_text(encoding="utf-8"))
    summary = document["summary"]
    jobs = document["jobs"]
    csv_path = args.output.with_suffix(".csv")
    with csv_path.open("w", newline="", encoding="utf-8") as stream:
        fields = ["index", "job_id", "http_status", "state", "submit_latency_ms",
                  "started_at", "completed_at", "error"]
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for job in jobs:
            writer.writerow({
                "index": job.get("index"),
                "job_id": job.get("job_id"),
                "http_status": job.get("http_status"),
                "state": job.get("state"),
                "submit_latency_ms": job.get("submit_latency_ms"),
                "started_at": job.get("started_at"),
                "completed_at": job.get("completed_at"),
                "error": job.get("error"),
            })

    def value(key: str) -> str:
        metric = summary.get(key)
        if not isinstance(metric, dict):
            return html.escape(str(metric))
        return "mean {mean:.2f} ms · p95 {p95:.2f} ms · p99 {p99:.2f} ms · max {max:.2f} ms".format(
            mean=metric.get("mean") or 0,
            p95=metric.get("p95") or 0,
            p99=metric.get("p99") or 0,
            max=metric.get("max") or 0,
        )

    rows = "".join(
        f"<tr><td>{html.escape(label)}</td><td>{value(key)}</td></tr>"
        for label, key in [
            ("Requested", "requested"), ("Accepted", "accepted"),
            ("Succeeded", "succeeded"), ("Failed", "failed"),
            ("Timed out", "timed_out"), ("Wall time (s)", "wall_time_seconds"),
            ("Throughput (completed/s)", "throughput_completed_per_second"),
            ("Submit latency", "submit_latency_ms"),
            ("Queue wait", "queue_wait_ms"),
            ("Completion time", "completion_time_ms"),
        ]
    )
    report = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>OTT queue load test</title>
<style>body{{font:15px system-ui;max-width:900px;margin:2rem auto}}table{{border-collapse:collapse}}
td{{border:1px solid #ccc;padding:.5rem 1rem}}.note{{background:#fff7d6;padding:1rem}}</style>
</head><body><h1>OTT Durable Object queue load test</h1>
<p class="note">The queue wait is measured from the accepted POST until the
job reports <code>started_at</code>. Upstream concurrency is controlled by the
Durable Object, not by this client.</p>
<table>{rows}</table>
<p>Per-job data: <a href="{html.escape(csv_path.name)}">{html.escape(csv_path.name)}</a></p>
</body></html>"""
    args.output.write_text(report, encoding="utf-8")
    print(f"Saved HTML report to {args.output}")
    print(f"Saved CSV report to {csv_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
