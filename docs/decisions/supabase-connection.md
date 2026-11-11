# PostgreSQL persistence and clinician access

Use a dedicated database per tenant or staging environment. Supabase hosts PostgreSQL independently of clinician identity. The migration chain retains historical drafts and decisions, revokes legacy Supabase Auth access to those rows, and establishes EHR-scoped access.

1. Apply the checked-in migrations in order as the database owner. Check the target before applying the migration that revokes legacy browser grants.
2. Provision a random password for `stetholink_runtime`. Store the restricted connection string as `STETHOLINK_DATABASE_URL` in the server environment. For Supavisor, use the provider's custom-role connection syntax, `stetholink_runtime.<project-ref>`. The driver uses transaction-local context and disables prepared statements.
3. Configure `STETHOLINK_DATABASE_CA` if the database uses a private CA. Deployed connections verify the server certificate and hostname.
4. Run the authorization checks against an isolated database. [Supabase PostgreSQL connections](https://supabase.com/docs/guides/database/connecting-to-postgres)

The runtime role can insert pending drafts and read rows in the verified tenant, clinician, patient and encounter scope. The physician approval function changes draft status and appends the decision atomically. The app is the trusted boundary for issuing transaction-local authorization. Keep the runtime credential in the trusted backend.

Opaque session handles are hashed at rest. The private schema holds short-lived launch and session records, including the read-only EHR grant. Expired records are removed on new launches. Schedule periodic database cleanup before enabling a hospital tenant to enforce retention during idle periods.
