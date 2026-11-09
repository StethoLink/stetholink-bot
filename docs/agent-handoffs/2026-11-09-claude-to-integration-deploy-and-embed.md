# Integration tasks: iframe embedding, e2e, deployment

- **From → To:** claude → integration
- **Type:** protected-file-change
- **Status:** proposed
- **Branch / PR:** claude/awesome-turing-2fh5e7
- **Blocking?:** yes, for embedding in a hospital EHR

## 1. Allow the embed route in an EHR iframe
Next.js sends no `frame-ancestors` policy today. In `next.config.ts` add headers so only `/embed`
can be framed, by an allowlist of EHR origins from configuration:

```ts
async headers() {
  const ehrOrigins = process.env.EHR_FRAME_ANCESTORS ?? "'none'";
  return [
    { source: "/:path*", headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'none'" }] },
    { source: "/embed", headers: [{ key: "Content-Security-Policy", value: `frame-ancestors ${ehrOrigins}` }] },
  ];
}
```
Auth cookies used inside the iframe will need `SameSite=None; Secure` (coordinate with Codex).

## 2. Repository and deployment (needs GitHub/Vercel/Supabase admin, not an agent)
- Branch protection on `main`: PR required, CI required, Code Owner review.
- Vercel and Supabase projects with environment variables from `.env.example`.
- Merge order: contracts → Codex → Claude; then set `NEXT_PUBLIC_API_MODE=http`.

## 3. End-to-end tests (`tests/e2e/**`, integration-owned)
Add `@playwright/test` and cover, in `http` mode against synthetic data:
- workspace: send chat → reply shows "AI-generated", safety badge, review note;
- `/consultations/syn-draft-001`: request changes requires a comment; approve → "Reviewed by …"; second approve → conflict alert;
- `/embed?patientId=syn-pt-001&encounterId=syn-enc-001` at 360 px: no horizontal scroll, allergies visible;
- `/embed` with no patient → alert.

## Approvals
- [ ] Integration owner
