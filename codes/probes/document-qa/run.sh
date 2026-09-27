#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
export PIWS_ADMIN_SECRET_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/pi-workspace-admin-preview"
export PIWS_TASK_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/pi-workspace-document-acceptance/tasks"
export PIWS_COMPOSE_PROJECT=piws-document-acceptance
export PIWS_TASK_PORT=30206
export PIWS_PUBLIC_ORIGIN=http://127.0.0.1:30206
export PIWS_TASK_IMAGE=piws-task-worker:0.87.1-document-v1
export PIWS_APP_UID="$(id -u)"
export PIWS_APP_GID="$(id -g)"
mkdir -p "$PIWS_TASK_DATA_DIR"
chmod 700 "$PIWS_TASK_DATA_DIR"
docker build -q -t "$PIWS_TASK_IMAGE" -f "$repo_root/codes/Dockerfile.task" "$repo_root/codes"
docker compose -p "$PIWS_COMPOSE_PROJECT" -f "$repo_root/codes/compose.task.yaml" -f "$repo_root/codes/probes/document-qa/compose.fixture.yaml" up --build -d
ready=0
for attempt in $(seq 1 30); do
  if docker compose -p "$PIWS_COMPOSE_PROJECT" -f "$repo_root/codes/compose.task.yaml" exec -T api node -e \
    'require("node:http").get("http://127.0.0.1:3000/health",{headers:{Host:"127.0.0.1:30206"}},r=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1))' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" -eq 1 ] || exit 1
docker compose -p "$PIWS_COMPOSE_PROJECT" -f "$repo_root/codes/compose.task.yaml" exec -T api npm run check
docker compose -p "$PIWS_COMPOSE_PROJECT" -f "$repo_root/codes/compose.task.yaml" exec -T api node --test src/api/document-qa.test.ts
docker compose -p "$PIWS_COMPOSE_PROJECT" -f "$repo_root/codes/compose.task.yaml" exec -T -e PIWS_ACCEPTANCE_TEST=1 api npm run test:task-runtime
docker compose -p "$PIWS_COMPOSE_PROJECT" -f "$repo_root/codes/compose.task.yaml" exec -T api node probes/document-qa/check.mjs
