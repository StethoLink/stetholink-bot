#!/usr/bin/env bash
# FICTIONAL-data test stack, see docs/openemr.md ('Checking the embedded frame'). Run from anywhere inside the repository with OPENEMR_RUN_DIR set.
# Disposable PostgreSQL (TLS, every migration applied) for the app that runs against the real OpenEMR.
set -euo pipefail
S=${OPENEMR_RUN_DIR:?set OPENEMR_RUN_DIR to a work directory for certificates, the client id and logs}
cd "$(git rev-parse --show-toplevel)"
db=stetholink-oe-db
docker rm -f $db >/dev/null 2>&1 || true
docker run -d --name $db -p 127.0.0.1::5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 40); do docker exec $db pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break; sleep 1; done
port=$(docker port $db 5432/tcp | head -1 | cut -d: -f2)
STETHOLINK_TEST_OWNER_URL="postgres://postgres@127.0.0.1:$port/postgres" node tests/e2e/m3-migrations.mts > $S/migrations.log 2>&1 && echo "migrations OK"
docker exec -u postgres $db openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=localhost -addext subjectAltName=DNS:localhost -keyout /var/lib/postgresql/server.key -out /var/lib/postgresql/server.crt 2>/dev/null
docker exec -u postgres $db chmod 600 /var/lib/postgresql/server.key
docker exec -i $db psql -U postgres -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
alter system set ssl = 'on';
alter system set ssl_cert_file = '/var/lib/postgresql/server.crt';
alter system set ssl_key_file = '/var/lib/postgresql/server.key';
select pg_reload_conf();
SQL
docker cp $db:/var/lib/postgresql/server.crt $S/db-ca.crt
echo "$port" > $S/db-port
echo "db port $port"
