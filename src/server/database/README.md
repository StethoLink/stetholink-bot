# Database (Codex)

Supabase Postgres access. Rules:
- Only repository functions in this folder query the database. AI code (`src/server/ai/**`) must not import it (enforced by ESLint).
- Use the service-role key only on the server, never with `NEXT_PUBLIC_`.
- Schema changes go through `supabase/migrations/` and are append-only.
