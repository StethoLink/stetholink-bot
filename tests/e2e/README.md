# End-to-end checks

StethoLink has one mode, so there is one end-to-end flow. It runs the production build against servers the test starts itself. Every fake server and every fictional record lives under `tests/`; the product contains none of them.

```sh
npm run build
bash tests/e2e/run-ci.sh     # Linux with Docker
```

`run-ci.sh` starts a disposable PostgreSQL 17 bound to loopback, applies every migration and runs the SQL suites (`m3-migrations.mts`), switches TLS on, then runs `live-ehr-flow.mts`. CI runs the same script.

## Migrations and SQL suites

`m3-migrations.mts` needs a fresh, disposable loopback database and its owner connection in `STETHOLINK_TEST_OWNER_URL`. It creates the test roles, applies every migration in order and runs the suites in `supabase/tests/` at the migration each belongs to: tenant, patient, encounter and clinician isolation, session expiry, the approval boundary, one send across replays, append-only audit records, provider routing, data classification, the scribe and chart-write ledger, and retention. Use a fresh cluster for each run because roles are cluster-wide. Never point it at a hosted or production database. Rows the suites insert are fictional.

```sh
STETHOLINK_TEST_OWNER_URL=postgres://postgres@127.0.0.1:5432/postgres node tests/e2e/m3-migrations.mts
```

## The flow with fake servers

`tests/e2e/live-ehr-flow.mts` starts the production build against: a fake SMART and OpenID issuer that signs real ES256 ID tokens, a fake FHIR R4 server with one invented patient and conditional create, a fake transcription endpoint, a fake model endpoint (`tests/e2e/fakes/`), and the disposable PostgreSQL (`STETHOLINK_DATABASE_URL` must be a loopback address). Over HTTPS on loopback it checks, in order:

1. **Fail closed.** The server does not start without model approval, a model key, an EHR data source or the SMART registration, and not with any removed stand-in: `AI_PROVIDER=mock`, `CLINICAL_DATA_SOURCE=synthetic`, `CLINICAL_DATA_MODE=synthetic`, `AUTH_MODE=dev` or `staging`, `TRANSCRIPTION_PROVIDER=mock`, `MOCK_RECIPIENT_IDS`.
2. No session without the EHR launch; the removed staging launch, staging page, demo route and simulator route answer 404.
3. SMART launch and role mapping, chart facts, a draft that cites FHIR facts with nothing identifying in the model request, replay of the same request, physician approval and the allowlist.
4. Scribe consent, parts and note; nothing reaches the EHR before approval and exactly the selected items after it.
5. Sending to a directory service over the `portal` transport, specialist sign-in (SMART without a patient, and the email code), inbox isolation between services, accept and report, the physician reading the reply, the request and reply written to the chart once as `DocumentReference`.
6. **Restart.** After a new server process the same session cookie still works, and the draft and its delivery read back unchanged; another clinician still cannot read them.
7. Refusal of a visit that cannot be used.

`LIVE_TEST_APP_PORT` (default 3081) moves the three ports it uses. Run outside `run-ci.sh`, it needs what that script prepares: a production build, a fresh migrated database that accepts TLS, `STETHOLINK_DATABASE_URL` with host `localhost` and the database certificate in `STETHOLINK_DATABASE_CA`; against a database without TLS the launch answers 500.

It verifies the protocol and the boundaries with fictional data. **It does not verify a real EHR, a real model, real transcription or real email delivery.** Those are `real-fhir-check.mts` (a real HAPI FHIR server), the opt-in tests in `tests/backend/*-live.test.ts` (a real model, fictional charts) and the OpenEMR run in [docs/openemr.md](../../docs/openemr.md).

With `LIVE_E2E_BROWSER=1` the same run opens the stored sessions in Chromium (needs Playwright, which is not a project dependency): the specialist inbox list and one request (no patient name appears), the physician's workspace with the "Real patient data" badge, the history, the specialist's reply and the "In the chart" status, no simulation controls, and a chart session being refused at `/inbox`. `BROWSER_SCREENSHOT_DIR` saves `inbox-list.png`, `inbox-request.png` and `live-consultation.png`.

## What was removed with the synthetic mode (OpenEMR brief, T3)

These scripts drove the staging launch, the mock model and the simulated specialist, which no longer exist: `staging.mts`, `m3-persistence.mts`, `m3-restart.mts`, `m5-m6-flow.mts`, `m7-assistant-flow.mts`, `run-local-m3.sh`, `browser/consultation-flow.mjs`, `browser/scribe-flow.mjs`. Of what they covered over HTTP, the flow above keeps launch, drafting, approval, routing, replies and restart. It does **not** repeat over HTTP: concurrent create replay and competing edits, the history version cursor, natural-language revision, signed provider callbacks (no provider uses them now), provider failure and retry, and the browser walk-through of the consultation and scribe screens at 360 px. The SQL suites and the unit tests (`tests/backend/provider-routing.test.ts`, `referral-authoring.test.ts`, `scribe.test.ts`, `tests/frontend/*`) still cover those rules below the HTTP layer.
