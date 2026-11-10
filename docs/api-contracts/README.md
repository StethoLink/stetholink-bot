# API Contracts v1.0.0

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
- Synthetic development uses an in-memory repository. Supabase deployments use clinician-scoped persistence.
- Delivery requires an approved draft and a recipient on the tenant allowlist. Synthetic delivery returns `{ draftId, recipientId, status, response? }`.
- Generation supports synthetic patient/encounter context. `conversationId` is rejected with 400 until conversation persistence is implemented. An encounter must belong to the requested patient.
- `/api/auth/login` provides the sign-in form (GET) and password sign-in (POST). `/api/auth/session` validates the session (GET); `/api/auth/logout` revokes it (POST). These bootstrap authentication endpoints do not require an existing clinician session. See `docs/decisions/supabase-connection.md`.
- `safety.level === "blocked"` means `message.content` is a withheld notice, not model output.
- Error code → HTTP status: invalid_request 400 · unauthenticated 401 · forbidden 403 · not_found 404 · conflict 409 · safety_blocked 422 · internal_error 500 · not_implemented 501 · provider_unavailable 503.

## Client
`@/shared/api-client` exports `StethoLinkApiClient`, `createMockApiClient()` (synthetic, in-memory, follows the same rules as above), `createHttpApiClient()` (validates every response), and `getApiClient()` (selected by `NEXT_PUBLIC_API_MODE`).
