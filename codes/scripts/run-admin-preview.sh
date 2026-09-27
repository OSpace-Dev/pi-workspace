#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
secret_dir="${XDG_DATA_HOME:-$HOME/.local/share}/pi-workspace-admin-preview"
mkdir -p "$secret_dir"
docker run --rm -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -v "$repo_root/codes/scripts:/scripts:ro" -v "$secret_dir:/secrets" \
  node:24-bookworm-slim node /scripts/init-admin-preview-secrets.mjs /secrets
export PIWS_ADMIN_SECRET_DIR="$secret_dir"
export PIWS_APP_UID="$(id -u)"
export PIWS_APP_GID="$(id -g)"
docker compose -p piws-admin-preview -f "$repo_root/codes/compose.admin.yaml" up --build -d
docker compose -p piws-admin-preview -f "$repo_root/codes/compose.admin.yaml" ps
echo "Open http://127.0.0.1:30201/"
echo "Read the administrator key with: cat $secret_dir/admin-key"
