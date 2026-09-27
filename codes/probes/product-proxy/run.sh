#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
suffix="$(date +%s)-$$"
network_name="piws-product-proxy-${suffix}"
db_name="piws-product-proxy-db-${suffix}"
image_name="piws-product-proxy-check:${suffix}"
network_created=0
db_created=0
server_name="piws-product-proxy-server-${suffix}"
server_created=0

cleanup() {
  if [ "$server_created" -eq 1 ]; then
    docker rm -f "$server_name" >/dev/null 2>&1 || true
  fi
  if [ "$db_created" -eq 1 ]; then
    docker rm -f "$db_name" >/dev/null 2>&1 || true
  fi
  if [ "$network_created" -eq 1 ]; then
    docker network rm "$network_name" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

docker build --quiet -t "$image_name" -f "$repo_root/codes/Dockerfile" "$repo_root/codes"
docker network create --internal "$network_name" >/dev/null
network_created=1
docker run -d --rm --name "$db_name" --network "$network_name" --network-alias db \
  -e POSTGRES_DB=pi_workspace -e POSTGRES_USER=pi_workspace \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17-alpine >/dev/null
db_created=1

ready=0
for attempt in $(seq 1 30); do
  if docker exec "$db_name" pg_isready -U pi_workspace -d pi_workspace >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "Temporary PostgreSQL did not become ready" >&2
  exit 1
fi

docker run --rm --network "$network_name" \
  -e TEST_DATABASE_URL=postgres://pi_workspace@db:5432/pi_workspace \
  --entrypoint npm "$image_name" run test:product-proxy
docker run --rm --network none --entrypoint npm "$image_name" run check
docker run -d --rm --name "$server_name" --network "$network_name" --network-alias probe \
  -e TEST_DATABASE_URL=postgres://pi_workspace@db:5432/pi_workspace \
  -v "$repo_root/codes/probes:/app/probes:ro" \
  "$image_name" node probes/product-proxy/pi-server.ts >/dev/null
server_created=1
ready=0
for attempt in $(seq 1 20); do
  if docker run --rm --network "$network_name" node:24-bookworm-slim node -e \
    'fetch("http://probe:4100/fixture/task").then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  docker logs "$server_name"
  exit 1
fi
for test_case in normal reject break nodone; do
  docker run --rm --network "$network_name" \
    -v "$repo_root/codes/probes/product-proxy:/probe:ro" \
    -e PROBE_CASE="$test_case" --entrypoint node pi-web-trial:pi-0.87.1 /probe/pi-driver.mjs
done
