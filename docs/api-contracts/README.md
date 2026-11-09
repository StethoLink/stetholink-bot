# API Contracts

Source of truth: `src/shared/contracts/api.ts` (schemas in `src/shared/schemas`). This doc is the human-readable mirror.

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/health` | — | `{ status: "ok", version }` |
| POST | `/api/assistant` | `AssistantRequest` `{ message, consultationId?, patientId? }` | `AssistantResponse` `{ consultationId, reply, safety }` |
| GET | `/api/patients/:patientId/context` | — | `PatientContext` *(planned, not yet implemented)* |

Errors: `{ error: { code, message } }` with an appropriate HTTP status.
