# Consultation review: safety level, review comment, component test setup

- **From → To:** claude → codex, integration
- **Type:** contract-change (items 1–2), protected-file-change (item 3)
- **Status:** proposed
- **Branch / PR:** claude/keen-hamilton-xbrq5f
- **Blocking?:** no. The review UI ships without these, but it can't show the draft's safety level or the reviewer's comment.

## Need
`CLAUDE.md` requires AI output to show its safety level. `ConsultationDraft` has no safety field, and the
comment sent with `ApprovalRequest` is never returned. A clinician reopening a rejected draft can't see why it was rejected.

## Proposed change (additive, minor → 1.1.0)
```ts
// before
export interface ConsultationDraft { /* ... */ reviewedBy?: string; reviewedAt?: IsoDateTime; }
// after
export interface ConsultationDraft {
  /* ... */
  reviewedBy?: string;
  reviewedAt?: IsoDateTime;
  /** Safety assessment of the generated content (same shape as ChatResponse.safety). */
  safety?: SafetyAssessment;
  /** Decision and comment from the last review, set by the server. */
  reviewDecision?: ApprovalDecision;
  reviewComment?: string;
}
```
Mock client: return `safety` on synthetic drafts, and store `decision`/`comment` in `submitApproval`.

3. **Test setup (protected):** add `jsdom` and `@testing-library/react` (+ `user-event`) as devDependencies, use the
   automatic JSX runtime in `vitest.config.ts`, and include `tests/frontend/**/*.test.tsx` with `environment: "jsdom"`.
   Until then, frontend tests render with `react-dom/server` and set `globalThis.React` (see `tests/frontend/consultations.test.ts`),
   so click and typing interactions can't be tested yet.

## Impact
`src/shared/contracts/consultation.ts`, `src/shared/schemas`, mock client, API docs. Once this lands, Claude will render the safety badge and the review comment in `ConsultationDraftView`.

## Approvals
- [ ] Codex
- [ ] Claude
- [ ] Integration owner
