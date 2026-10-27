#!/usr/bin/env python3
"""Run a real OTT BO2 match directly through the OneCompiler API.

The script does not use Cloudflare Worker. Provide the API key with
--api-key, ONLINECOMPILER_API_KEY, or an interactive hidden prompt.
"""

from __future__ import annotations

import argparse
import getpass
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_ENDPOINT = "https://api.onlinecompiler.io/api/run-code-sync/"
DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; OTT-Scoring-API-Test/1.0)"
MAX_SOURCE_BYTES = 65536

# Reuse the repository's existing OTT harness so this direct API test follows
# the same BO2 rules as the current local scorer.
sys.path.insert(0, str(REPO_ROOT))
from servers.scoring.judge0_runner import _runner_source  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Test OneCompiler with two real OTT bots")
    parser.add_argument("--api-key", help="OneCompiler API key; omitted value is read from env or prompt")
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT, help=f"API endpoint (default: {DEFAULT_ENDPOINT})")
    parser.add_argument(
        "--user-agent",
        default=DEFAULT_USER_AGENT,
        help=f"HTTP User-Agent (default: {DEFAULT_USER_AGENT})",
    )
    parser.add_argument(
        "--contestant",
        type=Path,
        default=REPO_ROOT / "sample_bots" / "sample_bot.py",
        help="Contestant bot source path",
    )
    parser.add_argument(
        "--benchmark",
        type=Path,
        default=REPO_ROOT / "sample_bots" / "entry_bot0.py",
        help="Opponent bot source path",
    )
    return parser.parse_args()


def read_api_key(argument: str | None) -> str:
    if argument:
        return argument.strip()
    import os

    configured = os.environ.get("ONLINECOMPILER_API_KEY", "").strip()
    if configured:
        return configured
    return getpass.getpass("OnlineCompiler API key: ").strip()


def read_source(path: Path) -> str:
    source = path.read_text(encoding="utf-8")
    if not source.strip():
        raise ValueError(f"Source file is empty: {path}")
    if len(source.encode("utf-8")) > MAX_SOURCE_BYTES:
        raise ValueError(f"Source file exceeds 64 KiB: {path}")
    return source


def run(endpoint: str, api_key: str, user_agent: str, contestant: str, benchmark: str) -> dict:
    payload = {
        "compiler": "python-3.14",
        "code": _runner_source(
            contestant.encode("utf-8"), benchmark.encode("utf-8")
        ),
        "input": "",
    }
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": api_key,
            "User-Agent": user_agent,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            response_body = response.read()
            status = response.status
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OneCompiler HTTP {error.code}: {detail[:1000]}") from None
    except urllib.error.URLError as error:
        raise RuntimeError(f"Could not reach OneCompiler: {error.reason}") from None

    try:
        result = json.loads(response_body)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"OneCompiler returned invalid JSON (HTTP {status})") from error
    if not isinstance(result, dict):
        raise RuntimeError(f"OneCompiler returned an unexpected JSON shape: {result!r}")
    return result


def validate_result(response: dict) -> dict:
    stdout = response.get("output")
    if not isinstance(stdout, str):
        detail = response.get("error") or response.get("status") or response.get("exit_code")
        raise RuntimeError(f"OnlineCompiler returned no output{f': {detail}' if detail else ''}")
    result_line = next(
        (line[len("OTT_RESULT:"):] for line in reversed(stdout.splitlines())
         if line.startswith("OTT_RESULT:")),
        None,
    )
    error_line = next(
        (line[len("OTT_ERROR:"):] for line in stdout.splitlines()
         if line.startswith("OTT_ERROR:")),
        None,
    )
    if error_line:
        raise RuntimeError(f"Generated scorer failed: {error_line[:500]}")
    if not result_line:
        raise RuntimeError(f"Generated scorer did not return OTT_RESULT. stdout={stdout[:1000]!r}")
    try:
        result = json.loads(result_line)
    except json.JSONDecodeError as error:
        raise RuntimeError("OTT_RESULT was not valid JSON") from error
    score = result.get("match_score")
    games = result.get("games")
    if score not in (-2, -1, 0, 1, 2):
        raise RuntimeError(f"Invalid match_score: {score!r}")
    if not isinstance(games, list) or len(games) != 2:
        raise RuntimeError(f"Expected two BO2 games, got: {games!r}")
    return result


def main() -> int:
    args = parse_args()
    try:
        api_key = read_api_key(args.api_key)
        if not api_key:
            raise ValueError("API key must not be empty")
        result = validate_result(run(
            args.endpoint,
            api_key,
            args.user_agent,
            read_source(args.contestant),
            read_source(args.benchmark),
        ))
    except (OSError, ValueError, RuntimeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(json.dumps({
        "ok": True,
        "match_score": result["match_score"],
        "games": len(result["games"]),
        "compiler_status": "success",
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
