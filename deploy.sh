#!/usr/bin/env bash
# Copies the project to the ZimaOS box and (re)starts it. Safe to re-run.
#
#   ./deploy.sh              deploy and start everything
#   DEBUG=1 ./deploy.sh      also publish FreeFlight on the box's 127.0.0.1:8000 for curl checks
#   ZIMA_HOST=me@10.0.0.5 ./deploy.sh   use something other than the "zima" SSH alias
#
# Runs on your own machine and uses your SSH login; nothing here runs unattended.
set -euo pipefail

HOST="${ZIMA_HOST:-zima}"
DEST="${ZIMA_DEST:-/DATA/AppData/overhead}"
FILES=(docker-compose.yml docker-compose.debug.yml .env nginx.conf config.json web)

cd "$(dirname "$0")"

for f in "${FILES[@]}"; do
  [[ -e "$f" ]] || { echo "Missing $f: see README, \"First-time setup\"" >&2; exit 1; }
done
python3 -m json.tool config.json >/dev/null 2>&1 || node -e 'JSON.parse(require("fs").readFileSync("config.json"))' \
  || { echo "config.json is not valid JSON" >&2; exit 1; }

COMPOSE="docker compose -f docker-compose.yml"
[[ "${DEBUG:-0}" == 1 ]] && COMPOSE+=" -f docker-compose.debug.yml"

echo "==> Copying files to $HOST:$DEST"
# One SSH connection: tar the files locally, unpack on the box (ZimaOS has no rsync by default).
tar czf - "${FILES[@]}" | ssh "$HOST" "mkdir -p '$DEST' && tar xzf - -C '$DEST'"

echo "==> Starting containers"
ssh "$HOST" "cd '$DEST' && $COMPOSE up -d --remove-orphans && $COMPOSE ps"

echo "==> Done. Open http://<box>:$(grep -E '^DISPLAY_PORT=' .env | cut -d= -f2 || echo 8090)"
