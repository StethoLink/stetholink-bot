# CLAUDE.md: Claude Code (Frontend & Clinical Experience)

**Canonical rules: [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md).** This file adds Claude-specific guidance only. If anything here conflicts with that file, the architecture file wins.

## Your ownership (write only here)
`src/app/(workspace)/**` · `src/features/**` (`assistant`, `consultations`, `ehr-panel`) · `tests/frontend/**`.
Never edit `src/app/api/**`, `src/server/**`, `supabase/**`, `src/shared/**`, security rules, or protected config (`package.json`, lockfile, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `layout.tsx`, `globals.css`, `.github/**`, `scripts/**`). Request those changes with a handoff in `docs/agent-handoffs/`.

## UI/UX principles
- Calm, dense, scannable. Clinicians are interrupted constantly: show the most important information first and keep every action one step away.
- Show state at all times: loading (skeleton or `aria-busy`), empty, error (with a retry), and success. Never fail silently.
- Responsive from a narrow EHR sidebar (~360 px) up to full desktop. The assistant panel must work embedded in an iframe.

## Clinical interface requirements
- Label AI output clearly as **AI-generated**, show the safety level, and state that it needs clinician review.
- Approval is a separate, deliberate action (explicit approve, reject, or request-changes control, never automatic). Show who approved and when, using server-provided `reviewedBy`/`reviewedAt`.
- Show allergies and other critical patient context prominently. Never truncate them silently.
- Show a visible "synthetic" badge when `source === "synthetic"`.
- Never store patient data in `localStorage` or `sessionStorage`, or log it to the console.

## Shared API contract usage
- Import types from `@/shared/contracts` and get data from `@/shared/api-client` (`getApiClient()` or an injected `StethoLinkApiClient`).
- Never redeclare contract types, call `fetch` directly, or import `@/server` (ESLint blocks this).
- Develop against `NEXT_PUBLIC_API_MODE=mock` (synthetic data). Switch to `http` once Codex ships the endpoints.
- Need a field or endpoint? Write a `contract-change` handoff. Don't work around the contract.

## Component conventions
- `src/features/<feature>/{components,hooks,styles}`. Each feature exports its public API from `index.ts`, and other code imports only that (ESLint enforces it).
- Components stay presentational where possible. Data loading goes in hooks, which take an optional `client` for testing.
- Use Tailwind utilities, or CSS modules in `styles/`. No global CSS edits.
- Mark components `"use client"` only when they need it.

## Accessibility requirements
WCAG 2.2 AA: semantic HTML, a label on every control, visible focus, full keyboard operation, `aria-live` for streaming or new messages, `role="alert"` for errors, contrast of at least 4.5:1, no meaning conveyed by color alone, and respect for `prefers-reduced-motion`.

## Testing requirements
Vitest in `tests/frontend/**`. Test hooks and components with `createMockApiClient()` or a stub client. Cover loading, error, empty, and approval flows. Run `npm run check && npm run build` before every push.

## Git collaboration rules
- Work only on `feature/clinical-ui` in the `../stetholink-bot-claude` worktree (`npm run setup:worktrees`).
- Never push to `main`. Merge through PRs that pass CI and Code Owner review.
- Never force-push, `reset --hard`, delete, or rebase another agent's branch. Don't reformat files you don't own.
