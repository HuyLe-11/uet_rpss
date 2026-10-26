#!/usr/bin/env python3
"""Generate an HTML/CSV performance report from load_test.py output."""

from __future__ import annotations

import argparse
import csv
import html
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a load-test report")
    parser.add_argument("input", type=Path, help="JSON file produced by load_test.py")
    parser.add_argument("--output", type=Path, default=Path("load-test-report.html"))
    return parser.parse_args()


def number(value: object, digits: int = 2) -> str:
    return "—" if value is None else f"{float(value):.{digits}f}"


def svg_bar_chart(title: str, values: list[float], color: str) -> str:
    width, height = 720, 260
    if not values:
        return f"<h3>{html.escape(title)}</h3><p>No data</p>"
    maximum = max(values) or 1
    bins = 20
    counts = [0] * bins
    for value in values:
        counts[min(int(value / maximum * bins), bins - 1)] += 1
    bar_width = (width - 80) / bins
    bars = []
    for index, count in enumerate(counts):
        bar_height = (count / max(counts) * 170) if max(counts) else 0
        x = 50 + index * bar_width
        y = 205 - bar_height
        bars.append(
            f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar_width - 3:.1f}" '
            f'height="{bar_height:.1f}" fill="{color}"><title>{count} requests</title></rect>'
        )
    return (
        f"<h3>{html.escape(title)}</h3><svg viewBox='0 0 {width} {height}' "
        f"role='img' aria-label='{html.escape(title)}'>"
        + "".join(bars)
        + f"<line x1='50' y1='205' x2='{width - 20}' y2='205' stroke='#555'/>"
        f"<text x='50' y='235'>0 ms</text><text x='{width - 90}' y='235'>{number(maximum)} ms</text>"
        "</svg>"
    )


def main() -> int:
    args = parse_args()
    document = json.loads(args.input.read_text(encoding="utf-8"))
    summary = document["summary"]
    results = document["results"]
    output_csv = args.output.with_suffix(".csv")
    with output_csv.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=[
            "index", "request_id", "status", "success", "match_score",
            "queue_time_ms", "latency_ms", "total_time_ms", "error",
        ])
        writer.writeheader()
        writer.writerows({
            key: item.get(key) for key in writer.fieldnames
        } for item in results)

    latency = [item["latency_ms"] for item in results]
    queue_time = [item["queue_time_ms"] for item in results]
    table_rows = "".join(
        f"<tr><td>{html.escape(str(key))}</td><td>{html.escape(str(value))}</td></tr>"
        for key, value in [
            ("Requests", summary["requests"]),
            ("Concurrency", summary["concurrency"]),
            ("Successes", summary["successes"]),
            ("Failures", summary["failures"]),
            ("Throughput (completed/s)", number(summary["throughput_completed_per_second"])),
            ("Latency mean (ms)", number(summary["latency_ms"].get("mean"))),
            ("Latency p95 (ms)", number(summary["latency_ms"].get("p95"))),
            ("Latency p99 (ms)", number(summary["latency_ms"].get("p99"))),
            ("Client queue mean (ms)", number(summary["client_queue_time_ms"].get("mean"))),
            ("Client queue p95 (ms)", number(summary["client_queue_time_ms"].get("p95"))),
            ("Client queue p99 (ms)", number(summary["client_queue_time_ms"].get("p99"))),
        ]
    )
    status_rows = "".join(
        f"<tr><td>{html.escape(str(key))}</td><td>{value}</td></tr>"
        for key, value in summary["status_counts"].items()
    )
    report = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>OTT scoring load test</title>
<style>
body{{font:15px system-ui,sans-serif;max-width:1100px;margin:2rem auto;color:#222}}
table{{border-collapse:collapse;margin:1rem 0 2rem}}td,th{{border:1px solid #ccc;padding:.45rem .7rem;text-align:left}}
section{{display:inline-block;vertical-align:top;width:48%;min-width:340px}}svg{{width:100%;height:auto;background:#fafafa;border:1px solid #ddd}}
.note{{background:#fff7d6;padding:.8rem;border-left:4px solid #e1ad01}}
</style></head><body>
<h1>OTT scoring proxy load test</h1>
<p>Endpoint: <code>{html.escape(document["config"]["url"])}</code></p>
<p class="note"><b>Queue time definition:</b> client-side wait from task submission
until the worker thread starts the HTTP request. Server-side queue time is not
observable through the current synchronous API.</p>
<h2>Summary</h2><table><tbody>{table_rows}</tbody></table>
<h2>HTTP status counts</h2><table><tbody>{status_rows}</tbody></table>
<section>{svg_bar_chart("Request latency distribution", latency, "#3478c8")}</section>
<section>{svg_bar_chart("Client queue-time distribution", queue_time, "#e07b39")}</section>
<p>Raw per-request data: <a href="{html.escape(output_csv.name)}">{html.escape(output_csv.name)}</a></p>
</body></html>"""
    args.output.write_text(report, encoding="utf-8")
    print(f"Saved HTML report to {args.output}")
    print(f"Saved CSV report to {output_csv}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
