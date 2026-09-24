#!/usr/bin/env bash
# Smoke test for the free-music endpoints added to the Padify API.
# Runs against a fresh local sqlite DB (server/local-music-smoke.db).
set -euo pipefail
cd "$(dirname "$0")/.."

DB=server/local-music-smoke.db
rm -f "$DB"

PORT=3199
TURSO_DATABASE_URL="file:$DB" PORT=$PORT bun server/index.ts &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true; rm -f "$DB"' EXIT

for i in $(seq 1 40); do
  if curl -s "http://localhost:$PORT/api/music/capabilities" >/dev/null 2>&1; then break; fi
  sleep 0.25
done

echo "--- capabilities (no spotify creds, no yt-dlp on this host):"
curl -s "http://localhost:$PORT/api/music/capabilities"
echo

echo "--- search without creds (expect 503 + clear message):"
curl -s -w '\nHTTP %{http_code}\n' "http://localhost:$PORT/api/music/search?q=lofi"
echo

echo "--- resolve without yt-dlp (expect 503 + clear message):"
curl -s -w '\nHTTP %{http_code}\n' "http://localhost:$PORT/api/music/resolve?trackId=0VjIjW4GlUSh6m7YnU3fY3&title=Blinding%20Lights&artist=The%20Weeknd&durationMs=200040"
echo

echo "--- resolve with bad track id (expect 400):"
curl -s -w '\nHTTP %{http_code}\n' "http://localhost:$PORT/api/music/resolve?trackId=x&title=Blinding%20Lights"
echo

echo "--- search with empty q (expect 400):"
curl -s -w '\nHTTP %{http_code}\n' "http://localhost:$PORT/api/music/search?q="
echo

echo "--- legacy auth still works (signup):"
curl -s -X POST "http://localhost:$PORT/api/auth/signup" -H 'content-type: application/json' \
  -d '{"email":"music@example.com","password":"hunter22"}' | head -c 120
echo

echo "--- music_resolutions table exists:"
bun -e "const db = require('bun:sqlite').default ? new (require('bun:sqlite').Database)('$DB', {readonly:true}) : null;
" 2>/dev/null || true
bun -e "
const { Database } = require('bun:sqlite');
const db = new Database('$DB', { readonly: true });
const row = db.query(\"select name from sqlite_master where type='table' and name='music_resolutions'\").get();
console.log(row ? 'table music_resolutions: OK' : 'MISSING music_resolutions');
"

echo "--- unknown /api/music route (expect 404):"
curl -s -w '\nHTTP %{http_code}\n' "http://localhost:$PORT/api/music/nope"
echo
echo "SMOKE OK"
