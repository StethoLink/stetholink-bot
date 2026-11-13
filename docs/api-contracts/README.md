# API Contracts v1.1.0

Human-readable mirror of `shared/contracts` (types), `shared/schemas` (validation), and `apiRoutes`.
Keep this reference aligned with the contracts.

Every non-2xx response is an `ApiError`: `{ "error": { "code": ApiErrorCode, "message": string, "requestId"?: string } }`.
Clinical routes require a verified clinician session. The health and authentication bootstrap endpoints are public.

| # | Method | Path | Request body | 2xx response | Status |
|---|---|---|---|---|---|
| 1 | GET | `/api/health` | — | `{ status: "ok", contractVersion }` | ✅ implemented |
| 2 | POST | `/api/chat` | `ChatRequest` | `ChatResponse` | ✅ mock provider |
| 3 | GET | `/api/patients/:patientId/context` | — | `PatientContext` | Synthetic or read-only SMART sandbox |
| 4 | GET | `/api/encounters/:encounterId` | — | `EncounterContext` | Synthetic or read-only SMART sandbox |
| 5 | POST | `/api/consultations/drafts` | `CreateConsultationDraftRequest` | `ConsultationDraft` (201) | Synthetic context with Supabase or development persistence |
| 6 | GET | `/api/consultations/drafts/:draftId` | — | `ConsultationDraft` | ✅ clinician-owned rows |
| 7 | POST | `/api/consultations/drafts/:draftId/approval` | `ApprovalRequest` | `ConsultationDraft` | Atomic in Supabase |
| 8 | POST | `/api/consultations/drafts/:draftId/delivery` | `DispatchRequest` | `ConsultationDeliveryView` | Synthetic providers; see M5/M6 below |
| 9 | GET | `/api/consultations/drafts/:draftId/delivery` | — | `ConsultationDeliveryView\|null` | Clinician-owned draft |

## Types

```ts
type ConsultationStatus = "draft" | "pending_approval" | "approved" | "rejected" | "archived";

interface PatientContext   { patientId; displayName; birthDate?; sex; allergies[]; activeProblems[]; medications[]; source: "synthetic"|"fhir"|"openemr"|"ehr"; clinicalFacts?: ClinicalFact[] }
interface EncounterContext { encounterId; patientId; type; status; startedAt; location?; reasonForVisit?; clinicalFacts?: ClinicalFact[] }
interface ChatRequest      { message; conversationId?; patientId?; encounterId? }      // message: 1..8000 chars
interface ChatResponse     { conversationId; message: ChatMessage; safety: SafetyAssessment; requiresClinicianReview }
interface ConsultationDraft{ id; patientId; encounterId?; status; summary; assessment; plan[]; generatedBy:"ai"; createdAt; updatedAt; reviewedBy?; reviewedAt?; approvedRecipientId?; clinicalFacts?: ClinicalFact[]; missingInformation?: MissingInformation[]; attachments?: AttachmentReference[] }
interface ApprovalRequest  { draftId; decision: "approve"|"reject"|"request_changes"; recipientId?; expectedVersion; idempotencyKey }
interface ApiError         { error: { code; message; requestId? } }
```

## M1 normalized clinical contracts

These additions preserve M0 payloads and fixtures. They introduce no HTTP routes, authentication mechanisms, approval actions or delivery actions. The existing `CreateConsultationDraftRequest` remains the HTTP generation input; `ConsultationRequest` describes normalized consultation intent for future Core consumers.

