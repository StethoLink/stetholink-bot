# Data map

What StethoLink handles, where it is kept, for how long, who can reach it and which outside party receives it. The EHR is the only source of truth: StethoLink keeps working data (drafts, a temporary transcript, audit records) and writes every final result back to the EHR.

Nothing here depends on a particular cloud. The application is one container and one PostgreSQL 15+ database, and can run on the hospital's own servers or in a cloud region inside Saudi Arabia.

## What is stored

| Data | Where | How long | Who can read it |
| --- | --- | --- | --- |
| Patient chart (demographics, problems, medicines, allergies, results) | **Not stored.** Read from the EHR for each request with the clinician's own token and held in memory | Length of the request | The signed-in clinician, for the launched patient and visit only |
| Chart facts used in a consultation draft (labels, values, dates, EHR record references) | PostgreSQL `consultation_drafts.clinical_metadata`, `consultation_revisions` | Until retention removes the consultation (`RETENTION_CONSULTATION_DAYS`; unset keeps it) | The clinician who created it, in the same tenant, patient and visit (row-level security) |
| Consultation text, approvals, lifecycle events | PostgreSQL `consultation_drafts`, `consultation_approvals`, `consultation_events`, `consultation_revisions` | As above | As above. Append-only for the application |
| Request sent to a specialist (approved text with age and sex, cited facts under opaque ids; no name, birth date or chart identifier) | PostgreSQL `consultation_delivery_attempts.envelope` | As above | The sending clinician; the specialists registered for the receiving service |
| Specialist's reply | PostgreSQL `consultation_provider_responses` | As above | The sending clinician; the replying service |
| Visit audio | **Never stored.** Each 20 to 30 second part is held in server memory, sent to the transcription provider and dropped | Seconds | Nobody |
| Visit transcript | PostgreSQL `scribe_segments` | Deleted when the note is written to the chart, otherwise after `SCRIBE_TRANSCRIPT_RETENTION_DAYS` (default 7) by the retention job; at once when the clinician discards the visit | The recording clinician, same tenant, patient and visit |
| Visit note draft and proposed chart items | PostgreSQL `scribe_sessions.note` | Until `RETENTION_SCRIBE_DAYS` after the visit is closed (unset keeps it) | As above |
| Patient-consent statement and scribe audit (who, when, counts, outcomes; no clinical text) | PostgreSQL `scribe_sessions`, `scribe_events` | With the visit record | As above. Append-only for the application |
| Record of what was written to the EHR (resource type, EHR record id, outcome) | PostgreSQL `chart_writes` | With its consultation or visit; otherwise `RETENTION_LEDGER_DAYS` | The physician who wrote it, same chart |
| Browser session (clinician id, role, patient and visit ids, **EHR access token**) | PostgreSQL `stetholink_private.browser_sessions`, encrypted with AES-256-GCM (`SESSION_ENCRYPTION_KEY`) | 15 minutes; expired rows are deleted at the next launch and by the retention job | The server only. The browser holds an opaque random handle in an HTTP-only cookie |
| Specialist session (specialist id, service; no patient, no EHR token) | Same table, encrypted | `SPECIALIST_SESSION_MINUTES` (default 30) | The server only |
| One-time sign-in code for a specialist | Same table, as a hash | 10 minutes, single use | The server only |
| Spend ledger (amount, task name, day) | PostgreSQL `stetholink_private.usage_ledger` | `RETENTION_LEDGER_DAYS` (unset keeps it) | Database owner |
| Clinician and specialist mappings, provider directory | Server configuration (`SMART_CLINICIAN_MAP`, `SPECIALIST_MAP`, `PROVIDER_DIRECTORY`) | Until changed by the operator | Operator |

## What leaves the server

| Recipient | What it receives | What it never receives | Switch |
| --- | --- | --- | --- |
| The hospital EHR (FHIR) | Reads with the clinician's token. Creates, after physician approval only: the visit note, the approved consultation, the specialist's reply (`DocumentReference`), and the items the physician selected (`AllergyIntolerance`, `Condition`, `MedicationStatement`) | Any update or delete; anything the physician did not select | `EHR_WRITE_ENABLED` and the write scopes in `SMART_SCOPE` |
| Language model provider (consultations and visit notes) | The physician's request and answers, normalized chart facts under opaque ids, age (top-coded at 90) and sex, the visit transcript | Name, birth date, record numbers, EHR record references, the EHR token | `MODEL_LIVE_DATA_APPROVED=true`; endpoint set with `OPENAI_BASE_URL` |
| Transcription provider | Audio of the visit in parts, the spoken language, and medicine, problem and allergy names from the chart as recognition hints | Who the patient or clinician is; any identifier | `TRANSCRIPTION_LIVE_DATA_APPROVED=true`; endpoint set with `TRANSCRIPTION_BASE_URL` |
| Receiving specialist (inside the plugin) | The approved consultation text with age and sex, and the cited facts | Name, birth date, chart identifiers, EHR record references, uncited chart facts | `PROVIDER_DIRECTORY`, `PROVIDER_ALLOWLIST` |
| Email service (specialist sign-in codes) | The specialist's address, a one-time code and a link | Anything about a patient or a request | `EMAIL_PROVIDER` (off by default; no real mail service is implemented yet) |
| Application logs (standard output) | Structured events with identifiers, counts, model and task names, token counts, cost, latency and reason codes | Chart content, transcript, note or consultation text, prompts, model output, audio, tokens, keys, OAuth parameters | Collect and retain according to hospital policy |

Speech and chart content do leave the server for the model and transcription providers. Until those providers process the data inside the Kingdom, or an agreement and approval covers processing elsewhere, the two approval switches stay `false` and the server refuses to start in live mode.

## Deleting

- **Retention job** (`scripts/retention.mjs`, daily, run with the maintenance database login): expired sessions and codes, transcripts past their date, and, where a period is set, closed visits, finished consultations and ledger rows. It outputs counts only.
- **Discard** in the scribe screen deletes a transcript and draft note at once.
- What was written to the EHR is not affected: it is the hospital's record and follows the hospital's retention.
- Database backups hold what the database held when they were taken. Set backup retention no longer than the longest period above.
