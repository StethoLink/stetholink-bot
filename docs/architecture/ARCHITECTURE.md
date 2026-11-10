# StethoLink architecture

```text
apps/embedded-app/       Next.js embedded UI, route handlers and composition
core/agent/              Model interfaces, prompts, orchestration and safety checks
core/tools/              Clinical connector and consultation transport interfaces
core/consultation/       Draft generation, approval repository port and routing
core/patient-context/    Patient-context service
integrations/fhir/       SMART authorization helpers and patient-scoped R4 reads
integrations/openemr/    OpenEMR connector using the generic FHIR implementation
integrations/mock/       Synthetic patient data adapter, drafts and delivery
platform/tenants/        Server environment and tenant configuration
platform/auth/           Clinician authentication and SMART sandbox sessions
platform/audit/          Structured routing events
platform/persistence/    Existing user-scoped Supabase repository
shared/                  HTTP contracts, validation and API client
supabase/                Existing schema, RLS, approval RPC, seeds and SQL tests
tests/                   Backend, frontend and dependency-free smoke tests
```

The app composes the connector, model and repository. Core code depends on the interfaces and shared contracts. A connector may also provide a consultation transport when that EHR supports delivery. Connector implementations must enforce patient context, preserve approval and recipient constraints, and make delivery idempotent by draft ID.

The HTTP routes derive clinician identity from the verified session. Supabase reads use the user's token with the existing RLS policies. Approval uses the existing transaction and the database records the reviewer. Routing reads the stored approval and checks the recipient against the tenant allowlist before calling the transport. The mock connector simulates both submission and a recipient response. Routing audit events include tenant, actor and draft identifiers. Request bodies and patient information are excluded from those events.

The deployment model is one configured tenant per app instance. Deployments using Supabase require a dedicated project per tenant. There is no shared database tenancy. Secrets stay in server-side environment variables. Public Supabase variables contain public connection information only.

## Safety and gaps

- The synthetic workflow uses physician approval before routing. The mock transport produces an acknowledgement locally.
- The OpenAI Responses provider is opt-in for synthetic data. The existing safety interface and clinician review gate remain. The existing guard does not provide clinically validated output screening.
- Generic FHIR and OpenEMR support a read-only SMART sandbox in development. SMART registration values come from server configuration. Authorization uses state and PKCE and binds the resulting context to the verified clinician and tenant. These grants are in memory and expire within 15 minutes.
- Live consultation generation and delivery, production SMART identity mapping and durable grant storage, EHR-specific result ingestion, and durable delivery auditing require additional implementation and hospital integration testing. The app denies model access and delivery for EHR connector modes.
