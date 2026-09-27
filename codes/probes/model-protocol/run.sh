#!/usr/bin/env bash
set -euo pipefail

probe_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
network="piws-probe-$$"
server="piws-probe-server-$$"
network_id=""
server_id=""
cleanup() {
  if [[ -n "$server_id" ]]; then docker rm -f "$server_id" >/dev/null 2>&1 || true; fi
  if [[ -n "$network_id" ]]; then docker network rm "$network_id" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

network_id=$(docker network create --internal "$network")
server_id=$(docker create --name "$server" --network "$network" --network-alias probe \
  -v "$probe_dir:/probe:ro" -w /probe node:24-bookworm-slim node server.mjs)
docker start "$server_id" >/dev/null

ready=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if docker run --rm --network "$network" node:24-bookworm-slim \
    node -e 'fetch("http://probe:4100/health").then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  docker logs "$server_id"
  exit 1
fi

docker run --rm --network "$network" node:24-bookworm-slim node -e '
const url = "http://probe:4100/v1/chat/completions";
const body = JSON.stringify({model:"probe-b", messages:[{role:"user",content:"test"}], stream:true});
for (const [token, requestBody, expected] of [
  ["wrong", body, 401],
  ["probe-token-a", body, 403],
  ["probe-token-b", JSON.stringify({...JSON.parse(body), url:"http://invalid/"}), 403]
]) {
  const response = await fetch(url,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:requestBody});
  if (response.status !== expected) process.exit(1);
}
process.stdout.write("authorization cases: passed\n");'

for test_case in normal reject break; do
  docker run --rm --network "$network" -v "$probe_dir:/probe:ro" \
    -e PROBE_CASE="$test_case" --entrypoint node pi-web-trial:pi-0.87.1 /probe/driver.mjs
done
docker logs "$server_id"
