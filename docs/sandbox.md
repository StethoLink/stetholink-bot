# Checking StethoLink against a real FHIR server

Automated tests use fake servers. This page is for the next step: a real FHIR server or EHR sandbox that holds **test patients only**. It is a real integration over the real protocol; no real patient is involved until a hospital approves it.

Any EHR source counts as live data for StethoLink, and StethoLink has no other mode. A sandbox therefore needs the full configuration (verified SMART launch, PostgreSQL, session encryption, a real model with `MODEL_LIVE_DATA_APPROVED=true`); the server does not start without it.

## What has been checked, and how

| Check | Against | Status |
| --- | --- | --- |
| SMART launch, signed ID token, permissions, chart facts, cited draft, approval | Fake SMART issuer, fake FHIR server, fake model, PostgreSQL (`tests/e2e/live-ehr-flow.mts`, in CI) | Tested with fake servers |
| Chart reads: search parameters, `_include`, sorting, the server's own paging links | **HAPI FHIR JPA Server 8.12.0 (FHIR 4.0.1) in Docker**, loaded with the fictional chart (`tests/e2e/real-fhir-check.mts`) | Tested on a real server |
| SMART launch against a public sandbox (`launch.smarthealthit.org`) | not reachable from the build environment (network policy) | Not tested; steps below |
| OpenEMR or a hospital EHR | none available | Not tested |

## 1. HAPI FHIR in Docker (reads, and later writes)

HAPI is a complete FHIR server but has no SMART authorization, so this checks the connector, not the launch.

```bash
docker run -d --name stetholink-hapi -p 127.0.0.1:8090:8080 -e hapi.fhir.server_address=https://localhost:8091/fhir hapiproject/hapi:latest
```

```bash
HAPI_URL=http://127.0.0.1:8090/fhir node tests/e2e/real-fhir-check.mts
```

The script waits for the server, loads the fictional chart from `tests/fixtures/fhir-chart.ts` with client-assigned ids, and reads it back through `integrations/fhir/connector.ts` with a page size of 2 so that every list is paged. The connector accepts HTTPS only, so the script puts a throw-away TLS proxy on port 8091 in front of HAPI; `hapi.fhir.server_address` makes HAPI write its paging links for that address.

To use Synthea patients instead, generate them with [Synthea](https://github.com/synthetichealth/synthea) (`./run_synthea -p 20`), post each `output/fhir/*.json` transaction bundle to `http://127.0.0.1:8090/fhir`, and pass a patient id to the connector.

## 2. Public SMART sandbox (full launch)

Needs outbound HTTPS to `launch.smarthealthit.org` from the server that runs StethoLink, and a public HTTPS address for StethoLink (the sandbox redirects the browser back to it).

1. Open `https://launch.smarthealthit.org`. Choose **Provider EHR Launch**, FHIR R4. Select a patient, a provider and an encounter.
2. Set the app launch URL to `https://<stetholink-host>/api/smart/launch`.
3. Note the FHIR server URL shown for the launch (it is the `iss`), and read its discovery document at `<iss>/.well-known/smart-configuration` for the authorization and token endpoints and the JWKS URL.
4. Configure StethoLink:

   | Variable | Value |
   | --- | --- |
   | `CLINICAL_DATA_SOURCE` | `fhir` |
   | `FHIR_BASE_URL` | the `iss` exactly |
   | `SMART_AUTHORIZATION_URL`, `SMART_TOKEN_URL`, `SMART_JWKS_URL`, `SMART_OIDC_ISSUER` | from the discovery document |
   | `SMART_CLIENT_ID` | any id (the sandbox accepts unregistered public clients) |
   | `SMART_REDIRECT_URI` | `https://<stetholink-host>/api/smart/callback` |
   | `SMART_SCOPE` | see `.env.example` |
   | `SMART_CLINICIAN_MAP` | the `sub` and `fhirUser` of the provider you selected, a UUID, and `role: "physician"` |
   | model and database settings | as for any live deployment |

   The first launch fails with "clinician could not be verified" until the mapping contains the provider's exact `sub` and `fhirUser`. Decode the ID token from the sandbox once to read them.
5. Launch from the sandbox. Expected: the chart opens with the "Real patient data" badge, the chart record lists problems, medication orders, allergies, vital signs and laboratory results, and a consultation request produces a draft whose statements each open their source.

## 3. OpenEMR

Follow [OpenEMR and FHIR SMART launch](openemr.md) with OpenEMR's demo patients. OpenEMR issues SMART v1 scopes (`.read`).

## Known limits of this environment

The cloud build container ends every outbound request after 30 seconds. Long model calls fail there for that reason; it is not a product fault.
