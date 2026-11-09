# StethoLink: Canonical Architecture

> **This is the single source of truth.** `AGENTS.md` (Codex) and `CLAUDE.md` (Claude Code) add
> role-specific guidance only. If they ever disagree with this file, this file wins. Fix the other file through a PR.

## 1. System overview

```
 Clinician browser / EHR iframe
        │
 src/app/(workspace)  ──►  src/features/{assistant,consultations,ehr-panel}       [Claude]
        │                          │ uses
        │                 src/shared/api-client  (mock | http)                    [shared]
        │                          │ HTTP, JSON validated by src/shared/schemas
        ▼                          ▼
 src/app/api/*  (thin route handlers: auth → parse → service → validate)          [Codex]
        │
 src/server/index.ts  (composition root)
        ├─ auth/            server-side authorization (Supabase Auth)
        ├─ ai/              orchestrator · prompts · providers · tools · evaluations
        ├─ clinical/        patient-context · consultation · workflows
        ├─ integrations/    fhir · ehr · external-services   (all behind adapters)
        ├─ database/        Supabase Postgres repositories
        └─ safety/          output validation before anything leaves the server
```

Deployment target: **Vercel** (Next.js app + route handlers), **Supabase** (Auth + Postgres + RLS), **OpenAI** (inference, through the provider interface). Nothing is deployed from this repository yet.

## 2. Ownership map

Every path has exactly one owner. Agents edit only paths they own.

| Path | Owner | Notes |
|---|---|---|
| `src/app/(workspace)/**` | **Claude** | Workspace pages and layouts |
| `src/features/**` | **Claude** | Components, hooks, feature styles |
| `tests/frontend/**` | **Claude** | |
| `src/app/api/**` | **Codex** | Route handlers |
| `src/server/**` | **Codex** | All backend and AI logic |
| `supabase/**` | **Codex** | Migrations (append-only), synthetic seed |
| `tests/backend/**` | **Codex** | |
| `src/shared/**` | **Codex** (contract owner) | Every change needs an approved handoff and integration review (§5) |
| `tests/e2e/**`, `tests/fixtures/**` | **Integration owner** | Human maintainer |
| `package.json`, lockfile, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `postcss.config.mjs`, `vitest.config.ts` | **Integration owner** (protected) | Change only through an approved handoff |
| `src/app/layout.tsx`, `src/app/globals.css` | **Integration owner** (protected) | Feature styles go in `src/features/<x>/styles/` |
| `.github/**`, `scripts/**`, `AGENTS.md`, `CLAUDE.md`, `docs/architecture/**` | **Integration owner** (protected) | |
| `docs/agent-handoffs/**` | Each agent writes **new** files only | Never edit another agent's file |
| `docs/api-contracts/**`, `docs/decisions/**` | Codex / Integration | Updated together with the contract |

### 2.1 Codex: Backend & Intelligence
AI orchestration and OpenAI Responses API integration · model providers and clinical AI tools · backend API routes · database logic and migrations · Supabase integration · authentication and authorization · SMART on FHIR integration · hospital system adapters · clinical workflow logic · server-side safety validation · backend unit and integration tests.
**Codex never edits** Claude-owned UI components, hooks or styles.

### 2.2 Claude Code: Frontend & Clinical Experience
Clinician chat interface · embedded hospital assistant panel · consultation preparation screens · clinician approval interfaces · patient context presentation · loading, error and interaction states · responsive UI and accessibility · design system implementation · frontend hooks and components · frontend unit tests.
**Claude never edits** backend APIs, migrations, AI orchestration, or security rules.

## 3. Module boundaries (enforced by `eslint.config.mjs`)

| Importer → may import | shared | server | features | app/api |
|---|---|---|---|---|
| `src/shared/**` | ✅ | ❌ | ❌ | ❌ |
| `src/server/**` | ✅ | ✅ | ❌ | ❌ |
| `src/server/ai/**` | ✅ | ✅ except `server/database` | ❌ | ❌ |
| `src/features/**`, `src/app/(workspace)/**` | ✅ | ❌ | ✅ public `index.ts` only | ❌ |
| `src/app/api/**` | ✅ | ✅ (via `@/server`) | ❌ | — |

Dependencies point one way (UI → shared ← server), so circular dependencies between layers are impossible.
Inside a layer, prefer `index.ts` public surfaces and avoid importing back up the tree.
`server-only` makes the build fail if server code reaches a client bundle.

