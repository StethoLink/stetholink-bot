# Workboard: live-data MVP

Shared by Claude Code and Codex. Protocol: [AGENTS.md](../../AGENTS.md#two-agents-one-main). Edit this file only in small commits and push them at once.

## Goal

A physician launches StethoLink from a real hospital EHR (SMART on FHIR), the assistant drafts a consultation from the real chart, the physician reviews and approves it, it is sent to a real, allowlisted specialist provider, and the response comes back to the chart. Synthetic mode stays for local development, CI and demos, but is no longer the only mode the code allows.

## Design decisions (both agents follow these)

- **Data classification replaces `syntheticOnly`.** Introduce `DataClassification = "synthetic" | "live"` in `shared/contracts`. Every place that today requires `syntheticOnly: true` (contracts, zod schemas, `core/consultation`, `core/consultation/grounding.ts`, `core/routing/router.ts`, `core/agent/providers`, envelope, and the PostgreSQL commands) instead carries `dataClassification` and checks that it matches the session and tenant. Never mix: a synthetic session cannot write live drafts and vice versa.
- **Classification comes from the server, never from HTTP input.** `synthetic` for dev/staging sessions, `live` for a verified SMART session of a live tenant.
- **Live mode is an explicit tenant switch.** `CLINICAL_DATA_MODE=live` (default `synthetic`). It is refused at startup unless `AUTH_MODE=smart`, `CLINICAL_DATA_SOURCE` is `fhir` or `openemr`, a database URL is set, the model provider is configured for live data (`MODEL_LIVE_DATA_APPROVED=true` plus provider settings), and dev/staging launch modes are off. Live mode never falls back to the mock model silently: if the model is unavailable the request fails visibly.
- **Unchanged safety boundaries.** Physician-only approval, separate review and route scopes, tenant allowlist in Core and PostgreSQL, grounding and citation checks, no model tools, no demographics or chart identifiers in the provider envelope, no PHI in logs.
- **Real providers** come from server-side configuration (directory + per-provider secret), use `integrations/providers/http-partner.ts` behind `ProviderAdapter`, and the mock specialist is never available in live mode.
- **Tests** run the live code path with fictional data (fake FHIR server / fake provider), never real patients.

## Phases

- **Phase 0, foundation (one agent, alone, before the others start):** T1, T2, T3 and T4. These change the cross-cutting synthetic wiring (contracts, schemas, Core gates, session classification, SQL commands), so two agents doing them at once would conflict on every file.
- **Phase 1, parallel:** T5–T10, Claude Code and Codex together, after Phase 0 is `done` on `main`.

## Tasks

Status: `open`, `claimed (<agent>)`, `done (<agent>)`. Suggested first owner is only a starting point; either agent may take any open task.

| ID | Task | Depends on | Suggested | Status | Reserved migration |
| --- | --- | --- | --- | --- | --- |
| T1 | Data classification contract: `DataClassification` in `shared/contracts` and `shared/schemas`, provenance and envelope fields, replacing the `syntheticOnly: true` literals. Keep old synthetic rows readable. | none | Phase 0 | claimed (claude) | |
| T2 | Tenant live-mode gate in `platform/tenants/env.ts` and `platform/auth/session.ts`: `CLINICAL_DATA_MODE`, startup validation, session classification. `.env.example` updated. | none | Phase 0 | claimed (claude) | |
| T3 | Core consultation and grounding accept live FHIR/OpenEMR facts (`core/consultation/service.ts`, `grounding.ts`, `core/tools/connector.ts`), using the session classification. | T1 | Phase 0 | claimed (claude) | |
| T4 | Database: new migration replacing the `syntheticOnly` checks in the draft, dispatch and callback commands with classification checks bound to the tenant; pgTAP-style SQL tests in `supabase/tests/`. | T1 | Phase 0 | claimed (claude) | `20261113150000_data_classification.sql` |
| T5 | Model provider for live data: lift the synthetic-only restriction in `core/agent/providers/openai-provider.ts` behind the live gate; durable spend ledger (`model_usage`, `reserve_model_spend`) replacing the in-memory daily limit; no mock fallback in live mode. | T1, T2 | Codex | open | |
| T6 | Chat and drafting routes in `apps/embedded-app/server/index.ts` work for live sessions; rename `clinicalSafetyGuard` to a clinical guard used for both modes. | T2, T3 | Claude | open | |
| T7 | Real provider routing: provider directory and secrets from server config, register `http-partner` adapter, router accepts live envelopes, callbacks enabled for live tenants, rate limit on the callback route, mock specialist synthetic-only. | T1, T4 | Codex | open | |
| T8 | UI: live vs synthetic labelling, hide "simulate" and staging controls in live mode, clear error when the model or provider is unavailable, chart context from the EHR launch. | T2, T6 | Claude | open | |
| T9 | Live-path end-to-end test: fake SMART/FHIR server + fake HTTPS provider + PostgreSQL, full flow launch → draft → approve → send → callback → history. Add to `tests/e2e/run-ci.sh`. | T3–T8 | Codex | open | |
| T10 | Docs: update `docs/architecture/ARCHITECTURE.md`, `README.md`, `docs/providers/integration.md`, `docs/openemr.md`, plus a go-live runbook (`docs/go-live.md`): hospital SMART registration, clinician mapping, DB roles, model vendor data agreement and region, provider onboarding, log retention. | T2–T7 | Claude | open | |

## Interface changes

Newest first. Format: `date · agent · what changed · who must react`.

- 2026-11-13 · claude · T3 core ports · `ClinicianContext.dataClassification` (required). New required `dataClassification` dependency on `createConsultationService`, `createProviderRouter`, `createChatOrchestrator` and `createProviderResponseService`; `buildEnvelope(draft, provider, tenantId, classification)` and `groundContext(patient, encounter, classification)` take it as an argument. `ModelRequest.dataClassification` widens to `DataClassification`. `createOpenAIProvider` config gains `liveDataApproved` (default false): a live request without it fails with `provider_unavailable`. `mockProvider` and the mock specialist transport refuse live requests. `syntheticSafetyGuard` is renamed `clinicalSafetyGuard`. `ClinicalDataAdapter.source` (Core) allows `"openemr"`. · Anyone constructing these: pass the session's classification, never a literal.

- 2026-11-13 · claude · T1 contracts · `DataClassification = "synthetic" | "live"` (`shared/contracts/classification.ts`), `DATA_CLASSIFICATIONS` constant, `dataClassificationSchema`, `classificationOfSource()` and `readLegacyClassification()` (`shared/schemas/classification.ts`). `ConsultationGrounding.provenance`, `ConsultationEnvelopeContent` and `ProviderCallback` now carry `dataClassification` instead of `syntheticOnly: true`. New `storedConsultationEnvelopeSchema` / `storedProviderCallbackSchema` read rows written with the old flag as synthetic; `consultationEnvelopeSchema` and `providerCallbackSchema` (new writes, inbound callbacks) reject the old flag. `DATA_SOURCES` gains `"openemr"`. · Everyone: write `dataClassification`, never `syntheticOnly`. A provider adapter must copy the envelope's classification into its callbacks.

## Log

Newest first. Format: `date · agent · task · what was done · notes for the other agent`.

- 2026-11-13 · claude (setup session) · T0 · Removed CODEOWNERS and the PR template, replaced the frontend/backend split with the shared-`main` protocol in AGENTS.md, created this board. · Run the Phase 0 foundation pass (T1–T4) with one agent first, then start both agents on Phase 1.
