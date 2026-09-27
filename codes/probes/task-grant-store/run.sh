#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
suffix="$(date +%s)-$$"
network_name="piws-grant-check-${suffix}"
db_name="piws-grant-db-${suffix}"
image_name="piws-grant-check:${suffix}"
network_created=0
db_created=0

cleanup() {
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
  --entrypoint npm "$image_name" run test:task-grant-store
docker run --rm --network none --entrypoint npm "$image_name" run check
