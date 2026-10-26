#!/bin/sh
set -eu
base_url="${PROXY_URL:-http://127.0.0.1:8787}"
base_url="${base_url%/}"
status="$(curl --silent --output /tmp/ott_proxy_test_04.json --write-out '%{http_code}' \
  "$base_url/v1/unknown")"
cat /tmp/ott_proxy_test_04.json
printf '\nHTTP %s\n' "$status"
test "$status" = 404
rm -f /tmp/ott_proxy_test_04.json
