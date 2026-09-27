#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
export PIWS_ADMIN_SECRET_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/pi-workspace-admin-preview"
export PIWS_TASK_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/pi-workspace-sandbox-preview/tasks"
export PIWS_COMPOSE_PROJECT=piws-sandbox-preview
export PIWS_TASK_PORT=30207
export PIWS_SANDBOX_PORT=30207
export PIWS_PUBLIC_ORIGIN=http://127.0.0.1:30207
export PIWS_TASK_IMAGE=piws-task-worker:0.87.1-sandbox-v1
export PIWS_SANDBOX_IMAGE=pi-web-trial:pi-0.87.1
export PIWS_SANDBOX_GATEWAY_IMAGE=piws-sandbox-gateway:local-v1
export PIWS_APP_UID="$(id -u)"
export PIWS_APP_GID="$(id -g)"
mkdir -p "$PIWS_TASK_DATA_DIR"
chmod 700 "$PIWS_TASK_DATA_DIR"
docker image inspect "$PIWS_SANDBOX_IMAGE" >/dev/null
docker build -q -t "$PIWS_TASK_IMAGE" -f "$repo_root/codes/Dockerfile.task" "$repo_root/codes"
docker build -q -t "$PIWS_SANDBOX_GATEWAY_IMAGE" -f "$repo_root/codes/src/web-gateway/Dockerfile" "$repo_root/codes"
docker compose -p "$PIWS_COMPOSE_PROJECT" -f "$repo_root/codes/compose.task.yaml" -f "$repo_root/codes/compose.sandbox.yaml" up --build -d
docker compose -p "$PIWS_COMPOSE_PROJECT" -f "$repo_root/codes/compose.task.yaml" -f "$repo_root/codes/compose.sandbox.yaml" exec -T api npm run check
