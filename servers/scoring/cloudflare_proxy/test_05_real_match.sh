#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
base_url="${PROXY_URL:-http://127.0.0.1:8787}"
base_url="${base_url%/}"
response_file=$(mktemp "${TMPDIR:-/tmp}/ott-proxy-real-match.XXXXXX")
payload_file=$(mktemp "${TMPDIR:-/tmp}/ott-proxy-real-match-payload.XXXXXX")
trap 'rm -f "$response_file" "$payload_file"' EXIT HUP INT TERM

CONTESTANT_FILE="$repo_root/sample_bots/sample_bot.py" \
BENCHMARK_FILE="$repo_root/sample_bots/entry_bot0.py" \
python3 - "$payload_file" <<'PY'
import json
import os
import sys
from pathlib import Path

contestant = Path(os.environ["CONTESTANT_FILE"]).read_text(encoding="utf-8")
benchmark = Path(os.environ["BENCHMARK_FILE"]).read_text(encoding="utf-8")
Path(sys.argv[1]).write_text(
    json.dumps({
        "contestant_code": contestant,
        "benchmark_code": benchmark,
    }),
    encoding="utf-8",
)
PY

status=$(
  curl --silent --show-error \
    --output "$response_file" \
    --write-out '%{http_code}' \
    -H 'content-type: application/json' \
    --data-binary "@$payload_file" \
    "$base_url/v1/score"
)

cat "$response_file"
printf '\nHTTP %s\n' "$status"
test "$status" = 202

job_id="$(python3 - "$response_file" <<'PY'
import json
import sys
from pathlib import Path
payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
if not payload.get("job_id"):
    raise SystemExit(f"missing job_id: {payload!r}")
print(payload["job_id"])
PY
)"

deadline=$(( $(date +%s) + 600 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  curl --silent --show-error --output "$response_file" "$base_url/v1/score/$job_id"
  state="$(python3 - "$response_file" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
print(payload.get("status", "unknown"))
PY
)"
  if [ "$state" = "succeeded" ]; then
    python3 - "$response_file" <<'PY'
import json
import sys
from pathlib import Path
payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
if payload.get("match_score") not in (-2, -1, 0, 1, 2):
    raise SystemExit(f"invalid match_score: {payload!r}")
if not isinstance(payload.get("games"), list) or len(payload["games"]) != 2:
    raise SystemExit(f"expected two BO2 games: {payload!r}")
print(f"real match passed: match_score={payload['match_score']}, games={len(payload['games'])}")
PY
    exit 0
  fi
  if [ "$state" = "failed" ]; then
    cat "$response_file"
    exit 1
  fi
  sleep 2
done
echo "Timed out waiting for job $job_id" >&2
exit 1