## 4. Architecture rules

1. **TypeScript everywhere**, `strict` on.
2. **AI is independent of the UI.** The orchestrator takes a `ChatRequest` and returns a `ChatResponse`. It has no React and no HTTP.
3. **Providers are replaceable.** The orchestrator depends on `ModelProvider` (`src/server/ai/providers/types.ts`). Concrete providers are chosen only in `providers/index.ts` (`AI_PROVIDER`).
4. **Integrations sit behind adapters.** FHIR and EHR access goes through `ClinicalDataAdapter` / `EhrAdapter`. The synthetic adapter is the default.
5. **Server-side authorization.** Every protected route calls `requireClinician()` before touching clinical data. Clients never send clinician identity. Supabase RLS denies by default.
6. **No unrestricted database access for the LLM.** AI code cannot import `server/database` (lint-enforced). The model can only call allowlisted, typed, read-only tools in `ai/tools/registry.ts`, which run with the caller's authorization.
7. **Approval is separate from recommendation.** AI output is a `ChatResponse` or a `ConsultationDraft`. Only an authenticated clinician action (`ApprovalRequest` → `/approval`) changes a draft to `approved`/`rejected`. Approvals are stored in their own append-only table.
8. **Synthetic data for development.** `src/shared/mocks/synthetic-data.ts` and `supabase/seed/`. Records carry `source: "synthetic"`.
9. **No real patient data or secrets in Git.** Use `.env.local` (gitignored) and Vercel/Supabase secret stores. `.env.example` holds placeholders only.
10. **Testable units.** Factories take their dependencies as arguments (`createChatOrchestrator(deps)`). Hooks accept an optional `client`.
11. **Lean.** Add a dependency or abstraction only when a current task needs it. Adding a dependency is a protected change.

## 5. Shared contracts and their governance

The contracts live in `src/shared/contracts/` (TypeScript interfaces). Validation schemas live in `src/shared/schemas/`, and each schema is tied to its interface with `satisfies z.ZodType<…>`, so drift fails type checking.

`PatientContext`, `EncounterContext`, `ChatRequest`, `ChatResponse`, `ConsultationDraft`, `ConsultationStatus`, `ApprovalRequest`, `ApiError` (plus `ChatMessage`, `SafetyAssessment`, `ApprovalDecision`, `CreateConsultationDraftRequest`).

- **Status:** v1.0.0 approved at scaffold time (`docs/agent-handoffs/2026-11-09-integration-contracts-v1-approved.md`).
- **Owner:** Codex. After approval, **neither agent changes a contract on its own initiative.**
- **Change process:** see `docs/agent-handoffs/CONTRACT-CHANGES.md`. In short: proposal handoff → approval from Claude and the integration owner → one contract-only PR → both feature branches rebase.
- **Runtime validation:** route handlers validate requests and use `contractResponse()` for responses. `createHttpApiClient` validates every response again in the browser.
- **Frontend usage:** components import types from `@/shared/contracts` and data from `@/shared/api-client`. They never redeclare contract types.

## 6. Git collaboration

| Rule | How it's enforced |
|---|---|
| One branch per agent: Codex `feature/ai-backend`, Claude `feature/clinical-ui` | `scripts/setup-worktrees.sh` |
| Separate working directories | Git worktrees (`../stetholink-bot-codex`, `../stetholink-bot-claude`) |
| Simultaneous work allowed | Ownership map (§2) keeps the files disjoint |
| No direct pushes to `main` | Branch protection on GitHub (configure: require PR, require CI, require Code Owner review) |
| Protected config and contracts need integration review | `.github/CODEOWNERS` |
| Don't reformat or overwrite files you don't own | Agent instructions. Run formatters only on your own paths |
| No destructive Git on another agent's work | Never `reset --hard`, `push --force`, `branch -D`, or rebase another agent's branch |
| Tests pass before merge | `.github/workflows/ci.yml` (typecheck, lint, test, build) |
| Conflicts resolved in PRs, never by force push | Rebase or merge **your own** branch onto `main`, then push normally |

**Merge order when both branches are ready:** contract PRs first, then Codex, then Claude (the UI switches from `mock` to `http` mode last).

## 7. Commands

```bash
npm run dev              # local app (mock AI, synthetic data)
npm run check            # typecheck + lint + unit tests
npm run build            # production build
npm run setup:worktrees  # create the two agent worktrees
```
