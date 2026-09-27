#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
secret_dir="${XDG_DATA_HOME:-$HOME/.local/share}/pi-workspace-admin-preview"
for name in postgres-password admin-key service-key master-key; do
  if [ ! -s "$secret_dir/$name" ]; then
    echo "Missing existing admin preview secret: $name" >&2
    exit 1
  fi
done

export PIWS_ADMIN_SECRET_DIR="$secret_dir"
export PIWS_COMPOSE_PROJECT=piws-product-preview
export PIWS_ADMIN_PORT=30202
export PIWS_PUBLIC_ORIGIN=http://127.0.0.1:30202
export PIWS_APP_UID="$(id -u)"
export PIWS_APP_GID="$(id -g)"
docker compose -p "$PIWS_COMPOSE_PROJECT" -f "$repo_root/codes/compose.admin.yaml" up --build -d
docker compose -p "$PIWS_COMPOSE_PROJECT" -f "$repo_root/codes/compose.admin.yaml" ps
echo "Open http://127.0.0.1:30202/models/connections"
echo "Use the existing administrator key from: $secret_dir/admin-key"
