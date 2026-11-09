# API Contracts v1.0.0

Human-readable mirror of `src/shared/contracts` (types), `src/shared/schemas` (validation), and `apiRoutes`.
If they disagree, the code wins. Fix this doc in the same PR.

Every non-2xx response is an `ApiError`: `{ "error": { "code": ApiErrorCode, "message": string, "requestId"?: string } }`.
Every route except `/api/health` requires an authenticated clinician (server-side).

| # | Method | Path | Request body | 2xx response | Status |
|---|---|---|---|---|---|
| 1 | GET | `/api/health` | — | `{ status: "ok", contractVersion }` | ✅ implemented |
| 2 | POST | `/api/chat` | `ChatRequest` | `ChatResponse` | ✅ mock provider |
| 3 | GET | `/api/patients/:patientId/context` | — | `PatientContext` | ✅ synthetic adapter |
| 4 | GET | `/api/encounters/:encounterId` | — | `EncounterContext` | ✅ synthetic adapter |
| 5 | POST | `/api/consultations/drafts` | `CreateConsultationDraftRequest` | `ConsultationDraft` (201) | ⏳ returns 501 |
| 6 | GET | `/api/consultations/drafts/:draftId` | — | `ConsultationDraft` | ⏳ returns 501 |
| 7 | POST | `/api/consultations/drafts/:draftId/approval` | `ApprovalRequest` | `ConsultationDraft` | ⏳ returns 501 |

## Types

```ts
type ConsultationStatus = "draft" | "pending_approval" | "approved" | "rejected" | "archived";

interface PatientContext   { patientId; displayName; birthDate?; sex; allergies[]; activeProblems[]; medications[]; source: "synthetic"|"fhir"|"ehr" }
interface EncounterContext { encounterId; patientId; type; status; startedAt; location?; reasonForVisit? }
interface ChatRequest      { message; conversationId?; patientId?; encounterId? }      // message: 1..8000 chars
interface ChatResponse     { conversationId; message: ChatMessage; safety: SafetyAssessment; requiresClinicianReview }
interface ConsultationDraft{ id; patientId; encounterId?; status; summary; assessment; plan[]; generatedBy:"ai"; createdAt; updatedAt; reviewedBy?; reviewedAt? }
interface ApprovalRequest  { draftId; decision: "approve"|"reject"|"request_changes"; comment? }
interface ApiError         { error: { code; message; requestId? } }
```

## Semantics
- **Approval transitions:** `pending_approval|draft` + approve → `approved`, + reject → `rejected`, + request_changes → `draft`. Any other state returns `409 conflict`.
- `reviewedBy` / `reviewedAt` are set by the server from the session and are ignored if a client sends them.
- `safety.level === "blocked"` means `message.content` is a withheld notice, not model output.
- Error code → HTTP status: invalid_request 400 · unauthenticated 401 · forbidden 403 · not_found 404 · conflict 409 · safety_blocked 422 · internal_error 500 · not_implemented 501 · provider_unavailable 503.

## Client
`@/shared/api-client` exports `StethoLinkApiClient`, `createMockApiClient()` (synthetic, in-memory, follows the same rules as above), `createHttpApiClient()` (validates every response), and `getApiClient()` (selected by `NEXT_PUBLIC_API_MODE`).
