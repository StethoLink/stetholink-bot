# Authenticated synthetic staging verification

Use an isolated PostgreSQL database with the checked-in migrations and a restricted runtime credential. Configure these values on the intended Vercel Preview branch only.

| Setting | Value |
| --- | --- |
| `AUTH_MODE` | `staging` |
| `CLINICAL_DATA_SOURCE`, `AI_PROVIDER`, `NEXT_PUBLIC_API_MODE` | `synthetic`, `mock`, `http` |
| `TENANT_ID` | A staging tenant identifier |
| `STETHOLINK_DATABASE_URL` | Restricted runtime connection |
| `STETHOLINK_DATABASE_CA` | Trusted CA PEM if needed |
| `STAGING_LAUNCH_SECRET` | Random server-side secret of at least 32 characters |
| `STAGING_SESSION_SECONDS` | `45` for the expiry check |

Vercel supplies `VERCEL_ENV=preview`. Production cannot issue or accept staging sessions. Run the smoke test with `STAGING_BASE_URL` and `STAGING_LAUNCH_SECRET` in the authorized runner's environment. Supply `VERCEL_AUTOMATION_BYPASS_SECRET` from the deployment's authorized automation setup if the preview is protected.

```sh
node tests/e2e/staging.mts
```

The script checks session issuance, revocation and expiry, physician identity, chart reads, draft creation and review, cross-patient and cross-clinician denial, unauthorized requests and HTTP 501 on delivery. Run `supabase/tests/clinician_access.sql` as a PostgreSQL administrator who can assume the runtime session identity on an isolated database to verify cross-tenant and cross-encounter RLS, immutable approval auditing and denied legacy access. SQL test rows roll back. The HTTP test creates synthetic verification drafts.

Capture the exact commit SHA and deployment link for hosted verification. Staging simulates trusted identity and chart context. Signed SMART tests exercise the protocol with a test issuer. Hospital SSO requires a separate test against the registered EHR.

CI runs the same HTTP test against the production build and a disposable PostgreSQL 17 instance with TLS. Run `bash tests/e2e/run-ci.sh` after `npm run build` on a Linux Docker host.
