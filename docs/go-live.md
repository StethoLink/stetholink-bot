# Go-live runbook

For the first hospital pilot. StethoLink is a plugin inside the EHR: the EHR stays the source of truth, clinicians sign in through it, and every final result is written back to it.

Read with: [data map](data-map.md), [sandbox checks](sandbox.md), [architecture](architecture/ARCHITECTURE.md), [scribe benchmark](ai/scribe-benchmark.md).

## 1. Before anything is installed

| Decision or document | Owner | Needed for |
| --- | --- | --- |
| Hospital approval to process patient data in StethoLink (privacy and security review, PDPL) | Hospital, with you | Everything |
| Where it runs: hospital servers or a cloud region inside the Kingdom | Hospital IT | Hosting |
| Agreement and processing location for the language model | You and the vendor | `MODEL_LIVE_DATA_APPROVED=true` |
| Agreement and processing location for transcription | You and the vendor | `TRANSCRIPTION_LIVE_DATA_APPROVED=true` |
| Patient-consent wording for recording a visit, approved by the hospital | Hospital | The scribe |
| Note type and status the hospital wants for scribe notes (default: progress note, `preliminary`, signed in the EHR) | Hospital medical records | `FHIR_NOTE_TYPE_CODE`, `FHIR_NOTE_DOC_STATUS` |
| List of pilot clinicians and their roles; list of receiving specialist services and their specialists | Hospital | Mappings |

If the model or transcription provider processes data outside the Kingdom and that is not approved, leave its switch `false`. The server then refuses live mode. A deployment of the same models inside the Kingdom, or a self-hosted model with a compatible API, is configured with `OPENAI_BASE_URL` and `TRANSCRIPTION_BASE_URL`.

## 2. Register the SMART application in the EHR

- **Type:** public client, EHR launch, PKCE (S256), OpenID Connect with `fhirUser`.
- **Launch URL:** `https://<host>/api/smart/launch`. **Redirect URL:** `https://<host>/api/smart/callback`.
- **Scopes to request** (SMART v2; for a v1 EHR use `.read` and `.write`):

  | Purpose | Scopes |
  | --- | --- |
  | Sign-in and context | `launch openid fhirUser` |
  | Read the chart | `patient/Patient.rs patient/Encounter.rs patient/Condition.rs patient/MedicationRequest.rs patient/Medication.rs patient/AllergyIntolerance.rs patient/Observation.rs` |
  | Write approved results | `patient/DocumentReference.c patient/AllergyIntolerance.c patient/Condition.c patient/MedicationStatement.c` |

  StethoLink only creates; it never asks for update or delete. A resource the EHR does not grant is shown to the clinician as "could not be loaded" (reads) or offered as text to copy (writes).
- **Launch context:** patient and encounter for clinicians. For specialists, a second launch point without a patient (the application list, or a standalone launch) that opens the inbox.
- **Embedding:** if StethoLink runs inside an iframe, the EHR must (a) allow it to be framed and (b) put `allow="microphone"` on the iframe for the scribe. Without it the scribe tells the clinician to open StethoLink in its own window. Set `COOKIE_MODE=embedded` for the iframe; keep `lax` for a top-level window.
- Take from the EHR: FHIR base URL, authorization and token endpoints, OIDC issuer, JWKS URL, client id.

## 3. Database

PostgreSQL 15 or later, with TLS. Three logins:

| Login | Used by | Rights |
| --- | --- | --- |
| Owner | `scripts/migrate.mjs`, by the operator | Owns the schema |
| `stetholink_runtime` | The application | Only what the migrations grant; row-level security applies |
| `stetholink_maintenance` | `scripts/retention.mjs` | Only `run_retention` |

The migrations create the two roles without passwords. Set them (`alter role stetholink_runtime password '…'`) and store them in the hospital's secret manager.

```bash
STETHOLINK_OWNER_DATABASE_URL=postgres://owner:…@db-host/stetholink node scripts/migrate.mjs
```

Apply the migrations of a release before starting that release.

## 4. Configuration for the first pilot

Set as environment variables or secrets of the container. Values in angle brackets come from the steps above.

