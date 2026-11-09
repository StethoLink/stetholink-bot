# StethoLink Bot

Cloud-based clinical AI assistant for hospital systems.
Next.js 15 (App Router) · TypeScript · Tailwind CSS v4 · Zod · Supabase · OpenAI · Vitest · Vercel.

> **Scaffold only.** The AI provider is a mock, clinical data is synthetic, and the UI is a placeholder.

## Quick start
```bash
npm install
cp .env.example .env.local
npm run dev      # http://localhost:3000
npm run check    # typecheck + lint + tests
npm run build
```

## Parallel development
```bash
npm run setup:worktrees   # feature/ai-backend (Codex) + feature/clinical-ui (Claude)
```

| Zone | Owner |
|---|---|
| `src/app/(workspace)`, `src/features`, `tests/frontend` | Claude Code |
| `src/app/api`, `src/server`, `supabase`, `tests/backend`, `src/shared` (contracts) | Codex |
| Config, `layout.tsx`, `globals.css`, `.github`, `scripts`, `tests/e2e` | Integration owner |

**Read first:** [docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md) (canonical) · [API contracts](docs/api-contracts/README.md) · [Handoffs](docs/agent-handoffs/README.md) · [ADRs](docs/decisions/) · [AGENTS.md](AGENTS.md) · [CLAUDE.md](CLAUDE.md)

## Data & secrets
Never commit real patient information or credentials. Use `.env.local` (gitignored) and the Vercel/Supabase secret stores.
