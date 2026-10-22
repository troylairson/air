#!/usr/bin/env bash
# Copies the project to the ZimaOS box and (re)starts it. Safe to re-run.
#
#   ./deploy.sh              deploy and start everything
#   DEBUG=1 ./deploy.sh      also publish FreeFlight on the box's 127.0.0.1:8000 for curl checks
#   SUDO=1 ./deploy.sh       run docker (and the copy into $ZIMA_DEST) with sudo on the box
#   SUDO=0 ./deploy.sh       never use sudo
#   ZIMA_HOST=me@10.0.0.5 ./deploy.sh   use something other than the "zima" SSH alias
#
# By default (SUDO=auto) it checks whether your user can run docker on the box and
# uses sudo only if it can't. sudo asks for your ZimaOS password once per deploy.
#
# Runs on your own machine and uses your SSH login; nothing here runs unattended.
set -euo pipefail

HOST="${ZIMA_HOST:-zima}"
DEST="${ZIMA_DEST:-/DATA/AppData/overhead}"
SUDO="${SUDO:-auto}"
FILES=(docker-compose.yml docker-compose.debug.yml .env nginx.conf config.json web)

cd "$(dirname "$0")"

for f in "${FILES[@]}"; do
  [[ -e "$f" ]] || { echo "Missing $f: see README, \"First-time setup\"" >&2; exit 1; }
done
python3 -m json.tool config.json >/dev/null 2>&1 || node -e 'JSON.parse(require("fs").readFileSync("config.json"))' \
  || { echo "config.json is not valid JSON" >&2; exit 1; }
same_home='import json,sys; h=lambda f: json.load(open(f)).get("home"); sys.exit(0 if h("config.json") == h("config.example.json") else 1)'
if python3 -c "$same_home" 2>/dev/null; then
  echo "Warning: config.json still has the example location; see README, \"Find your latitude and longitude\"" >&2
fi

COMPOSE="docker compose -f docker-compose.yml"
[[ "${DEBUG:-0}" == 1 ]] && COMPOSE+=" -f docker-compose.debug.yml"

if [[ "$SUDO" == auto ]]; then
  if ssh "$HOST" 'docker info >/dev/null 2>&1'; then SUDO=0; else
    echo "==> Your user can't run docker on $HOST; using sudo"
    SUDO=1
  fi
fi

if [[ "$SUDO" == 1 ]]; then
  # sudo needs a terminal to ask for the password, and the copy's SSH stdin carries the files.
  # So: unpack into a staging folder in your home (no sudo), then one interactive session
  # moves it into place and starts the containers.
  STAGE=".overhead-deploy"
  echo "==> Copying files to $HOST:~/$STAGE"
  tar czf - "${FILES[@]}" | ssh "$HOST" "rm -rf ~/$STAGE && mkdir -p ~/$STAGE && tar xzf - -C ~/$STAGE"

  echo "==> Installing to $DEST and starting containers (sudo)"
  ssh -t "$HOST" "cd ~/$STAGE && sudo sh -c 'mkdir -p \"$DEST\" && cp -R ./. \"$DEST\" && cd \"$DEST\" && $COMPOSE up -d --remove-orphans && $COMPOSE ps' && rm -rf ~/$STAGE"
else
  echo "==> Copying files to $HOST:$DEST"
  # One SSH connection: tar the files locally, unpack on the box (ZimaOS has no rsync by default).
  tar czf - "${FILES[@]}" | ssh "$HOST" "mkdir -p '$DEST' && tar xzf - -C '$DEST'"

  echo "==> Starting containers"
  ssh "$HOST" "cd '$DEST' && $COMPOSE up -d --remove-orphans && $COMPOSE ps"
fi

echo "==> Done. Open http://<box>:$(grep -E '^DISPLAY_PORT=' .env | cut -d= -f2 || echo 8090)"
