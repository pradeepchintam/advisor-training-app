#!/usr/bin/env bash
# Refresh .env from SSM and (re)deploy the stack on this host.
set -euo pipefail

cd "$(dirname "$0")"

./fetch-env.sh

# Build images first so the migration step can run with the new code.
docker compose -f docker-compose.prod.yml build

# Apply DB migrations. If the alembic_version table doesn't exist yet (true for
# environments where the initial schema was created by SQLAlchemy create_all
# rather than alembic), this one-shot will fail; bootstrap by stamping at 001
# before running this script the first time:
#   docker compose -f docker-compose.prod.yml run --rm backend alembic stamp 001
docker compose -f docker-compose.prod.yml run --rm backend alembic upgrade head

# Bring up services (recreates containers that have stale images).
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