```
NODE_ENV=production
TENANT_ID=<hospital-id>
CLINICAL_DATA_SOURCE=fhir
COOKIE_MODE=embedded

STETHOLINK_DATABASE_URL=postgres://stetholink_runtime:<password>@<db-host>/stetholink
STETHOLINK_DATABASE_CA=<PEM of the database CA, if it is not a public one>
SESSION_ENCRYPTION_KEY=<openssl rand -base64 32>

FHIR_BASE_URL=<FHIR base, exactly as the EHR sends it as iss>
SMART_CLIENT_ID=<client id>
SMART_AUTHORIZATION_URL=<authorization endpoint>
SMART_TOKEN_URL=<token endpoint>
SMART_REDIRECT_URI=https://<host>/api/smart/callback
SMART_OIDC_ISSUER=<issuer>
SMART_JWKS_URL=<JWKS URL>
SMART_SCOPE=<the three scope groups above, space separated>
SMART_CLINICIAN_MAP=[{"subject":"<sub>","fhirUser":"Practitioner/<id>","clinicianId":"<new UUID>","role":"physician"}]

AI_PROVIDER=openai
OPENAI_API_KEY=<key>
OPENAI_BASE_URL=<only for a regional or self-hosted endpoint>
OPENAI_MODEL=<model for consultations>
OPENAI_INPUT_USD_PER_MILLION=<verified rate>
OPENAI_OUTPUT_USD_PER_MILLION=<verified rate>
MODEL_LIVE_DATA_APPROVED=true
AI_DAILY_BUDGET_USD=<daily ceiling for the tenant>

SCRIBE_ENABLED=true
TRANSCRIPTION_PROVIDER=openai
TRANSCRIPTION_MODEL=gpt-transcribe
TRANSCRIPTION_USD_PER_MINUTE=<verified rate>
TRANSCRIPTION_LIVE_DATA_APPROVED=true
SCRIBE_NOTE_MODEL=gpt-5-mini
SCRIBE_NOTE_INPUT_USD_PER_MILLION=<verified rate>
SCRIBE_NOTE_OUTPUT_USD_PER_MILLION=<verified rate>
SCRIBE_TRANSCRIPT_RETENTION_DAYS=7

EHR_WRITE_ENABLED=true
FHIR_NOTE_DOC_STATUS=preliminary

PROVIDER_DIRECTORY=[{"id":"cardiology-service","displayName":"Cardiology consult service","specialties":["Cardiology"],"transport":"portal"}]
PROVIDER_ALLOWLIST=cardiology-service
SPECIALIST_MAP=[{"specialistId":"<new UUID>","providerId":"cardiology-service","displayName":"Dr <name>","subject":"<sub>","fhirUser":"Practitioner/<id>"}]
```

Every optional setting and its default is in `.env.example`. A live configuration that is incomplete stops the server at start with a message naming the setting.

**Clinicians and specialists.** `subject` and `fhirUser` are the values in the ID token the EHR signs for that person; the hospital's EHR administrator supplies them. Give each person a new UUID once and keep it. Every mapped clinician can read, record and draft; only `role: "physician"` can approve, send and write to the chart. Removing an entry and restarting ends that person's access; open sessions end within 15 minutes (specialists: 30).

## 5. Run

```bash
docker build -t stetholink:<version> .
```

```bash
docker run -d --name stetholink --env-file /etc/stetholink/env -p 127.0.0.1:3000:3000 --restart unless-stopped stetholink:<version>
```

Put the hospital's TLS reverse proxy in front (HTTPS only, public name = `<host>`). The proxy must pass the `Host` header and should not log query strings of `/api/smart/*`. The container runs as a non-root user, needs no writable disk, and reports health at `/api/health`. More than one container may run behind the proxy: sessions, the spend ledger and all records are in PostgreSQL. The request limits are per container.

Daily, from cron or a scheduler:

```bash
docker run --rm -e STETHOLINK_MAINTENANCE_DATABASE_URL=postgres://stetholink_maintenance:…@db-host/stetholink -e RETENTION_SCRIBE_DAYS=30 -e RETENTION_CONSULTATION_DAYS=365 -e RETENTION_LEDGER_DAYS=400 stetholink:<version> node scripts/retention.mjs
```

