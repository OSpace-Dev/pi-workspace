#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
export PIWS_ADMIN_SECRET_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/pi-workspace-admin-preview"
export PIWS_TASK_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/pi-workspace-task-acceptance/tasks"
export PIWS_COMPOSE_PROJECT=piws-task-acceptance
export PIWS_TASK_PORT=30204
export PIWS_PUBLIC_ORIGIN=http://127.0.0.1:30204
export PIWS_APP_UID="$(id -u)"
export PIWS_APP_GID="$(id -g)"
mkdir -p "$PIWS_TASK_DATA_DIR"
chmod 700 "$PIWS_TASK_DATA_DIR"
docker build -q -t piws-task-worker:0.87.1-local -f "$repo_root/codes/Dockerfile.task" "$repo_root/codes"
docker compose -p "$PIWS_COMPOSE_PROJECT" -f "$repo_root/codes/compose.task.yaml" -f "$repo_root/codes/probes/task-runtime/compose.fixture.yaml" up --build -d
ready=0
for attempt in $(seq 1 30); do
  if docker compose -p "$PIWS_COMPOSE_PROJECT" -f "$repo_root/codes/compose.task.yaml" exec -T api node -e \
    'require("node:http").get("http://127.0.0.1:3000/health",{headers:{Host:"127.0.0.1:30204"}},r=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1))' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  docker compose -p "$PIWS_COMPOSE_PROJECT" -f "$repo_root/codes/compose.task.yaml" logs --tail 30
  exit 1
fi
docker compose -p "$PIWS_COMPOSE_PROJECT" -f "$repo_root/codes/compose.task.yaml" exec -T api node probes/task-runtime/check.mjs
docker compose -p "$PIWS_COMPOSE_PROJECT" -f "$repo_root/codes/compose.task.yaml" exec -T -e PIWS_ACCEPTANCE_TEST=1 api npm run test:task-runtime
docker compose -p "$PIWS_COMPOSE_PROJECT" -f "$repo_root/codes/compose.task.yaml" exec -T runtime node probes/task-runtime/security.mjs
