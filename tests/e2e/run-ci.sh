#!/usr/bin/env bash
set -euo pipefail

# Run on a trusted runner. The disposable database binds only to loopback.
db="stetholink-m05-${GITHUB_RUN_ID:-$$}"
tmp=$(mktemp -d)
app_pid=
cleanup() {
  if [[ -n "$app_pid" ]]; then kill "$app_pid" 2>/dev/null || true; fi
  docker rm -f "$db" >/dev/null 2>&1 || true
  rm -f "$tmp/ca.crt"
  rmdir "$tmp"
}
trap cleanup EXIT

docker run -d --name "$db" -p 127.0.0.1::5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in {1..30}; do
  if docker exec "$db" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
psql() { docker exec -i "$db" psql -U postgres -v ON_ERROR_STOP=1 "$@"; }
db_port=$(docker port "$db" 5432/tcp | cut -d: -f2)
STETHOLINK_TEST_OWNER_URL="postgres://postgres@127.0.0.1:$db_port/postgres" node tests/e2e/m3-migrations.mts

docker exec -u postgres "$db" openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
  -addext subjectAltName=DNS:localhost -keyout /var/lib/postgresql/server.key \
  -out /var/lib/postgresql/server.crt 2>/dev/null
docker exec -u postgres "$db" chmod 600 /var/lib/postgresql/server.key
psql >/dev/null <<'SQL'
alter system set ssl = 'on';
alter system set ssl_cert_file = '/var/lib/postgresql/server.crt';
alter system set ssl_key_file = '/var/lib/postgresql/server.key';
select pg_reload_conf();
SQL
docker cp "$db:/var/lib/postgresql/server.crt" "$tmp/ca.crt"
export STETHOLINK_DATABASE_URL="postgres://stetholink_runtime@localhost:$db_port/postgres"
export STETHOLINK_DATABASE_CA
STETHOLINK_DATABASE_CA=$(cat "$tmp/ca.crt")
export STAGING_LAUNCH_SECRET
STAGING_LAUNCH_SECRET=$(openssl rand -hex 32)
export AUTH_MODE=staging VERCEL_ENV=preview VERCEL_TARGET_ENV=preview
export AI_PROVIDER=mock CLINICAL_DATA_SOURCE=synthetic TENANT_ID=ci-synthetic
export STAGING_SESSION_SECONDS=45 STAGING_BASE_URL=http://127.0.0.1:3075

node node_modules/next/dist/bin/next start apps/embedded-app --hostname 127.0.0.1 --port 3075 &
app_pid=$!
for _ in {1..30}; do
  if curl --silent --fail "$STAGING_BASE_URL/api/health" >/dev/null; then break; fi
  sleep 1
done
node tests/e2e/staging.mts
kill "$app_pid"
wait "$app_pid" || true
app_pid=
node tests/e2e/m3-restart.mts
