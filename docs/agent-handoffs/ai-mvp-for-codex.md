# Handoff to Codex: AI MVP branch `claude/stetholink-ai-mvp-nrw6ns`

Written by Claude Code for the infrastructure owner. Nothing here has been reviewed by Codex yet.

## Please review: changes in your area

1. **Migration `20261112000000_provider_routing_and_responses.sql`** (new; from the earlier M5/M6 branch, adapted to M4). It:
   - revokes runtime execute on M4's `dispatch_ehr_consultation(text,text,integer,text)`, because that marks a consultation sent without a transport. The router's `dispatch_ehr_consultation(text,integer,text,text,jsonb)` queues through your command engine instead;
   - requires `consultation:route` and refuses an envelope whose summary, assessment, plan or approval attribution differs from the approved draft;
   - records transport results through `consultation_command` (`sent`/`failed`), so your approval match, allowlist recheck and `sent_at` apply;
   - lets a verified provider callback set `sent_at` on an attempt whose transport result was lost;
   - limits `change_ehr_consultation` to `revise`, `submit`, `cancel`.
   `supabase/tests/provider_routing.sql` covers it; `m4_approval_boundary.sql` still passes at the M4 stage. It has only been applied to disposable local PostgreSQL 16, never to Supabase.
2. **`platform/tenants/env.ts`**: `syntheticStagingEnabled` now also accepts `AI_PROVIDER=openai` when `STAGING_LIVE_MODEL=enabled`. Default is unchanged. New variables: `STAGING_LIVE_MODEL`, `AI_DAILY_BUDGET_USD`, `OPENAI_REASONING_EFFORT`; `OPENAI_MAX_OUTPUT_TOKENS` maximum raised to 16000; `LOCAL_SYNTHETIC_CHART` accepts `omar`.
3. **`/api/staging/launch`**: new profile `chest-pain-demo`. `same-clinician-other-chart` keeps your Ahmed chart. New page `/staging` (404 unless synthetic staging is enabled) posts the launch secret from a form.
4. **Local development auth is unchanged from M4**: drafts only.
5. **`tests/e2e/run-ci.sh`** also runs `m5-m6-flow.mts` and `m7-assistant-flow.mts`.

## No schema change was needed for the AI work

Authoring metadata is stored inside `clinical_metadata.grounding.authoring`. Model revision uses your existing commands (`request_changes`, `revise`, `submit`).

## Requests

| Need | Why | Exact requirement |
| --- | --- | --- |
| Durable model spend ledger | The daily limit is per instance, in memory | Table `model_usage(tenant_id text, day date, provider text, model text, input_tokens bigint, output_tokens bigint, estimated_cost_usd numeric, calls integer, primary key (tenant_id, day, provider, model))`; one security-definer function `reserve_model_spend(p_tenant text, p_usd numeric, p_limit numeric) returns boolean` that atomically adds and refuses above the limit; runtime execute only |
| Revision provenance | A model revision's provider, model and usage are logged, not stored | Optional `metadata jsonb` on `consultation_events`, written by `consultation_command` from a whitelisted `p_payload->'provenance'` on `revise` |
| Vercel preview variables | Live model on staging | `AI_PROVIDER`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_INPUT_USD_PER_MILLION`, `OPENAI_OUTPUT_USD_PER_MILLION`, `STAGING_LIVE_MODEL=enabled`, and the function timeout raised to at least 60 s for `POST /api/consultations/drafts` and `.../ai-revision` |
| Outbound network | Model calls | Allow `api.openai.com` from the deployment |

## API added

| Method and path | Body | Result |
| --- | --- | --- |
| POST `/api/consultations/drafts` | `{patientId, encounterId?, request, idempotencyKey?}` | Model-authored `ConsultationDraft` (201) |
| POST `/api/consultations/drafts/:id/ai-revision` | `{instruction, expectedVersion, idempotencyKey}` | Revised draft, awaiting review |

Not verified by this branch: Supabase, Vercel, cloud persistence, any real provider.