| Contract | Fields and meaning |
|---|---|
| `ClinicalSource` | `{ type: "synthetic"\|"fhir"\|"openemr"\|"ehr", reference }`; reference is an opaque record/fixture identifier, without credentials or authenticated URLs. |
| `ClinicalFact` | `{ id, category, label, source, timestamp }` plus either `{ status: "known", value: string\|number\|boolean, unit? }` or `MissingInformation`. Categories: problem, medication, allergy, symptom, vital_sign, investigation, history. |
| `MissingInformation` | A fact with `{ status: "unknown", reason: "not_recorded"\|"not_provided"\|"not_performed"\|"pending" }`. Results and units are rejected, including `null` and zero results. |
| `ConsultationRequest` | `{ patientId, encounterId?, specialty, clinicalQuestion, attachments? }`. Requires a nonblank specialty and question. Rejects identity, approval and delivery fields. |
| `ClinicianIdentity` | `{ clinicianId, roles: ("clinician"\|"admin")[], providerId? }`; a projection of a verified server session, without tokens. Parsing the shape is not authentication. Never accept it as client authority. |
| `ProviderId` | Nonblank opaque clinical provider/recipient ID, at most 128 characters. Does not grant recipient authorization. |
| `AttachmentReference` | `{ id, contentType, description?, source, timestamp }`; metadata only. No URL, content bytes, upload or transfer behavior. |
| `ApiError` / `ApiErrorCode` | Reuses the existing envelope and error codes without introducing vendor error payloads. |

Fact timestamps mark when the assertion was documented. For an unknown investigation, the timestamp is **not** a specimen, test or result time. Known `false` and `0` values are preserved. Unknown does not mean negative, normal, or never performed. Empty legacy lists and absent `clinicalFacts` do not establish absence of disease, medication use or allergies. New clinical fact, intent, identity and attachment schemas reject unexpected fields. Existing HTTP schemas retain their M0 behavior, including stripping caller-supplied identity from approval requests.

`shared/contracts/clinical-data.ts` defines the normalized read-only `ClinicalDataAdapter` port: `source`, `getPatient(patientId): Promise<PatientContext | null>` and `getEncounter(encounterId): Promise<EncounterContext | null>`. `null` means no matching record; unavailability rejects rather than inventing a record. The mock in `integrations/mock/connector.ts` implements both this shared port and Core's existing structurally compatible connector interface. It validates outputs and returns fresh copies, preserving nested provenance and unknown facts. The Core interface's optional consultation transport remains separate from the normalized read contract. No Core source changes or vendor imports are required.

### Fictional Ahmed case

`shared/mocks/synthetic-data.ts` retains `syn-pt-001` and `syn-pt-002` unchanged, and adds `syn-pt-ahmed` and matching `syn-enc-ahmed`. Ahmed has known hypertension and type 2 diabetes, with documented metformin and amlodipine names. Doses, schedules, birth date and lab results are not fabricated. Allergy history, current blood pressure, ECG, troponin, HbA1c, renal function and lipid profile are explicitly unknown (`not_provided`). No test results or attachments are supplied. Every clinical fact retains source `synthetic-case-ahmed-v1` and its fictional documentation timestamp. The exported `ahmedConsultationRequest` requests cardiology review without approving or sending anything.

M1 contract tests cover fixture validation, source/timestamp round trips, explicit missing investigations, rejection of contradictory facts, adapter/Core compatibility, mutation isolation, missing records and adapter failures. Module-boundary tests check all Core and shared contract dependencies, including type imports, re-exports and dynamic imports, to prevent vendor, persistence, UI or framework dependencies.

```sh
npx vitest run tests/backend/contracts.test.ts tests/backend/clinical-adapter-contract.test.ts tests/backend/clinical-boundaries-contract.test.ts
npm run check
node --test tests/smoke/*.test.mts
npm run build
```

## Semantics
- **Approval transitions:** `pending_approval|draft` + approve → `approved`, + reject → `rejected`, + request_changes → `draft`. Any other state returns `409 conflict`.
- `reviewedBy` / `reviewedAt` are set by the server from the session and are ignored if a client sends them.
- Synthetic development uses an in-memory repository. Staging uses PostgreSQL persistence scoped to the verified tenant, clinician, patient and encounter.
- Delivery requires a physician, an approved draft and an eligible provider on the tenant allowlist. See M5/M6 below.
- Generation supports synthetic patient/encounter context. `conversationId` is rejected with 400 until conversation persistence is implemented. An encounter must belong to the requested patient.
- The EHR opens `/api/smart/launch`, then returns to `/api/smart/callback`. `GET /api/auth/session` returns verified identity and chart context, and `POST /api/auth/logout` revokes the session. Preview staging uses the secret-gated `POST /api/staging/launch` route.
- `safety.level === "blocked"` means `message.content` is a withheld notice, not model output.
- Error code → HTTP status: invalid_request 400 · unauthenticated 401 · forbidden 403 · not_found 404 · conflict 409 · safety_blocked 422 · internal_error 500 · not_implemented 501 · provider_unavailable 503.

