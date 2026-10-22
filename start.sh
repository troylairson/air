#!/usr/bin/env bash
# Starts (or restarts after changes) the display. Run it on the ZimaOS box, in this folder.
# Safe to re-run any time: after editing config.json or .env, or after `git pull`.
#
#   ./start.sh            start everything
#   DEBUG=1 ./start.sh    also publish FreeFlight on this box's 127.0.0.1:18000 (DEBUG_PORT) for curl checks
#   SUDO=1 ./start.sh     always run docker with sudo (default: only if your user can't run docker)
#   SUDO=0 ./start.sh     never use sudo
set -euo pipefail

cd "$(dirname "$0")"

[[ -e config.json ]] || { echo "Missing config.json: run  cp config.example.json config.json  and set your location" >&2; exit 1; }
[[ -e .env ]] || { echo "Missing .env: run  cp .env.example .env" >&2; exit 1; }

# Check config.json with whatever is on the box (ZimaOS may have neither).
if command -v python3 >/dev/null; then
  python3 -m json.tool config.json >/dev/null 2>&1 || { echo "config.json is not valid JSON" >&2; exit 1; }
  same_home='import json,sys; h=lambda f: json.load(open(f)).get("home"); sys.exit(0 if h("config.json") == h("config.example.json") else 1)'
  if python3 -c "$same_home" 2>/dev/null; then
    echo "Warning: config.json still has the example location; see README, \"Find your latitude and longitude\"" >&2
  fi
fi

DOCKER=docker
case "${SUDO:-auto}" in
  1) DOCKER="sudo docker" ;;
  auto) docker info >/dev/null 2>&1 || { echo "==> Your user can't run docker; using sudo"; DOCKER="sudo docker"; } ;;
esac

COMPOSE="$DOCKER compose -f docker-compose.yml"
[[ "${DEBUG:-0}" == 1 ]] && COMPOSE+=" -f docker-compose.debug.yml"

$COMPOSE up -d --remove-orphans
# nginx reads config.json through a file mount, which some editors break by replacing the file;
# a restart always picks up the current one. It takes a second.
$COMPOSE restart nginx >/dev/null
$COMPOSE ps

ip=$(hostname -I 2>/dev/null | awk '{print $1}')
port=$(grep -E '^DISPLAY_PORT=' .env | cut -d= -f2 || true)
echo "==> Running. Open http://${ip:-<box-ip>}:${port:-8090} in a browser on your network."
