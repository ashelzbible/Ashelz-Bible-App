#!/usr/bin/env bash
# Apply ordered SQL migrations exactly once each, every file in its own
# transaction. Usage: DATABASE_URL=postgres://owner:...@host/db ./migrate.sh
# Run as the schema OWNER (a role the application never uses).
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL must be set}"
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/migrations"
psql() { command psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q "$@"; }

psql -c "CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"

for f in "$dir"/*.sql; do
  v="$(basename "$f")"
  if [ "$(psql -tA -c "SELECT 1 FROM public.schema_migrations WHERE version = '$v'")" = "1" ]; then
    echo "skip   $v"; continue
  fi
  echo "apply  $v"
  psql --single-transaction -f "$f" -c "INSERT INTO public.schema_migrations (version) VALUES ('$v')"
done
