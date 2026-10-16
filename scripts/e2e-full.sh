#!/usr/bin/env bash
# Runs the full e2e suite detached from the shell (setsid + nohup) so it
# survives between tool calls, writing to /tmp/e2e-full.log.
set -u
cd "$(dirname "$0")/.."

if pgrep -f "playwright test" >/dev/null 2>&1; then
  echo "already running:"
  pgrep -af "playwright test" || true
  exit 0
fi

setsid nohup npx playwright test --reporter=line > /tmp/e2e-full.log 2>&1 < /dev/null &
echo "started: $!"
