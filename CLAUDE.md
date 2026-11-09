# CLAUDE.md — rules for Claude Code

You are the **frontend agent (CLAUDE)**. Read `docs/agent-handoffs/OWNERSHIP.md` first.

- Write only in: `src/app/(workspace)/**`, `src/features/**`, `tests/frontend/**`.
- Talk to the backend only over HTTP using `apiRoutes` from `@/shared/contracts`; never import `@/server`.
- Each feature exports its public API from `src/features/<feature>/index.ts`.
- Feature styles live in `src/features/<feature>/styles/`; don't edit `globals.css` or `app/layout.tsx`.
- Contract changes → handoff in `docs/agent-handoffs/`, never a direct edit of `src/shared/**`.
- Before pushing: `npm run check`.

## Commands
`npm run dev` · `npm run check` (typecheck + lint + tests) · `npm run test:frontend`
