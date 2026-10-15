#!/usr/bin/env bash
# Idempotent local API starter for development: (re)starts the padify API
# (server/, Bun) detached from the shell so it survives between tool calls,
# backed by a throwaway local SQLite file, and waits until it answers.
#
# The Vite dev proxy forwards /api/* to http://localhost:3041 (see
# vite.config.ts); this script is the "other end" of that proxy for local
# work — the production API runs on the box from the same server/ code with
# Turso credentials instead.
#
# Safe to run repeatedly: an already-answering API is left alone.
set -u
cd "$(dirname "$0")/../server"

PORT=3041
DB_FILE="${PADIFY_DEV_DB:-/home/z/my-project/db/custom.db}"

alive() {
  curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:${PORT}/api/me"
}

if [ "$(alive)" = "401" ] || [ "$(alive)" = "200" ]; then
  echo "padify API already up: http://127.0.0.1:${PORT}/ (db: ${DB_FILE})"
  exit 0
fi

mkdir -p "$(dirname "$DB_FILE")"

# Kill any stale API bound to the port, then start detached.
pkill -f "bun.*index\.ts" 2>/dev/null || true
pkill -f "padify-api" 2>/dev/null || true
sleep 0.5
TURSO_DATABASE_URL="file:${DB_FILE}" nohup bun index.ts > /tmp/padify-api.log 2>&1 < /dev/null &
disown

for _ in $(seq 1 40); do
  code="$(alive)"
  if [ "$code" = "401" ] || [ "$code" = "200" ]; then
    echo "padify API up: http://127.0.0.1:${PORT}/ (db: ${DB_FILE})"
    exit 0
  fi
  sleep 0.5
done

echo "padify API failed to start; log tail:"
tail -20 /tmp/padify-api.log
exit 1
