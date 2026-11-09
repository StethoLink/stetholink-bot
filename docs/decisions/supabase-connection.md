# Supabase connection and clinician access

Project: `stetholink-bot` (`elpjwihvftxckesxqndy`), organization StethoLink, region ap-south-1.
URL: https://elpjwihvftxckesxqndy.supabase.co
The previous `stetholink-dev` project has not been changed or copied.

## Run the implemented backend

Use the `feature/ai-backend` worktree, `/workspace/stetholink-bot-codex`.
Its gitignored `.env.local` is configured with the new project's public key and:

```dotenv
AUTH_MODE=supabase
NEXT_PUBLIC_API_MODE=http
NEXT_PUBLIC_SUPABASE_URL=https://elpjwihvftxckesxqndy.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<new project's publishable key>
AI_PROVIDER=mock
CLINICAL_DATA_SOURCE=synthetic
```

No service-role key is required. The legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY` is a
fallback only. Never place private keys in `NEXT_PUBLIC_` variables.

Run `npm run dev`, then visit `/api/auth/login`. Sign in with a provisioned clinician's
email and password. The form redirects to the workspace; the existing HTTP client
uses the resulting cookies. The workspace has no new login navigation or logout button.

## Provision a clinician

An organization administrator must create the account with a password using the new
project's Supabase Authentication dashboard or the Auth Admin API, through a trusted
account provisioning process. Do not create a shared account or paste passwords into
chat or source control. Email invitation/recovery callbacks and self-service password
reset screens are not implemented by this password-login change.

Assign the trusted role through the Supabase Auth Admin API's `app_metadata` field,
or run this narrowly scoped SQL as a project administrator after replacing the UUID
with the invited user's actual ID:

```sql
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
    || '{"role":"clinician"}'::jsonb
where id = '<invited-user-uuid>'::uuid;
```

Roles are `clinician` or `admin`; neither role can read another user's drafts.
`user_metadata` and anonymous users never grant clinician access. Sign in again after
role changes to refresh JWT claims. Existing access JWTs remain valid until expiry;
revoking sessions alone does not immediately revoke every previously issued JWT.

## Authentication endpoints

- `GET /api/auth/login`: server-rendered sign-in form.
- `POST /api/auth/login`: email/password as JSON or an HTML form. Returns clinician
  identity for JSON, or redirects to `/` for a successful form submission.
- `GET /api/auth/session`: verifies the session and returns clinician ID and roles.
- `POST /api/auth/logout`: revokes the local Supabase session and clears cookies.

Cookies are HTTP-only, SameSite=Lax, Secure in production. Cross-origin requests are
rejected. Protected routes validate the token against Supabase Auth, refresh expired
cookie sessions, and derive identity from the verified user. JSON never returns tokens.
Bearer-token clients are supported without taking identity from a request body.

## Persistence and approval

The three consultation routes now generate, save, retrieve, and review drafts.
Only synthetic patient data is enabled. Mock AI is still the default; real OpenAI
generation requires the existing `AI_PROVIDER=openai` and server-side `OPENAI_API_KEY`.
The existing safety guard remains a placeholder and must be replaced before clinical use.
Generation accepts patient and matching encounter context; conversation-based drafts
are explicitly rejected until conversation persistence is implemented.

Provider, model, and prompt version are stored with each draft. New drafts are always
pending review. Approval validates the URL/body draft ID and derives the reviewer from
the session. An atomic RPC locks the owned draft, appends the decision, and updates it.
Only draft/pending_approval states can be reviewed. No direct update/delete or audit
insert/update/delete permission is granted to authenticated clients.

The Supabase advisor intentionally reports the authenticated SECURITY DEFINER RPC:
it is the narrowly scoped transaction boundary, with an empty search path, revoked
PUBLIC/anon execution, and explicit identity, role, and owner checks. See
https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable

## Deploy separately

The user selected a new Vercel project named `stetholink-bot` in the StethoLink team.
Do not change the existing Vite-based `stetholink-platform` project.

Configure the new Vercel project as Next.js, connect this repository, and deploy the
reviewed backend branch through the repository's PR workflow. Set the variables above
in preview and production (and the public key from the new project's API settings).
Use `AUTH_MODE=supabase` in production; development auth is disabled there. Rebuild
after setting `NEXT_PUBLIC_` values because Next.js embeds them during the build.

Vercel currently denies project creation through the connected account (403). No Vercel
CLI credentials are configured in this environment. Production deployment and its
environment variables therefore remain pending until the project can be created.

The execution environment also needs outbound HTTPS access to the new Supabase host
for a full password-login HTTP smoke test. Database SQL checks use the Supabase connector.
