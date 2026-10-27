#!/bin/sh
# Smoke-tests the native app: launches the debug build (needs `pnpm dev` and
# `pnpm db:up`), runs scripts/native-smoke.js inside the real webview, and
# prints the result the script stored through IPC.
set -e
cd "$(dirname "$0")/.."
DB="$HOME/Library/Application Support/ai.leve.fivedb/5db.sqlite3"
cargo build --manifest-path src-tauri/Cargo.toml -q
[ -f "$DB" ] && sqlite3 "$DB" "DELETE FROM settings WHERE key = 'smoke'" || true
FIVEDB_SMOKE_JS="$(cat scripts/native-smoke.js)" ./src-tauri/target/debug/fivedb &
PID=$!
for i in $(seq 1 30); do
  sleep 1
  R=$(sqlite3 "$DB" "SELECT value FROM settings WHERE key = 'smoke'" 2>/dev/null || true)
  [ -n "$R" ] && break
done
kill $PID 2>/dev/null || true
echo "$R"
echo "$R" | grep -q '"ok":true'
