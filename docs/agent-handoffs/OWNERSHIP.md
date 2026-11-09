# Ownership Map

Each path has exactly one writer. Agents edit **only** their zone. Anything else is a handoff.

| Path | Owner | Notes |
|---|---|---|
| `src/app/(workspace)/**` | CLAUDE | Pages, layouts for the clinician workspace |
| `src/features/**` | CLAUDE | `assistant`, `consultations`, `ehr-panel` |
| `tests/frontend/**` | CLAUDE | |
| `src/app/api/**` | CODEX | Thin route handlers: parse → call `@/server` → validate response |
| `src/server/**` | CODEX | AI, clinical, integrations, auth, database, safety |
| `supabase/migrations/**` | CODEX | Append-only, numbered `NNNN_name.sql` |
| `supabase/seed/**` | CODEX | Synthetic data only — never real PHI |
| `tests/backend/**` | CODEX | |
| `tests/e2e/**` | INTEGRATION OWNER (human) | |
| `tests/fixtures/**` | CONTROLLED | Add-only; don't change existing fixtures |
| `src/shared/**` | CONTROLLED | Contract-change process below |
| `src/app/layout.tsx`, `src/app/globals.css` | LOCKED | Both owners approve |
| `package.json`, lockfile, configs | LOCKED | One agent per PR; announce in a handoff |
| `docs/**` | Anyone | Each agent writes its own handoff files |

## Contract-change process (`src/shared/**`)
1. Write a handoff `docs/agent-handoffs/YYYY-MM-DD-<agent>-<topic>.md` describing the change.
2. Prefer **additive** changes (new optional fields, new routes). Breaking changes need an ADR in `docs/decisions/`.
3. Update `docs/api-contracts/` in the same PR.
4. Land the contract PR **alone**, before either side builds on it. Both agents rebase afterwards.

## Dependency rules (enforced by ESLint `no-restricted-imports`)
- `features/*`, `app/(workspace)` → `shared/*` only. Talk to the backend over HTTP via `apiRoutes`.
- `server/*` → `shared/*` only.
- `shared/*` → nothing internal.
- `app/api/*` → `@/server` (composition root) + `shared/*`.
