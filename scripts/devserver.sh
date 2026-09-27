#!/usr/bin/env bash
# Idempotent dev-server starter: (re)starts `vite --port 5173 --strictPort`
# detached from the shell so it survives between tool calls, waits until it
# answers, and prints the reachable URL. Safe to run repeatedly.
set -u
cd "$(dirname "$0")/.."

PORT=5173
alive() {
  curl -s -o /dev/null -m 2 "http://127.0.0.1:${PORT}/"
}

if [ "$(alive)" = "200" ]; then
  echo "dev server already up: http://127.0.0.1:${PORT}/"
  exit 0
fi

# Kill any stale vite bound to the port, then start detached.
pkill -f "vite --port ${PORT}" 2>/dev/null || true
sleep 0.5
nohup bunx vite --port "${PORT}" --strictPort --host 127.0.0.1 > vite.log 2>&1 < /dev/null &
disown

for _ in $(seq 1 40); do
  if [ "$(alive)" = "200" ]; then
    echo "dev server up: http://127.0.0.1:${PORT}/"
    exit 0
  fi
  sleep 0.5
done

echo "dev server failed to start; vite.log tail:"
tail -20 vite.log
exit 1
