#!/usr/bin/env bash
# FICTIONAL-data test stack: the OpenEMR containers (MariaDB and OpenEMR 7.0.3), the SMART client registered and enabled, the admin given an NPI, certificates.
# Run once. Needs Docker and OPENEMR_RUN_DIR. After it: db.sh, openemr-test-patient.php (its header), proxy.mts, app.sh, frame.sh.
set -euo pipefail
S=${OPENEMR_RUN_DIR:?set OPENEMR_RUN_DIR to a work directory for certificates, the client id and logs}
mkdir -p "$S"
docker network create oe >/dev/null 2>&1 || true
docker rm -f oe-db oe >/dev/null 2>&1 || true
docker run -d --name oe-db --network oe -e MYSQL_ROOT_PASSWORD=root mariadb:11.4 >/dev/null
for _ in $(seq 1 60); do docker exec oe-db mariadb -uroot -proot -e 'select 1' >/dev/null 2>&1 && break; sleep 1; done
docker run -d --name oe --network oe -p 127.0.0.1:9300:443 -e MYSQL_HOST=oe-db -e MYSQL_ROOT_PASS=root -e MYSQL_USER=openemr -e MYSQL_PASS=openemr -e OE_USER=admin -e OE_PASS='Oe-Test-Pass-2026' \
  -e OPENEMR_SETTING_rest_api=1 -e OPENEMR_SETTING_rest_fhir_api=1 -e OPENEMR_SETTING_site_addr_oath=https://localhost:9300 openemr/openemr:7.0.3 >/dev/null
for _ in $(seq 1 240); do [ "$(curl -sk -o /dev/null -w '%{http_code}' https://localhost:9300/apis/default/fhir/metadata)" = 200 ] && break; sleep 3; done
curl -sk -X POST https://localhost:9300/oauth2/default/registration -H 'Content-Type: application/json' -d '{
  "application_type": "public", "client_name": "StethoLink",
  "redirect_uris": ["https://127.0.0.1:3082/api/smart/callback"], "initiate_login_uri": "https://127.0.0.1:3082/api/smart/launch", "contacts": ["admin@example.test"],
  "scope": "launch openid fhirUser patient/Patient.read patient/Encounter.read patient/AllergyIntolerance.read patient/Condition.read patient/MedicationRequest.read patient/Observation.read patient/Medication.read"
}' > "$S/registration.json"
python3 -c 'import json,sys; open(sys.argv[1] + "/client-id", "w").write(json.load(open(sys.argv[1] + "/registration.json"))["client_id"])' "$S"
CID=$(cat "$S/client-id")
docker exec oe-db mariadb -uopenemr -popenemr openemr -e "update oauth_clients set is_enabled=1 where client_id='$CID'; update users set npi='1234567893' where username='admin'; select username, LOWER(CONCAT_WS('-', SUBSTR(HEX(uuid),1,8), SUBSTR(HEX(uuid),9,4), SUBSTR(HEX(uuid),13,4), SUBSTR(HEX(uuid),17,4), SUBSTR(HEX(uuid),21))) as uuid, npi from users where username='admin'" > "$S/user.txt"
docker exec oe cat /etc/ssl/certs/webserver.cert.pem > "$S/oe.crt"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=127.0.0.1 -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" -addext basicConstraints=critical,CA:TRUE -keyout "$S/key.pem" -out "$S/cert.pem" 2>/dev/null
cat "$S/oe.crt" "$S/cert.pem" /root/.ccr/ca-bundle.crt > "$S/ca-bundle.pem"
node --input-type=module -e 'import { writeFileSync } from "node:fs"; import { ORDER_CATALOG } from "./tests/fixtures/order-catalog.ts"; writeFileSync(process.argv[1], JSON.stringify(ORDER_CATALOG));' "$S/orders.json" 2>/dev/null
echo "OpenEMR 7.0.3 up, client $CID enabled, certificates and the fictional catalog written to $S"
