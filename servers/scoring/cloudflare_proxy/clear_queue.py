#!/usr/bin/env python3
"""Inspect or clear the Cloudflare Durable Object scoring queue."""

from __future__ import annotations

import argparse
import getpass
import json
import os
import urllib.request
from urllib.error import HTTPError, URLError


def main() -> int:
    parser = argparse.ArgumentParser(description="Manage the scoring queue")
    parser.add_argument("--url", default=os.environ.get(
        "PROXY_URL", "https://uetrps-scoring-proxy.huylekq11.workers.dev",
    ))
    parser.add_argument("--token", default=os.environ.get("QUEUE_ADMIN_TOKEN"))
    parser.add_argument(
        "--user-agent",
        default="Mozilla/5.0 (compatible; OTT-Queue-Admin/1.0)",
        help="HTTP User-Agent used to pass the Worker edge filter",
    )
    parser.add_argument("--clear", action="store_true", help="Delete queued/running job records")
    args = parser.parse_args()
    token = args.token or getpass.getpass("Queue admin token: ")
    method = "DELETE" if args.clear else "GET"
    request = urllib.request.Request(
        f"{args.url.rstrip('/')}/v1/admin/queue",
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/json",
            "User-Agent": args.user_agent,
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            print(json.dumps(json.loads(response.read()), indent=2))
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        print(f"ERROR: HTTP {error.code}: {detail[:1000]}", flush=True)
        return 1
    except URLError as error:
        print(f"ERROR: {error}", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
