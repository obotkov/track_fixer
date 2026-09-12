#!/usr/bin/env bash
# Deploy or update TrackFix on the server:  ./deploy.sh [user@host]
# The server pulls the public GitHub repo and rebuilds the container.
set -euo pipefail

HOST="${1:-root@77.105.142.193}"
REPO="https://github.com/obotkov/track_fixer.git"
DIR="/opt/track_fixer"

ssh "$HOST" bash -s <<EOF
set -euo pipefail
command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git; }
# Docker from the distro repos (works on fresh Ubuntu releases); get.docker.com as a fallback.
if ! command -v docker >/dev/null; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2 || curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone "$REPO" "$DIR"; fi
cd "$DIR"
docker compose up -d --build
docker image prune -f >/dev/null
docker compose ps
EOF
