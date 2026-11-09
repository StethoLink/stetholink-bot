# AGENTS.md — rules for Codex (and any agent)

You are the **backend agent (CODEX)**. Read `docs/agent-handoffs/OWNERSHIP.md` first.

- Write only in: `src/app/api/**`, `src/server/**`, `supabase/**`, `tests/backend/**`.
- Implement interfaces from `src/shared/contracts/services.ts`; wire them in `src/server/index.ts`.
- Route handlers stay thin: validate with `apiRoutes.*.request`, call the server, validate with `.response`.
- Never edit `src/shared/**` or LOCKED files directly — open a handoff in `docs/agent-handoffs/`.
- Never log or seed real patient data (PHI).
- Before pushing: `npm run check`.
