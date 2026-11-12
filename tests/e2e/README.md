# Authenticated synthetic staging verification

Use an isolated PostgreSQL database with the checked-in migrations and a restricted runtime credential. Configure these values on the intended Vercel Preview branch only.

| Setting | Value |
| --- | --- |
| `AUTH_MODE` | `staging` |
| `CLINICAL_DATA_SOURCE`, `AI_PROVIDER`, `NEXT_PUBLIC_API_MODE` | `synthetic`, `mock`, `http` |
| `TENANT_ID` | A staging tenant identifier |
| `STETHOLINK_DATABASE_URL` | Restricted runtime connection |
| `STETHOLINK_DATABASE_CA` | Trusted CA PEM if needed |
| `STAGING_LAUNCH_SECRET` | Random server-side secret of at least 32 characters |
| `STAGING_SESSION_SECONDS` | `45` for the expiry check |

Vercel supplies `VERCEL_ENV=preview`. Production cannot issue or accept staging sessions. Run the smoke test with `STAGING_BASE_URL` and `STAGING_LAUNCH_SECRET` in the authorized runner's environment. Supply `VERCEL_AUTOMATION_BYPASS_SECRET` from the deployment's authorized automation setup if the preview is protected.

```sh
node tests/e2e/staging.mts
```

The script checks session issuance, revocation and expiry, physician identity, chart reads, draft creation and review, cross-patient and cross-clinician denial, unauthorized requests and HTTP 501 on delivery. Run `supabase/tests/clinician_access.sql` as a PostgreSQL administrator who can assume the runtime session identity on an isolated database to verify cross-tenant and cross-encounter RLS, immutable approval auditing and denied legacy access. SQL test rows roll back. The HTTP test creates synthetic verification drafts.

Capture the exact commit SHA and deployment link for hosted verification. Staging simulates trusted identity and chart context. Signed SMART tests exercise the protocol with a test issuer. Hospital SSO requires a separate test against the registered EHR.

CI runs the same HTTP test against the production build and a disposable PostgreSQL 17 instance with TLS. Run `bash tests/e2e/run-ci.sh` after `npm run build` on a Linux Docker host.

## M3 durable consultation verification

The CI script also runs `m3-migrations.mts` before starting the app. This harness
requires a fresh, disposable loopback PostgreSQL database and owner connection
in `STETHOLINK_TEST_OWNER_URL`. It creates the test roles, applies every migration,
inserts synthetic pre-M3 records before the M3 migration, and runs both SQL suites.
Use a fresh cluster for each run because roles are cluster-wide. Never use a live
Supabase project or production connection. The synthetic baseline rows remain;
the authorization and lifecycle SQL assertions roll back their own changes.

```sh
STETHOLINK_TEST_OWNER_URL=postgres://postgres@127.0.0.1:5432/postgres node tests/e2e/m3-migrations.mts
```

After the existing staging smoke run, CI stops the app and runs `m3-restart.mts`.
It owns a loopback production-build app process, uses the restricted runtime
connection and trusted test CA, and creates only synthetic verification records.
It checks concurrent create replay, competing edits, metadata hydration, history
and its version cursor, the review and mock delivery lifecycle, recipient denial,
chart isolation, and durable replay after two complete app-process replacements.
The same opaque session must work after replacement; no process memory can supply
the restored draft or session. Only the app is restarted, not PostgreSQL.

These checks verify local production-build persistence and restart behavior.
They do not establish persistence across a hosted Vercel redeployment or a live
Supabase project. Record those checks separately as BLOCKED until an authorized
preview/database environment is available. No production deployment is required.


## M4 clinician approval boundary

CI applies the migrations in order, runs the historical M3 SQL tests against
the M3 schema, then runs `supabase/tests/m4_approval_boundary.sql` against M4.
The SQL suite covers tenant, patient, encounter and clinician isolation,
session expiry, privileges, destination changes between queue and send,
append-only audit records, and one send across replays. The production-build
HTTP tests exercise forged request fields, cross-origin requests, cross-tenant
sessions, approval and editing, and concurrent replay of synthetic delivery.

## M5/M6 routing and specialist response

`tests/e2e/m5-m6-flow.mts` runs the whole synthetic consultation over HTTP against a disposable loopback PostgreSQL: grounded Ahmed draft, approval gate, provider eligibility and allowlist, one durable request under concurrent sends, provider failure and retry, signed callback identity and correlation, duplicate/late/out-of-order callbacks, clinician readback, cross-clinician isolation and two app restarts. `supabase/tests/provider_routing.sql` covers the same rules at the database boundary. Both run in `tests/e2e/run-ci.sh`. Use the `cardiology-demo` staging launch profile for the Ahmed chart.
