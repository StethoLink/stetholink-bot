#!/usr/bin/env bash
set -euo pipefail
# Local-only disposable database. Supply installed/extracted PostgreSQL binaries.
: "${PG_BINDIR:?Set PG_BINDIR to PostgreSQL 15+ server binaries}"
: "${PG_SHAREDIR:?Set PG_SHAREDIR to the matching PostgreSQL share directory}"
task_pg=$(mktemp -d /tmp/stetholink-m3-local.XXXXXX)
pg_pid=
cleanup() {
  if [[ -n "$pg_pid" ]]; then kill "$pg_pid" 2>/dev/null || true; wait "$pg_pid" 2>/dev/null || true; fi
  rm -rf "$task_pg"
}
trap cleanup EXIT
"$PG_BINDIR/initdb" -D "$task_pg/data" -L "$PG_SHAREDIR" --auth=trust --no-locale > "$task_pg/init.log"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost -addext subjectAltName=DNS:localhost,IP:127.0.0.1 \
 -keyout "$task_pg/server.key" -out "$task_pg/server.crt" 2>/dev/null
chmod 600 "$task_pg/server.key"
port=${M3_TEST_DB_PORT:-55434}
"$PG_BINDIR/postgres" -D "$task_pg/data" -h 127.0.0.1 -p "$port" -k "$task_pg" \
 -c ssl=on -c ssl_cert_file="$task_pg/server.crt" -c ssl_key_file="$task_pg/server.key" > "$task_pg/server.log" 2>&1 &
pg_pid=$!
for _ in {1..40}; do
 if "$PG_BINDIR/pg_isready" -h 127.0.0.1 -p "$port" >/dev/null 2>&1; then break; fi
 sleep 0.25
done
export STETHOLINK_TEST_OWNER_URL="postgres://$(id -un)@127.0.0.1:$port/postgres"
node tests/e2e/m3-migrations.mts
export STETHOLINK_DATABASE_URL="postgres://stetholink_runtime@127.0.0.1:$port/postgres"
export STETHOLINK_DATABASE_CA
STETHOLINK_DATABASE_CA=$(cat "$task_pg/server.crt")
export STAGING_LAUNCH_SECRET
STAGING_LAUNCH_SECRET=$(openssl rand -hex 32)
export AUTH_MODE=staging VERCEL_ENV=preview VERCEL_TARGET_ENV=preview
export AI_PROVIDER=mock CLINICAL_DATA_SOURCE=synthetic TENANT_ID=ci-synthetic STAGING_SESSION_SECONDS=900
node tests/e2e/m3-persistence.mts
