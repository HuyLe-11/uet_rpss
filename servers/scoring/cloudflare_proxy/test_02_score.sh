#!/bin/sh
set -eu
base_url="${PROXY_URL:-http://127.0.0.1:8787}"
base_url="${base_url%/}"
curl --fail-with-body --silent --show-error \
  -H 'content-type: application/json' \
  --data-binary @- "$base_url/v1/score" <<'JSON'
{"contestant_code":"def choose_move(state):\n    p=state['pieces']\n    return next((x,y,nx,ny) for x,y,nx,ny in [] )","benchmark_code":"def choose_move(state):\n    return (-1,-1,-1,-1)"}
JSON
printf '\n'
