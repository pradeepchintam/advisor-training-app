#!/usr/bin/env bash
# Refresh .env from SSM and (re)deploy the stack on this host.
set -euo pipefail

cd "$(dirname "$0")"

./fetch-env.sh
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
