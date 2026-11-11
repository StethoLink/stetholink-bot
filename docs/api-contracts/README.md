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
| 8 | POST | `/api/consultations/drafts/:draftId/delivery` | `{ recipientId }` | `ConsultationDelivery` | Synthetic delivery |
| 9 | GET | `/api/consultations/drafts/:draftId/delivery` | — | `ConsultationDelivery\|null` | Clinician-owned draft |

## Types

```ts
type ConsultationStatus = "draft" | "pending_approval" | "approved" | "rejected" | "archived";

interface PatientContext   { patientId; displayName; birthDate?; sex; allergies[]; activeProblems[]; medications[]; source: "synthetic"|"fhir"|"ehr"; clinicalFacts?: ClinicalFact[] }
interface EncounterContext { encounterId; patientId; type; status; startedAt; location?; reasonForVisit?; clinicalFacts?: ClinicalFact[] }
interface ChatRequest      { message; conversationId?; patientId?; encounterId? }      // message: 1..8000 chars
interface ChatResponse     { conversationId; message: ChatMessage; safety: SafetyAssessment; requiresClinicianReview }
interface ConsultationDraft{ id; patientId; encounterId?; status; summary; assessment; plan[]; generatedBy:"ai"; createdAt; updatedAt; reviewedBy?; reviewedAt?; clinicalFacts?: ClinicalFact[]; missingInformation?: MissingInformation[]; attachments?: AttachmentReference[] }
interface ApprovalRequest  { draftId; decision: "approve"|"reject"|"request_changes"; comment? }
interface ApiError         { error: { code; message; requestId? } }
```

## M1 normalized clinical contracts

These additions preserve M0 payloads and fixtures. They introduce no HTTP routes, authentication mechanisms, approval actions or delivery actions. The existing `CreateConsultationDraftRequest` remains the HTTP generation input; `ConsultationRequest` describes normalized consultation intent for future Core consumers.

| Contract | Fields and meaning |
|---|---|
| `ClinicalSource` | `{ type: "synthetic"\|"fhir"\|"ehr", reference }`; reference is an opaque record/fixture identifier, without credentials or authenticated URLs. |
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
- Synthetic development uses an in-memory repository. Supabase deployments use clinician-scoped persistence.
- Delivery requires an approved draft and a recipient on the tenant allowlist. Synthetic delivery returns `{ draftId, recipientId, status, response? }`.
- Generation supports synthetic patient/encounter context. `conversationId` is rejected with 400 until conversation persistence is implemented. An encounter must belong to the requested patient.
- `/api/auth/login` provides the sign-in form (GET) and password sign-in (POST). `/api/auth/session` validates the session (GET); `/api/auth/logout` revokes it (POST). These bootstrap authentication endpoints do not require an existing clinician session. See `docs/decisions/supabase-connection.md`.
- `safety.level === "blocked"` means `message.content` is a withheld notice, not model output.
- Error code → HTTP status: invalid_request 400 · unauthenticated 401 · forbidden 403 · not_found 404 · conflict 409 · safety_blocked 422 · internal_error 500 · not_implemented 501 · provider_unavailable 503.

## Client
`@/shared/api-client` exports `StethoLinkApiClient`, `createMockApiClient()` (synthetic, in-memory, follows the same rules as above), `createHttpApiClient()` (validates every response), and `getApiClient()` (selected by `NEXT_PUBLIC_API_MODE`).
