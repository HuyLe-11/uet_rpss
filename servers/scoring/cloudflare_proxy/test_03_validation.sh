#!/bin/sh
set -eu
base_url="${PROXY_URL:-http://127.0.0.1:8787}"
base_url="${base_url%/}"
status="$(curl --silent --output /tmp/ott_proxy_test_03.json --write-out '%{http_code}' \
  -H 'content-type: application/json' \
  --data '{"contestant_code":"","benchmark_code":"def choose_move(state): return (-1,-1,-1,-1)"}' \
  "$base_url/v1/score")"
cat /tmp/ott_proxy_test_03.json
printf '\nHTTP %s\n' "$status"
test "$status" = 400
rm -f /tmp/ott_proxy_test_03.json
