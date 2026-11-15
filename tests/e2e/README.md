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

## Consultation assistant

`tests/e2e/m7-assistant-flow.mts` runs the natural-language request, revision, approval, routing and history over HTTP with the deterministic mock. It checks the workflow and its boundaries, not model quality. `tests/e2e/browser/consultation-flow.mjs` walks the same path in Chromium against a running synthetic staging app (`STAGING_BASE_URL`, `STAGING_LAUNCH_SECRET`; needs Playwright, which is not a project dependency). With `EXPECT_LIVE_MODEL=1` it requires a model-written draft. The specialist is always the simulated provider. Live model tests are described in the [assistant guide](../../docs/ai/consultation-assistant.md).

## Live code path with fake servers

`tests/e2e/live-ehr-flow.mts` is the last step of `tests/e2e/run-ci.sh`. It starts the production build in `CLINICAL_DATA_MODE=live` against servers it runs itself: a fake SMART and OpenID issuer that signs real ES256 ID tokens, a fake FHIR R4 server with one invented patient and conditional create, a fake transcription endpoint, a fake model endpoint, and the disposable PostgreSQL (`STETHOLINK_DATABASE_URL` must be a loopback address). Session encryption and the durable spend ledger are switched on. Over HTTPS on loopback it checks, in order: SMART launch and role mapping, chart facts, a draft that cites FHIR facts, physician approval, scribe consent, parts and note, that nothing reaches the EHR before approval and exactly the selected items after it, sending to a directory service over the `portal` transport, specialist sign-in (SMART without a patient, and the email code), inbox isolation between services, accept and report, the physician reading the reply, the request and reply written to the chart once as `DocumentReference`, and refusal of a visit that cannot be used. `LIVE_TEST_APP_PORT` (default 3081) moves the three ports it uses.

It verifies the protocol and the boundaries with fictional data. It does not verify a real EHR, a real model or real email delivery.

With `LIVE_E2E_BROWSER=1` the same run opens the stored sessions in Chromium (needs Playwright, which is not a project dependency): the specialist inbox list and one request (no patient name appears), the physician's live workspace with the "Real patient data" badge, the history, the specialist's reply and the "In the chart" status, no simulation controls, and a chart session being refused at `/inbox`. `BROWSER_SCREENSHOT_DIR` saves `inbox-list.png`, `inbox-request.png` and `live-consultation.png`.

```sh
LIVE_E2E_BROWSER=1 BROWSER_SCREENSHOT_DIR=out NODE_PATH=<directory holding playwright> node tests/e2e/live-ehr-flow.mts
```

## Real FHIR server (opt-in)

`tests/e2e/real-fhir-check.mts` is not part of CI. It runs the product's FHIR connector and writer against a real server implementation, HAPI FHIR JPA Server in Docker, on a loopback port: it loads the fictional chart, reads it back with a small page size so that search, `_include`, sorting and the server's own paging links are real, and creates each supported resource type by conditional create, repeating the create to confirm the existing record is returned. HAPI has no SMART authorization, so the launch is covered only by `live-ehr-flow.mts`. The commands are at the top of the file and in [the sandbox guide](../../docs/sandbox.md).

```sh
HAPI_URL=http://127.0.0.1:8090/fhir node tests/e2e/real-fhir-check.mts
```

## Scribe in a browser

`tests/e2e/browser/scribe-flow.mjs` walks the scribe in Chromium against a running synthetic staging app started with `SCRIBE_ENABLED=true` (`STAGING_BASE_URL`, `STAGING_LAUNCH_SECRET`; needs Playwright). Chromium's fake microphone supplies the sound; `SCRIBE_FAKE_AUDIO` names a WAV file to play, which should contain speech followed by a pause so that a part is cut. It checks the consent gate, the recording indicator, pause and resume, a part uploaded while the visit continues, the note with its sources, that no proposed item is selected by default, the approval dialog, the "Copy to chart" result (synthetic data is never written to an EHR) and the visit in the history. Transcription and the note are the deterministic stand-ins and are labelled as such on screen, so this checks the interface and the workflow, not transcription or note quality. `BROWSER_WIDTH` (default 420) and `BROWSER_SCREENSHOT_DIR` work as in the consultation walkthrough.

```sh
STAGING_BASE_URL=http://127.0.0.1:3100 STAGING_LAUNCH_SECRET=<secret> SCRIBE_FAKE_AUDIO=/path/to/speech.wav node tests/e2e/browser/scribe-flow.mjs
```

## Scribe and operations SQL suites

`m3-migrations.mts` runs two more suites as it applies the migrations; both use fictional rows and roll back.

- `supabase/tests/scribe.sql` (after `chart_writes`): a visit, its transcript and its events are visible only to the same tenant, clinician, patient, visit and data classification; consent must be recent; transcript words and the audit trail cannot be edited or deleted; approval exists only through the command, only for a physician with `chart:write`, only at the current version and only once; an item that conflicts with the chart, is already in it or is not in the note cannot be selected; nothing can be written before approval, an unselected item or a reused key is refused, the write ledger cannot be inserted into directly, and the transcript is deleted when the note is recorded as written.
- `supabase/tests/operations.sql` (after `retention`): the spend ledger refuses a reservation over the daily limit and a negative amount, keeps the first settlement and caps it at the reservation, and cannot be read by the application; the retention function can be run only by the maintenance role, which cannot read clinical tables; expired sessions and transcripts are always removed and the removal is audited; visits are removed only when a period is set, never below one day, with their audit trail; consultation history cannot be edited even by the owner.