## Client
`@/shared/api-client` exports `StethoLinkApiClient`, `createMockApiClient()` (synthetic, in-memory, follows the same rules as above), `createHttpApiClient()` (validates every response), and `getApiClient()` (selected by `NEXT_PUBLIC_API_MODE`).

## M2 grounded synthetic consultation drafting

`ModelProvider` now supports an optional structured-output schema and a server-set synthetic classification. The consultation service uses the existing `SYSTEM_INSTRUCTIONS` and `PROMPT_VERSION` unchanged. Both the deterministic mock and OpenAI use the same output validation. A model's provider name cannot bypass validation.

The model receives normalized synthetic facts, eligible evidence IDs and conflict groups only. Demographics, clinician identity, credentials, legacy clinical lists, free-text consultation intent, chat and attachments are excluded. Context is capped at 64 unique facts and 24,000 UTF-8 bytes; excess input is rejected rather than truncated. Non-synthetic adapters, patients or fact sources are rejected before model access. Adapter records, patient/encounter association, intent and HTTP output are validated.

The structured model output is `{ evidenceIds: string[] }`. It may order documented, nonconflicting known evidence; it must retain every eligible fact. Core renders clinical assertions directly from the referenced source facts. Free-form model clinical claims, unexpected properties, fabricated or unknown evidence IDs, duplicate IDs, omitted facts and conflicting assertions selected as established evidence are rejected. This intentionally conservative extractive MVP does not generate diagnoses or treatment orders. It is not a clinically validated relevance or conflict-detection system: conflicting assertions with the same category and normalized label are flagged without resolving them; synonyms and implicit clinical contradictions still require physician review.

`ConsultationDraft` gains an optional, backward-compatible `grounding` object:

```ts
{
  reason: string | null;                 // documented encounter reason
  question: string | null;               // trusted normalized consultation intent
  specialty: string | null;              // trusted normalized consultation intent
  evidenceIds: string[];                 // IDs into clinicalFacts; each fact has source/timestamp
  gaps: string[];                        // explicit unknowns and completeness checks
  conflicts: string[][];                 // unresolved source fact IDs
  safetyFlags: ("clinician_review_required" | "conflicting_facts" |
    "missing_investigations" | "incomplete_referral" | "insufficient_clinical_data")[];
  provenance: { provider; model; promptVersion; contextVersion;
    dataClassification: "synthetic" | "live"; encounterReference: string | null };
}
```

Drafts preserve `clinicalFacts` and `missingInformation`, including unknown investigations with no value or unit. Missing intent is `null`; missing investigation results are explicitly unknown. Empty legacy lists are never interpreted as negative findings. Legacy patients without normalized facts receive an insufficient-data flag; Core does not manufacture fact timestamps from their lists. False and zero source values are retained. Ahmed's original fixture is unchanged, including all unknown investigation results.

`POST /api/consultations/drafts` retains its existing input and authenticated persistence workflow. Its summary, assessment and plan contain grounded source citations, gaps, safety flags and prompt/provider provenance. M3 now persists and hydrates the typed M2 metadata on later reads, approvals and revision snapshots. Older drafts without typed metadata remain readable without inventing missing metadata. The staging preview below returns the complete typed draft without persistence.

### Protected staging demo

`POST /api/consultations/demo` accepts **no request body** and returns a validated `ConsultationDraft` (200) for the fixed fictional Ahmed cardiology case. It calls the existing verified clinician-session path, uses M0.5’s verified host-launch identity with an active, unexpired clinician or physician context, and rejects the development-auth bypass. Open the Ahmed fixture with the secret-gated synthetic staging profile `same-clinician-other-chart`. Same-origin cookie protection is inherited from the existing session guard.

