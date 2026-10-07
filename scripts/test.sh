#!/usr/bin/env bash
# Runs lint + unit + integration tests of every service inside containers,
# exactly the way a CI pipeline would.
#   Usage: scripts/test.sh [price-service|api|worker|frontend ...]   (default: all)
set -euo pipefail
cd "$(dirname "$0")/.."

# -p pins the project name: a COMPOSE_PROJECT_NAME in .env must not make tests reuse the dev stack.
compose() { docker compose -p cryptofolio-test -f docker-compose.test.yml "$@"; }
if [ $# -eq 0 ]; then set -- price-service api worker frontend; fi

trap 'echo "==> tearing down test infrastructure"; compose down -v --remove-orphans >/dev/null 2>&1' EXIT

echo "==> starting test infrastructure"
compose up -d --wait postgres redis minio
compose run --rm minio-init
compose build migrate
compose run --rm migrate

for svc in "$@"; do
  echo "==> testing ${svc}"
  compose build "${svc}-test"
  compose run --rm "${svc}-test"
done

echo "==> all tests passed: $*"
