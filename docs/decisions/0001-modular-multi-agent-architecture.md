# ADR 0001 — Modular architecture for parallel agent development

- Status: Accepted
- Date: 2026-11-09

## Context
Claude Code and OpenAI Codex will develop StethoLink at the same time. Shared files cause merge conflicts and silent coupling.

## Decision
- Split ownership by directory: Claude owns the UI (`(workspace)`, `features`), Codex owns the backend (`app/api`, `server`, `supabase`).
- The only shared surface is `src/shared` (Zod contracts), changed via a dedicated contract PR.
- Enforce boundaries with ESLint and CODEOWNERS; coordinate through `docs/agent-handoffs`.

## Consequences
+ Agents rarely touch the same file; contracts are explicit and runtime-validated.
− Contract changes are serialized and need a short handoff.