## 6. Logs

The application writes one JSON line per event to standard output: launches refused, model and transcription calls (model, task, tokens, cost, latency, outcome), dispatches, callbacks, chart writes (item key, resource type, EHR record id, outcome), retention counts. No clinical content, prompt, transcript, token or key is logged. Collect them with the hospital's log system and keep them for the period the hospital requires for audit (commonly one year or more); the reverse proxy's access log should drop query strings.

## 7. Key rotation

`SESSION_ENCRYPTION_KEY`: set a new key, move the old one to `SESSION_ENCRYPTION_KEYS_PREVIOUS`, restart, and remove the old key an hour later. Model, transcription and database credentials: replace the secret and restart; nothing stored depends on them.

## 8. Rollback

- **Application:** start the previous image tag. Sessions are short, so clinicians relaunch from the chart.
- **Database:** migrations only add tables, functions and grants; they do not rewrite stored rows. The previous application version runs against the newer schema, except across a release whose notes say otherwise (see *Interface changes* on the workboard). Do not drop tables to roll back; restore from backup only if data is damaged.
- **Feature switches**, without a new image: `SCRIBE_ENABLED=false`, `EHR_WRITE_ENABLED=false` (items are then offered as text to copy), `PROVIDER_ALLOWLIST=` (no sending). There is no switch that turns the assistant off while keeping the chart: `CLINICAL_DATA_MODE=synthetic` no longer exists and stops the server at start. To stop model use, stop the application.
- What was written to the EHR stays there. It was created under the physician's name and is corrected in the EHR.

## 9. Pilot checklist

Technical, with a test patient in the hospital's test EHR first:

- [ ] Launch from a chart opens StethoLink with the right patient, visit and "Real patient data"
- [ ] A user who is not mapped is refused; a nurse can draft and cannot approve
- [ ] Chart record shows problems, medicines, allergies, vital signs and results that match the EHR; anything not loaded is listed
- [ ] A visit that is `arrived` or `triaged` opens; a cancelled-in-error visit is refused with its reason
- [ ] Consultation: every statement opens its source; approval and sending each show their confirmation
- [ ] The specialist opens the inbox from the EHR, sees no patient identifiers, accepts and replies; the physician sees the reply
- [ ] "Write to chart" creates the notes in the EHR once; repeating it creates nothing more
- [ ] Scribe: the microphone works in the EHR window (or the "open in a new window" message appears); recording does not start without the consent confirmation
- [ ] A recorded test visit produces a note; a new allergy is offered unselected; a conflict with the chart is shown and cannot be selected
- [ ] The approved note and the selected allergy appear in the EHR, authored by the physician, for the right visit; the transcript is gone from StethoLink
- [ ] Removing a write scope turns that item into "Copy to chart"
- [ ] The session ends after 15 minutes with the "reopen from the chart" message
- [ ] The retention job runs and reports counts
- [ ] Logs contain no patient data (search them for the test patient's name and record number)

Clinical, before real patients:

- [ ] Transcription quality measured on consented recordings of scripted visits in the clinic's own conditions (`scripts/scribe-benchmark.mjs`)
- [ ] Pilot physicians reviewed at least 20 notes and 20 consultations on test patients and reported every wrong, missing or invented statement
- [ ] A named physician lead and a route for reporting a problem during the pilot
- [ ] Clinicians know: the note is a draft until they approve it; a conflict with the chart is theirs to resolve in the EHR; "copy to chart" means it was not written

## 10. Not done yet

- Refresh of the EHR token: a session ends after 15 minutes and the clinician reopens from the chart.
- A real email service for specialist sign-in codes (`EMAIL_PROVIDER` has only the development printer). Specialists sign in from the EHR.
- A partner API to an outside provider (`integrations/providers/http-partner.ts` exists and is not registered).
- Verification against the hospital's own EHR; so far a fake SMART server and a real HAPI FHIR server were used ([sandbox checks](sandbox.md)).
