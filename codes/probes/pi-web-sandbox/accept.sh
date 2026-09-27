#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
export PIWS_ADMIN_SECRET_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/pi-workspace-admin-preview"
export PIWS_TASK_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/pi-workspace-sandbox-acceptance/tasks"
export PIWS_COMPOSE_PROJECT=piws-sandbox-acceptance
export PIWS_TASK_PORT=30208
export PIWS_PUBLIC_ORIGIN=http://127.0.0.1:30208
export PIWS_TASK_IMAGE=piws-task-worker:0.87.1-sandbox-v1
export PIWS_SANDBOX_IMAGE=pi-web-trial:pi-0.87.1
export PIWS_SANDBOX_GATEWAY_IMAGE=piws-sandbox-gateway:local-v1
export PIWS_APP_UID="$(id -u)"
export PIWS_APP_GID="$(id -g)"
mkdir -p "$PIWS_TASK_DATA_DIR"
chmod 700 "$PIWS_TASK_DATA_DIR"
docker compose -p "$PIWS_COMPOSE_PROJECT" -f "$repo_root/codes/compose.task.yaml" -f "$repo_root/codes/compose.sandbox.yaml" -f "$repo_root/codes/probes/pi-web-sandbox/compose.fixture.yaml" up --build -d
ready=0
for attempt in $(seq 1 30); do
  if docker compose -p "$PIWS_COMPOSE_PROJECT" -f "$repo_root/codes/compose.task.yaml" exec -T api node -e \
    'require("node:http").get("http://127.0.0.1:3000/health",{headers:{Host:"127.0.0.1:30208"}},r=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1))' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" -eq 1 ] || exit 1
docker compose -p "$PIWS_COMPOSE_PROJECT" -f "$repo_root/codes/compose.task.yaml" -f "$repo_root/codes/compose.sandbox.yaml" -f "$repo_root/codes/probes/pi-web-sandbox/compose.fixture.yaml" exec -T api node probes/pi-web-sandbox/check.mjs
