#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
secret_dir="${XDG_DATA_HOME:-$HOME/.local/share}/pi-workspace-admin-preview"
task_dir="${XDG_DATA_HOME:-$HOME/.local/share}/pi-workspace-task-preview/tasks"
for name in postgres-password admin-key service-key master-key; do
  if [ ! -s "$secret_dir/$name" ]; then
    echo "Missing existing admin preview secret: $name" >&2
    exit 1
  fi
done
mkdir -p "$task_dir"
chmod 700 "$task_dir"

export PIWS_ADMIN_SECRET_DIR="$secret_dir"
export PIWS_TASK_DATA_DIR="$task_dir"
export PIWS_COMPOSE_PROJECT=piws-task-preview
export PIWS_APP_UID="$(id -u)"
export PIWS_APP_GID="$(id -g)"
docker build -q -t piws-task-worker:0.87.1-local -f "$repo_root/codes/Dockerfile.task" "$repo_root/codes"
docker compose -p "$PIWS_COMPOSE_PROJECT" -f "$repo_root/codes/compose.task.yaml" up --build -d
docker compose -p "$PIWS_COMPOSE_PROJECT" -f "$repo_root/codes/compose.task.yaml" ps
echo "Open http://127.0.0.1:30203/tasks"
echo "Use the existing administrator key from: $secret_dir/admin-key"
