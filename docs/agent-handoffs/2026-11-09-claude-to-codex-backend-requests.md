# Backend work the clinical UI is waiting on

- **From → To:** claude → codex
- **Type:** request
- **Status:** proposed
- **Branch / PR:** claude/awesome-turing-2fh5e7
- **Blocking?:** yes, for switching `NEXT_PUBLIC_API_MODE` to `http`

The UI for chat, consultation review/approval, patient context, encounter and the embedded panel is
built against the mock client. These are the backend pieces needed for it to run in `http` mode.
All paths below are Codex-owned; Claude has not touched them.

## 1. Consultation routes and database
- Implement `POST /api/consultations/drafts`, `GET /api/consultations/drafts/[draftId]`,
  `POST /api/consultations/drafts/[draftId]/approval` (all currently `not_implemented`).
  Each calls `requireClinician()`, validates with `src/shared/schemas`, responds via `contractResponse()`.
- Behaviour the UI relies on (matches the mock): approval on an already approved/rejected draft → `409 conflict`
  with a human-readable message; `request_changes` → status `draft`, still decidable; `reviewedBy`/`reviewedAt`
  set from the session; unknown draft → `404 not_found` with message "Draft not found".
- New append-only migration: `reviewed_by`/`reviewed_at` on `consultation_drafts`, `conversations` and
  `messages` tables (store `safety` and `requires_clinician_review` per assistant message), `audit_log`,
  and RLS policies scoped to the authenticated clinician.
- `consultation_approvals.clinician_id` is `uuid` but the dev session returns `"dev-clinician"`; use a fixed dev UUID.
- `reviewedBy` is shown to clinicians verbatim; please return a display name, not a raw UUID (or propose a contract field).

## 2. AI pipeline
- Implement `createOpenAIProvider` (Responses API) behind `ModelProvider`.
- Replace `passthroughSafetyGuard` with real checks. The UI shows `safety.reasons` verbatim under each
  reply, so reasons should be short clinician-readable sentences.
- Register read-only tools (`getPatientContext`, `getEncounterContext`) running with the caller's `ToolContext`.
- Add evaluations in `src/server/ai/evaluations`.

## 3. Authentication and EHR launch
- Supabase Auth in `requireClinician()`; dev fallback only outside production.
- SMART on FHIR EHR launch behind `EhrAdapter`. The embedded panel is at `/embed?patientId=…&encounterId=…`;
  ideally the launch flow redirects there after resolving `EhrLaunchContext`. The UI treats those query
  params as display context only, so the server must authorize access to that patient on every request.
- FHIR R4 `ClinicalDataAdapter`, synthetic stays default.

## Approvals
- [ ] Codex
- [x] Claude
