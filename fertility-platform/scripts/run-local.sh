#!/usr/bin/env bash
# Run the whole app on this computer: database, engine, API, recalculation worker and the web app.
#   npm run local            (or: bash scripts/run-local.sh)
# Then open http://localhost:8080
#
# Needs: Node 22+, Python 3.12+ with `pip install fastapi uvicorn pydantic`, and PostgreSQL 14+ installed.
# By default it starts its own private PostgreSQL in .local/ (stopped again on exit; data survives restarts).
# To use a database you already have instead, set DATABASE_OWNER_URL to a login that may create roles.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"
STATE="$ROOT/.local"
PORT="${PORT:-8080}"
PGPORT_LOCAL="${PGPORT_LOCAL:-54320}"
mkdir -p "$STATE"

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# ---- prerequisites -----------------------------------------------------------------------
command -v node >/dev/null || fail "Node.js is not installed (need 22+). https://nodejs.org"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || fail "Node 22 or newer is required (found $(node -v))."
PY="$(command -v python3 || command -v python || true)"
[ -n "$PY" ] || fail "Python 3.12+ is not installed."
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)' || fail "Python 3.12 or newer is required."
"$PY" -c 'import fastapi, uvicorn, pydantic' 2>/dev/null || fail "Missing Python packages. Run:  $PY -m pip install fastapi uvicorn pydantic"

# ---- JavaScript build ----------------------------------------------------------------------
if [ ! -d node_modules ]; then say "Installing JavaScript dependencies…"; npm install --no-audit --no-fund; fi
if [ ! -f services/api-gateway/dist/main.js ] || [ ! -f apps/pwa/vendor/sync-protocol/order.js ] \
   || [ -n "$(find services/api-gateway/src packages/sync-protocol/src -newer services/api-gateway/dist/main.js -name '*.ts' 2>/dev/null | head -1)" ]; then
  say "Building…"; npm run build --silent
fi

# ---- database --------------------------------------------------------------------------------
PGCTL=""
cleanup() {
  [ -n "${APP_PID:-}" ] && kill "$APP_PID" 2>/dev/null || true
  [ -n "$PGCTL" ] && "$PGCTL" -D "$STATE/pg" -m fast stop >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

if [ -z "${DATABASE_OWNER_URL:-}" ]; then
  [ "$(id -u)" -ne 0 ] || fail "PostgreSQL will not start as root. Run as a normal user, or set DATABASE_OWNER_URL."
  BIN=""
  for d in "$(pg_config --bindir 2>/dev/null || true)" /usr/lib/postgresql/*/bin /opt/homebrew/opt/postgresql*/bin /usr/local/opt/postgresql*/bin /Applications/Postgres.app/Contents/Versions/latest/bin; do
    for c in $d; do [ -x "$c/initdb" ] && BIN="$c"; done
  done
  [ -n "$BIN" ] || { command -v initdb >/dev/null && BIN="$(dirname "$(command -v initdb)")"; }
  [ -n "$BIN" ] || fail "PostgreSQL is not installed. Install it (e.g. 'brew install postgresql@16' or 'sudo apt install postgresql'), or set DATABASE_OWNER_URL."
  PGCTL="$BIN/pg_ctl"
  if [ ! -s "$STATE/pg/PG_VERSION" ]; then
    say "Creating a private local database in .local/pg …"
    "$BIN/initdb" -D "$STATE/pg" -U fertility_owner -A trust --encoding=UTF8 >/dev/null
  fi
  "$PGCTL" -D "$STATE/pg" -o "-p $PGPORT_LOCAL -k $STATE -c listen_addresses=127.0.0.1" -l "$STATE/pg.log" -w start >/dev/null \
    || fail "Could not start PostgreSQL. See .local/pg.log"
  "$BIN/psql" -h 127.0.0.1 -p "$PGPORT_LOCAL" -U fertility_owner -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='cycle'" | grep -q 1 \
    || "$BIN/createdb" -h 127.0.0.1 -p "$PGPORT_LOCAL" -U fertility_owner cycle
  export DATABASE_OWNER_URL="postgres://fertility_owner@127.0.0.1:$PGPORT_LOCAL/cycle"
fi

# ---- secrets (generated once, kept so your data stays readable across restarts) -----------------
if [ ! -s "$STATE/master-secret" ]; then
  node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" > "$STATE/master-secret"
  chmod 600 "$STATE/master-secret"
fi
export MASTER_SECRET="$(cat "$STATE/master-secret")"

# ---- run ---------------------------------------------------------------------------------------
export NODE_ENV=development HOST="${HOST:-127.0.0.1}" PORT TRUST_PROXY=false RUN_WORKER=true
export PWA_DIR="$ROOT/apps/pwa" ASSAY_PROFILE="${ASSAY_PROFILE:-spec-provisional-1}" PYTHON="$PY"
say "Starting… (Ctrl-C to stop)"
sh deploy/start.sh &
APP_PID=$!
for _ in $(seq 1 60); do curl -fs "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; kill -0 "$APP_PID" 2>/dev/null || fail "The app stopped during start-up. Scroll up for the reason."; sleep 0.5; done
say ""
say "  App is running:  http://localhost:$PORT"
say "  Demo only — do not enter real health data."
say ""
wait "$APP_PID"
