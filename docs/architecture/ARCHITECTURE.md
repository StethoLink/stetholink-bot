# StethoLink architecture

```text
apps/embedded-app/       Embedded UI, HTTP contracts and service composition
core/auth/               Provider-neutral clinician authorization context
core/agent/              Model interfaces, prompts, orchestration and safety checks
core/tools/              Clinical connector and consultation transport interfaces
core/consultation/       Draft generation, approval and routing
core/patient-context/    Patient-context service
integrations/            FHIR, OpenEMR and synthetic connectors
platform/auth/           Identity adapters and opaque server-side sessions
platform/persistence/    PostgreSQL session and consultation storage
platform/tenants/        Server-side tenant configuration
platform/audit/          Structured routing events
shared/                  HTTP contracts, validation and API client
supabase/                PostgreSQL migrations, RLS and authorization tests
```

## EHR-first identity

The clinician launches StethoLink from an active EHR chart. SMART App Launch is the initial identity adapter. The server pins the FHIR base, authorization and token endpoints, OIDC issuer and JWKS endpoint to the tenant registration. It checks SMART discovery for the pinned endpoints and PKCE S256. State, nonce and the verifier live in a short-lived, single-use record bound to an opaque browser cookie.

The callback exchanges the code and verifies the signed ID token, including issuer, audience, authorized party, nonce and expiration. A tenant-administered mapping binds the verified subject and `fhirUser` to a stable clinician UUID and role. The SMART grant supplies patient and encounter IDs. Authenticated FHIR reads confirm resource identity and the encounter's patient. The clinician uses their hospital session throughout the launch.

The platform creates a revocable session containing clinician UUID, tenant, roles, scopes, chart context, expiry and active authorization. The EHR token remains server-side. Browser cookies contain opaque random handles and use HTTP-only, SameSite=Lax and Secure in deployed environments. Logout revokes the local session. A new launch replaces the prior chart session. The Core receives a `ClinicianContext` and typed interfaces. Future trusted identity adapters can supply the same context.

## Database authorization

Supabase can host PostgreSQL for a dedicated tenant. The backend uses a restricted login role and applies verified identity and chart context within each transaction. RLS checks tenant, clinician, patient, encounter and expiry. Browser roles have no direct draft privileges. Historical tenantless drafts are inaccessible from EHR sessions. A narrowly granted approval function checks physician role and scope, locks the scoped draft, and records the decision atomically. The runtime role cannot update approval state directly or edit the audit trail. [Persistence setup](../decisions/supabase-connection.md)

## Synthetic staging and clinical safety

A preview-only route verifies a server-configured secret and resolves fixed synthetic launch profiles. It exercises the same durable session and database boundaries as SMART. Local development opens a fixed synthetic chart for the mock workflow. Vercel production denies both synthetic authentication modes. [Staging checks](../../tests/e2e/README.md)

Staging uses the deterministic mock model. Synthetic output checks reject invalid draft structures, unsafe formatting and selected unauthorized claims or treatment instructions. Generated drafts remain pending until physician review. SMART chart access is read-only. Deployed delivery returns 501. Local mock delivery reads the stored approval and checks the tenant recipient allowlist before sending to its in-memory transport.

Before enabling a hospital integration, register the SMART client, provision the clinician mapping and restricted database login, verify actual launch and supported FHIR scopes, and test the embedding and cookie model with the hospital. Review provider and database data residency, schedule expiration cleanup, and configure infrastructure logs to omit OAuth query strings and clinical payloads. Durable clinical delivery and validation of model behavior with hospital data require separate integration work. [SMART setup](../openemr.md)
