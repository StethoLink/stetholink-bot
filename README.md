# StethoLink Bot

Cloud-based clinical AI assistant for hospital systems. Next.js 15 (App Router) · TypeScript · Tailwind v4 · Zod · Supabase · Vitest.

> Foundation only — features are stubs with a mock AI provider.

## Quick start
```bash
npm install
cp .env.example .env.local
npm run dev        # http://localhost:3000
npm run check      # typecheck + lint + tests
```

## Layout & ownership
| Zone | Owner |
|---|---|
| `src/app/(workspace)`, `src/features/*`, `tests/frontend` | Claude Code |
| `src/app/api`, `src/server/*`, `supabase/*`, `tests/backend` | Codex |
| `src/shared/*`, `app/layout.tsx`, `globals.css` | Controlled / locked |
| `tests/e2e` | Integration owner |

Details: [ownership](docs/agent-handoffs/OWNERSHIP.md) · [architecture](docs/architecture/overview.md) · [API contracts](docs/api-contracts/README.md) · [ADRs](docs/decisions/).
