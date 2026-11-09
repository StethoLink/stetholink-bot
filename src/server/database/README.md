# Database (Codex)

Supabase Postgres access. Rules:
- Only repository functions in this folder query the database. AI code (`src/server/ai/**`) must not import it (enforced by ESLint).
- Use the service-role key only on the server, never with `NEXT_PUBLIC_`.
- Schema changes go through `supabase/migrations/` and are append-only.

The implemented repository uses the Supabase REST API with the signed-in user's access
token and the public project key. It never uses a service-role key. RLS restricts draft
and approval reads to the owning clinician. Approval writes go through
`record_consultation_approval`, which locks the draft, verifies ownership and the
trusted clinician role, records the audit entry, and changes the status atomically.

`supabase/tests/clinician_access.sql` verifies ownership, denied direct updates,
forged approvals, trusted role enforcement, duplicate review conflicts, and immutable
audit entries against the real database. All synthetic fixtures roll back.

See `docs/decisions/supabase-connection.md` for account setup and deployment settings.
