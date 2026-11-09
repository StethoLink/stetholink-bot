# AGENTS.md: Codex (Backend & Intelligence)

**Canonical rules: [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md).** This file adds Codex-specific guidance only. If anything here conflicts with that file, the architecture file wins.

## Project architecture
Next.js 15 App Router + TypeScript. The UI (`src/features`, Claude) talks over HTTP to thin route handlers (`src/app/api`), which call the composition root `src/server/index.ts`. Shared contracts are in `src/shared/contracts` and `src/shared/schemas`. Deployment target: Vercel + Supabase + OpenAI.

## Your ownership (write only here)
`src/app/api/**` · `src/server/**` · `supabase/**` · `tests/backend/**` · `src/shared/**` (contract owner, **only after an approved handoff**).
Never edit `src/features/**`, `src/app/(workspace)/**`, `tests/frontend/**`, or protected config (`package.json`, lockfile, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `layout.tsx`, `globals.css`, `.github/**`, `scripts/**`). Request those changes with a handoff.

## AI orchestration conventions
- The orchestrator (`server/ai/orchestrator`) depends only on `ModelProvider`, `SafetyGuard`, and injected loaders. It has no HTTP, React, or database client.
- Implement OpenAI with the **Responses API** in `server/ai/providers/openai-provider.ts`. Select it only in `providers/index.ts`. Keep vendor SDK types inside the provider file.
- Version prompts in `server/ai/prompts` (`PROMPT_VERSION`) and record the prompt version and provider/model with each output when persistence lands.
- Tools live in `server/ai/tools/registry.ts`: typed Zod input, read-only, narrow, and run with the caller's `ToolContext`. **Never expose SQL, the database client, or credentials to the model.**
- Every model output passes through `server/safety` before it is returned. AI output is a recommendation (`requiresClinicianReview: true`). Only `/approval` changes a draft's status.
- Eval cases go in `server/ai/evaluations` and use synthetic data.

## Security requirements
- Every protected route calls `requireClinician()` first. Derive identity from the session, never from the request body.
- Supabase: RLS on every table, deny by default. The service-role key is server-only and never `NEXT_PUBLIC_`.
- Validate every request with `src/shared/schemas` and every response with `contractResponse()`.
- Don't log message content or patient data. Log ids and error codes.
- No real PHI anywhere: use `source: "synthetic"` fixtures. No secrets in code, tests, or commits.
- Integrations (SMART on FHIR, EHR vendors, external services) sit behind adapter interfaces in `server/integrations`.

## Coding standards
Strict TypeScript, no `any` except at the tool-registry boundary. Use factory functions with injected dependencies, keep route handlers under ~30 lines, and give modules a named `index.ts` surface. Don't add a dependency unless a task needs it (adding one is a protected change). Keep formatting changes to files you touch.

## Testing requirements
Vitest in `tests/backend/**`. Every service, provider, adapter, and route gets unit tests with mock providers and the synthetic adapter (no network). Contract tests prove outputs parse with `src/shared/schemas`. Run `npm run check && npm run build` before every push.

## Git collaboration rules
- Work only on `feature/ai-backend` in the `../stetholink-bot-codex` worktree (`npm run setup:worktrees`).
- Never push to `main`. Merge through PRs that pass CI and Code Owner review.
- Never force-push, `reset --hard`, delete, or rebase another agent's branch. Resolve conflicts in your own branch through a PR.
- Contract PRs are separate from feature PRs and merge first.
