#!/bin/sh
set -eu
base_url="${PROXY_URL:-http://127.0.0.1:8787}"
base_url="${base_url%/}"
curl --fail-with-body --silent --show-error "$base_url/v1/health"
printf '\n'
