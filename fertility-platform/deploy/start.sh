#!/bin/sh
# Single-container demo: provisions the database, then runs the Python engine and the Node API (which also
# serves the web app and runs the recalculation worker). If either process exits, the container exits.
set -eu
cd "$(dirname "$0")/.."

: "${MASTER_SECRET:?MASTER_SECRET is required}"
: "${DATABASE_OWNER_URL:?DATABASE_OWNER_URL is required}"

node deploy/provision.mjs
eval "$(node deploy/env.mjs)"
export ENGINE_URL="${ENGINE_URL:-http://127.0.0.1:8000}"

( cd services/biochem-engine && exec "${PYTHON:-python3}" -m uvicorn app.asgi:app --host 127.0.0.1 --port 8000 --log-level warning ) &
ENGINE_PID=$!

node services/api-gateway/dist/main.js &
API_PID=$!

trap 'kill $ENGINE_PID $API_PID 2>/dev/null || true' TERM INT
# wait for whichever exits first, then stop the other
while kill -0 $ENGINE_PID 2>/dev/null && kill -0 $API_PID 2>/dev/null; do sleep 2; done
kill $ENGINE_PID $API_PID 2>/dev/null || true
exit 1
