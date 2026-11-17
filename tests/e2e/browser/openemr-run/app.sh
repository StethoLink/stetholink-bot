#!/usr/bin/env bash
# FICTIONAL-data test stack. Needs db.sh and register.sh done, the production build, and the TLS proxy (proxy.mts) running.
# The production build against the real OpenEMR 7.0.3. Usage: app.sh [catalog|nocatalog|preflight]
#   catalog (default) / nocatalog: ORDER_CATALOG_FILE is the fictional catalog, or unset; the server starts on 3081.
#   preflight: runs `node scripts/smart-preflight.mts` (docs/openemr.md) with exactly the settings the server would get, and exits.
# Any setting the caller exports first (for example SCRIBE_ENABLED=true and the transcription rates) is passed on, except the ones set below.
S=${OPENEMR_RUN_DIR:?set OPENEMR_RUN_DIR to a work directory for certificates, the client id and logs}
cd "$(git rev-parse --show-toplevel)"
UUID=$(awk -F'\t' '$1=="admin"{print $2}' $S/user.txt | head -1)
export NODE_ENV=production TENANT_ID=oe-orders-test AUTH_MODE=smart CLINICAL_DATA_SOURCE=openemr
export FHIR_BASE_URL=https://localhost:9300/apis/default/fhir
export SMART_CLIENT_ID=$(cat $S/client-id)
export SMART_AUTHORIZATION_URL=https://localhost:9300/oauth2/default/authorize SMART_TOKEN_URL=https://localhost:9300/oauth2/default/token
export SMART_REDIRECT_URI=https://127.0.0.1:3082/api/smart/callback SMART_OIDC_ISSUER=https://localhost:9300/oauth2/default SMART_JWKS_URL=https://localhost:9300/oauth2/default/jwk
export SMART_SCOPE="launch openid fhirUser patient/Patient.read patient/Encounter.read patient/AllergyIntolerance.read patient/Condition.read patient/MedicationRequest.read patient/Observation.read patient/Medication.read"
export SMART_CLINICIAN_MAP="[{\"subject\":\"$UUID\",\"fhirUser\":\"Practitioner/$UUID\",\"clinicianId\":\"66666666-6666-4666-8666-666666666661\",\"role\":\"physician\"}]"
export AI_PROVIDER=openai OPENAI_API_KEY=proxy-injected OPENAI_MODEL=gpt-5 OPENAI_REASONING_EFFORT=low MODEL_LIVE_DATA_APPROVED=true OPENAI_INPUT_USD_PER_MILLION=1.25 OPENAI_OUTPUT_USD_PER_MILLION=10
export NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=$S/ca-bundle.pem
export STETHOLINK_DATABASE_URL=postgres://stetholink_runtime@localhost:$(cat $S/db-port)/postgres STETHOLINK_DATABASE_CA="$(cat $S/db-ca.crt)"
export SESSION_ENCRYPTION_KEY=$(cat $S/session-key 2>/dev/null || (head -c 32 /dev/urandom | base64 | tee $S/session-key))
export COOKIE_MODE=embedded UI_DEFAULT_LOCALE=en
if [ "${1:-catalog}" = "catalog" ]; then export ORDER_CATALOG_FILE=$S/orders.json; fi
if [ "${1:-}" = "preflight" ]; then exec node scripts/smart-preflight.mts; fi
exec node node_modules/next/dist/bin/next start apps/embedded-app --hostname 127.0.0.1 --port 3081
