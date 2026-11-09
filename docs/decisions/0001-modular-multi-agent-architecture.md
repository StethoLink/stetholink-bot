# ADR 0001: Ownership-zoned modular architecture for parallel agents

- Status: Accepted · Date: 2026-11-09

## Context
Codex and Claude Code will build StethoLink at the same time. Editing the same files leads to conflicts and hidden coupling.

## Decision
Split the repository into disjoint ownership zones (UI belongs to Claude, backend and AI belong to Codex). They meet only at `src/shared` contracts, which Codex owns and which change through an approval process. Enforce the split with ESLint import rules, CODEOWNERS, CI, and per-agent Git worktrees.

## Consequences
- Parallel work rarely conflicts, and the frontend can move ahead on the mock client.
- Contract changes are serialized and need a handoff.
