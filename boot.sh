#!/usr/bin/env bash
# Supervisor script — runs npm start in an infinite restart loop.
# Inspired by the nullevi03 resilience philosophy: crash recovery is automatic.
set -euo pipefail

cd "$(dirname "$0")"

# --- .env guard -----------------------------------------------------------
if [ ! -f .env ]; then
  echo "[boot] ERROR: .env not found."
  echo "[boot] Copy .env.example to .env and set DISCORD_BOT_TOKEN before starting."
  exit 1
fi

# --- dependency check -----------------------------------------------------
if [ ! -d node_modules ]; then
  echo "[boot] node_modules not found. Running npm install..."
  npm install
  echo "[boot] npm install complete."
fi

# --- token conflict notice ------------------------------------------------
echo ""
echo "[boot] NOTICE: This bot connects to Discord using the token in .env."
echo "[boot]   If another process is already connected with the same token"
echo "[boot]   (e.g. an existing plugin bot using the same DISCORD_BOT_TOKEN),"
echo "[boot]   Discord will forcibly disconnect the older connection, causing"
echo "[boot]   instability for both bots."
echo "[boot]   Please confirm no other Gateway connection is active for this"
echo "[boot]   token before proceeding. This script will NOT stop other"
echo "[boot]   processes automatically to avoid unintended side effects."
echo ""

# --- infinite restart loop ------------------------------------------------
FIRST=1
while true; do
  if [ "$FIRST" = "1" ]; then
    FIRST=0
  else
    echo "[boot] Process exited. Restarting in 5 seconds... ($(date))"
    sleep 5
  fi

  echo "[boot] Starting bot: $(date)"
  npm start || true
  echo "[boot] Process ended (exit code captured, continuing loop)."
done
