#!/usr/bin/env bash
# Padify database backup — the durable copy of every synced note lives in
# this one database, and nothing else holds a second copy. This script is
# the safety net: a gzipped SQL dump written before anything can go wrong
# (a bad deploy, a deleted database, a migration that went sideways).
#
# Usage:
#   server/backup.sh [output-dir]        # default: ./backups next to this script
#
# Environment (same variables the API reads):
#   TURSO_DATABASE_URL    libsql://… or https://… → dumps through the turso
#                         CLI (needs TURSO_DATABASE_NAME and TURSO_AUTH_TOKEN);
#                         file:… or unset → plain sqlite3 dump of that file
#   TURSO_DATABASE_NAME   (Turso only) the database's NAME, as `turso db list`
#                         shows it — the URL alone is not enough for the CLI
#   TURSO_AUTH_TOKEN      (Turso only) a token with read access
#
# Retention: dumps older than BACKUP_KEEP_DAYS (default 14) are deleted.
#
# Cron — nightly at 03:15, keeping a log:
#   15 3 * * * cd /path/to/padify/server && ./backup.sh >> backups/backup.log 2>&1
set -euo pipefail

cd "$(dirname "$0")"

OUT_DIR="${1:-backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$OUT_DIR"

URL="${TURSO_DATABASE_URL:-}"
OUT_FILE="$OUT_DIR/padify-db-$STAMP.sql.gz"

dump_turso() {
  : "${TURSO_DATABASE_NAME:?TURSO_DATABASE_NAME is required to dump a Turso database (see turso db list)}"
  : "${TURSO_AUTH_TOKEN:?TURSO_AUTH_TOKEN is required to dump a Turso database}"
  command -v turso >/dev/null 2>&1 || {
    echo "backup.sh: the turso CLI is not installed — curl -sSfL https://get.tur.so/install.sh | bash" >&2
    exit 1
  }
  turso db shell "$TURSO_DATABASE_NAME" --token "$TURSO_AUTH_TOKEN" .dump
}

dump_local() {
  command -v sqlite3 >/dev/null 2>&1 || {
    echo "backup.sh: sqlite3 is not installed (apt install sqlite3 / brew install sqlite)" >&2
    exit 1
  }
  # Default mirrors server/db.ts: server/local.db when no URL is set.
  local db_path
  db_path="${URL#file:}"
  db_path="${db_path:-local.db}"
  sqlite3 "$db_path" .dump
}

if [[ "$URL" =~ ^(libsql|https?):// ]]; then
  dump_turso | gzip -c >"$OUT_FILE"
else
  dump_local | gzip -c >"$OUT_FILE"
fi

# A dump that failed halfway through is worse than no dump — it looks like
# a backup. Refuse to keep anything suspiciously small.
MIN_BYTES=256
if [[ "$(wc -c <"$OUT_FILE")" -lt "$MIN_BYTES" ]]; then
  echo "backup.sh: $OUT_FILE is suspiciously small — removing it (dump likely failed)" >&2
  rm -f "$OUT_FILE"
  exit 1
fi

# Retention: keep the newest BACKUP_KEEP_DAYS days of dumps.
find "$OUT_DIR" -name 'padify-db-*.sql.gz' -type f -mtime +"$KEEP_DAYS" -delete

echo "backup.sh: wrote $OUT_FILE ($(du -h "$OUT_FILE" | cut -f1))"