The demo runs on Vercel `VERCEL_ENV=preview` (or authenticated local development). It is disabled on Vercel production and on production runtimes without the preview marker. It requires the synthetic tenant connector, cannot access stored drafts, and has no approval, persistence or delivery capability. Vercel preview deployment protection remains enabled; no production settings need to change.

### OpenAI controls and verification

The existing server-only `AI_PROVIDER=openai`, `OPENAI_API_KEY` and `OPENAI_MODEL` select OpenAI. Missing credentials fail closed; mock is the default. Requests use the Responses API with strict JSON Schema and `store:false`, following [official structured-output documentation](https://developers.openai.com/api/docs/guides/structured-outputs). OpenAI is restricted to structured synthetic consultation requests; unclassified/unstructured chat cannot use it.

| Optional server configuration | Default / behavior |
|---|---|
| `OPENAI_TIMEOUT_MS` | 30000; shared request/body/backoff deadline, maximum 60000 |
| `OPENAI_MAX_RETRIES` | 1; maximum 2; only HTTP 429/500/502/503/504, bounded exponential backoff |
| `OPENAI_MAX_INPUT_TOKENS` | 16000; conservative serialized UTF-8 byte bound plus 512 tokens of overhead, maximum 32000 |
| `OPENAI_MAX_OUTPUT_TOKENS` | 2048; maximum 4096 |
| `OPENAI_MAX_COST_USD` | 0.1 per generation, maximum 1; reserves the worst-case charge before each attempt, including failed attempts |
| `OPENAI_INPUT_USD_PER_MILLION`, `OPENAI_OUTPUT_USD_PER_MILLION` | No default. Operator must supply verified upper-bound rates for the configured model; missing rates block live calls. Test rates are hypothetical. |

The budget is an application estimate using operator-supplied rates, not an account-wide billing limit. No model price is guessed. Network ambiguity, timeouts, malformed responses, refusals, incomplete responses and permanent HTTP failures are not retried. Responses are bounded at 64,000 bytes; usage must fit reserved input and output limits. All provider failures are sanitized; credentials, patient/model payloads and provider error bodies are never logged. Provider deadline includes retries; token/cost reservations are per generation, not durable tenant quotas.

```sh
npx vitest run tests/backend/grounded-drafting.test.ts tests/backend/openai-provider.test.ts tests/backend/consultation-demo.test.ts
npm run check
node --test tests/smoke/*.test.mts
npm run build
```

The separate `tests/backend/openai-synthetic-live.test.ts` runs only when `RUN_OPENAI_SYNTHETIC_LIVE_TEST=1` and an existing server-side key is present, and uses only the fixed synthetic Ahmed case with the same limits. Set verified pricing bounds before opting in. Credentials are unavailable in this implementation environment: **the live-provider criterion is BLOCKED**, and a skipped live test is not a pass. Mock/fake-transport tests do not prove a successful real OpenAI call.

## Durable consultation lifecycle

The existing EHR session supplies tenant, clinician, patient and encounter on every
transaction. Deployed requests always use PostgreSQL. Local synthetic development
uses PostgreSQL when configured; the original in-memory demo remains available
without a database and does not expose the durable lifecycle commands.

| Method/path | Body or query | Result |
| --- | --- | --- |
| POST `/api/consultations/drafts` | Existing fields plus optional `idempotencyKey` | Original created snapshot on replay (201) |
| PATCH `/api/consultations/drafts/:draftId` | `{expectedVersion,idempotencyKey,summary,assessment,plan}` | Revised editable draft |
| POST `/api/consultations/drafts/:draftId/approval` | `{draftId,decision,expectedVersion,idempotencyKey,recipientId?}` | Versioned physician decision; recipient required for approval |
| POST `/api/consultations/drafts/:draftId/transitions` | `{expectedVersion,idempotencyKey,action,recipientId?}` | Updated consultation; recipient required only for `queue` |
| GET `/api/consultations/drafts/:draftId/history` | Optional exclusive `beforeVersion` cursor | Up to 20 revisions, corresponding events, latest 20 attempts and `nextBeforeVersion` |

Durable responses add `tenantId`, `version` and canonical `lifecycleStatus`.
For compatibility, HTTP `status` still returns `pending_approval` while
`lifecycleStatus` and database status use `pending_review`. Existing tenant-scoped
pending rows are migrated with a preserved baseline revision. Tenantless historical
rows remain stored and inaccessible. The state set additionally includes `queued`,
`sent`, `accepted`, `responded`, `failed` and `cancelled`.

Generated drafts start at `pending_review`. Physician `request_changes` makes a
draft editable; `revise` requires `draft`, and `submit` returns it to review.
Approve, Reject and Edit (`request_changes`) require an explicit physician
decision on the displayed version. Approval records the selected allowlisted
destination against the immutable approved revision. Approval events contain
scope identifiers, decision, version, destination and timestamp.
The edit action returns the draft to editing. Submit places the revised draft
back in review for a new decision.

Mock routing requires the dedicated routing scope. Queue and send require the
same approved content, chart and destination. Sending checks the current
allowlist again. The delivery endpoint records a synthetic send atomically.
Mock transitions also support `queued -> sent -> accepted -> responded`
(or `sent -> responded`). Attempts that fail before sending can be retried to
the same recipient. A draft can record at most one successful send. Cancellation is allowed from draft/pending review/approved/
queued/failed. Rejected, responded and cancelled records are terminal.

Delivery transitions and the delivery endpoint run in verified synthetic mock
staging. Hospital delivery remains disabled. Model access is limited to drafting. Each command locks the aggregate, checks the expected
version and records a revision/event atomically. Idempotency keys are scoped to
the verified chart and clinician, serialize duplicate commands in PostgreSQL, and
return the original snapshot even after later transitions. Reusing a key for a
different command or supplying a stale version returns 409. Authorization is
rechecked before replay. Without a key, legacy creates retain their previous
non-idempotent behavior. Generated metadata remains the original source/provenance
record when a clinician revises prose; revisions preserve both for review.

The runtime cannot directly update aggregates, insert approvals, or alter revision,
event and idempotency history. All child tables enforce the same chart RLS and
carry tenant/request identity. The private command engine updates attempts.
Events and revisions preserve each transition. Historical approvals without
a destination remain in history. Unsent drafts in the approved state return
to review, and historical queued attempts require cancellation.

## M5/M6 provider routing and specialist responses

These supersede the M3 delivery transitions: `POST .../transitions` now accepts only `submit` and `cancel`. Delivery and provider outcome states cannot be set by a clinician command.

| Method/path | Body | Result |
| --- | --- | --- |
| POST `/api/consultations/drafts` | adds optional `specialty` + `clinicalQuestion` (both or neither) | Draft with the physician's intent in `grounding` |
| GET `/api/consultations/drafts` | — | Up to 20 recent consultations for the verified chart |
| GET `/api/consultations/drafts/:draftId/providers` | — | Allowed, active providers offering the draft's specialty |
| POST `/api/consultations/drafts/:draftId/approval` | `{draftId, decision, recipientId (approve only), expectedVersion, idempotencyKey}` | Draft; an approval records its destination in `approvedRecipientId` |
| POST `/api/consultations/drafts/:draftId/delivery` | `{providerId, expectedVersion, idempotencyKey}`; `providerId` must be the approved destination | `ConsultationDeliveryView` after the send attempt |
| GET `/api/consultations/drafts/:draftId/delivery` | — | Delivery state, attempts, responses and the specialist report |
| POST `/api/consultations/drafts/:draftId/delivery/simulate` | `{}` | Synthetic only: the mock specialist sends its next signed callback |
| POST `/api/provider/v1/callbacks` | `ProviderCallback` (signed) | `{requestId, disposition: "applied"\|"ignored"\|"duplicate"}` |

Routing errors: 403 not a physician with the `consultation:route` scope, provider not allowed, suspended, wrong specialty or not the approved destination; 404 not this clinician's chart; 409 not approved, missing specialty/question, stale version, already routed elsewhere, or provider declined; 501 outside synthetic environments. A transport failure is not an HTTP error: the view returns `status: "failed"` with a `failureCode` and `canRetry`.

Provider contract 1.0 (`shared/contracts/provider.ts`). The envelope a provider receives: `{contractVersion, requestId, attempt, tenantId, providerId, specialty, reason, question, summary, assessment, plan[], clinicalFacts[], missingInformation[], attachments[] (references only), safetyFlags[], approval{approvedBy, approvedAt}, dataClassification}`. A callback: `{contractVersion, requestId, providerId, responseId, kind: "accepted"|"rejected"|"report", sentAt, reason?, report?{summary, recommendations[], responder}, dataClassification}`.

Callback authentication: headers `x-stetholink-provider`, `x-stetholink-timestamp` (ms, within 5 minutes) and `x-stetholink-signature` = hex HMAC-SHA256 of `<timestamp>.<raw body>` with that provider's secret. Unauthenticated 401; body provider differs from the authenticated one 403; unknown request, other tenant or other provider's request 404; closed, superseded, already answered or reused response id with different content 409. Resending the same `responseId` returns `duplicate` and changes nothing.

Known limits: one tenant per deployment with an environment allowlist (no provider administration); after a provider declines, the consultation must be cancelled and prepared again; no rate limiting on the callback route; synthetic providers only.


## Consultation assistant

| Method/path | Body | Result |
| --- | --- | --- |
| POST `/api/consultations/drafts` | `{patientId, encounterId?, request, idempotencyKey?}`. `request` is 8 to 2000 characters and cannot be combined with `specialty`/`clinicalQuestion` | Model-authored draft (201). `grounding.authoring` holds the request, whether inference was live, statements removed and token use |
| POST `/api/consultations/drafts/:draftId/ai-revision` | `{instruction, expectedVersion, idempotencyKey}` | The draft after reopen, revise and resubmit (version + 3 from review, + 2 from draft), awaiting review |

Errors: 400 no specialty named or invalid input; 403 chart mismatch, or a non-physician reopening a draft in review; 409 stale version, not awaiting review, or not drafted by the assistant; 422 the model's output failed grounding or safety checks; 503 the model was unavailable, timed out, or a cost or spending limit was reached. A failed request stores nothing and never falls back to another generator.

`summary` holds the consultation request as text: header lines, then sections whose statements end with `[fact-id]` citations (`shared/utils/referral-text.ts`). `assessment` holds missing information from the chart. `plan` holds AI suggestions, each prefixed `AI suggestion, not from the chart:`.

## Data classification

`DataClassification = "synthetic" | "live"` (`shared/contracts/classification.ts`) replaces the former `syntheticOnly: true` literal. `synthetic` means fictional test patients; `live` means real patients of a tenant configured with `CLINICAL_DATA_MODE=live`.

- The server derives it from the verified session and the tenant configuration. No request body carries it, and request schemas reject it as an unknown field. `GET /api/auth/session` returns it as `dataClassification`.
- `ConsultationDraft.grounding.provenance.dataClassification`, `ConsultationEnvelope.dataClassification` and `ProviderCallback.dataClassification` must equal the classification of the session and tenant that handle them. Core and PostgreSQL both refuse a mismatch; synthetic and live records are never combined.
- Clinical facts of a synthetic record have `source.type: "synthetic"`; facts of a live record have an EHR source (`fhir`, `openemr`, `ehr`) and keep their record reference.
- Records stored before this field carry `syntheticOnly: true`. They are unchanged in storage and read as `dataClassification: "synthetic"`. New writes and inbound callbacks that carry `syntheticOnly` are refused (400).
- Error mapping: a callback with a missing or unknown classification is 400; a valid classification that is not the tenant's is 403; a model that is not approved for live data is 503.

