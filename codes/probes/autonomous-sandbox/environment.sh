#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
export PIWS_ADMIN_SECRET_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/pi-workspace-admin-preview"
export PIWS_TASK_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/pi-workspace-autonomous-acceptance/tasks"
export PIWS_COMPOSE_PROJECT=piws-autonomous-acceptance
export PIWS_TASK_PORT=30208
export PIWS_PUBLIC_ORIGIN=http://127.0.0.1:30208
export PIWS_TASK_IMAGE=piws-task-worker:0.87.1-sandbox-v1
export PIWS_SANDBOX_IMAGE=pi-web-trial:pi-0.87.1
export PIWS_SANDBOX_GATEWAY_IMAGE=piws-sandbox-gateway:local-v1
export PIWS_APP_UID="$(id -u)"
export PIWS_APP_GID="$(id -g)"
compose() {
  docker compose -p "$PIWS_COMPOSE_PROJECT" -f "$repo_root/codes/compose.task.yaml" -f "$repo_root/codes/compose.sandbox.yaml" "$@"
}
case "${1:-start}" in
  start)
    mkdir -p "$PIWS_TASK_DATA_DIR"
    chmod 700 "$PIWS_TASK_DATA_DIR"
    compose up --build -d
    compose exec -T api npm run check
    ;;
  stop)
    # Dynamic resources must be removed by the authenticated lifecycle check first.
    if docker ps -aq --filter label=piws.scope="$PIWS_COMPOSE_PROJECT" | read -r remaining; then
      printf 'Managed sandbox containers remain; delete them through the API before shutdown.\n' >&2
      exit 1
    fi
    compose down
    ;;
  *) exit 2 ;;
esac
