# StethoLink architecture

```text
apps/embedded-app/       Embedded UI, HTTP contracts and service composition
core/auth/               Provider-neutral clinician authorization context
core/agent/              Model interfaces, prompts, orchestration and safety checks
core/tools/              Clinical connector interface and the (empty) model tool allowlist
core/consultation/       Draft generation, grounding and approval
core/routing/            Provider registry, router, transport port and callback ingestion
core/patient-context/    Patient-context service
integrations/            FHIR, OpenEMR and synthetic connectors; provider adapters; mock specialist transport
platform/auth/           Identity adapters and opaque server-side sessions
platform/persistence/    PostgreSQL session and consultation storage
platform/tenants/        Server-side tenant configuration
platform/providers/      Tenant provider configuration and callback signature verification
platform/audit/          Structured routing and callback events
shared/                  HTTP contracts, validation and API client
supabase/                PostgreSQL migrations, RLS and authorization tests
```

## EHR-first identity

The clinician launches StethoLink from an active EHR chart. SMART App Launch is the initial identity adapter. The server pins the FHIR base, authorization and token endpoints, OIDC issuer and JWKS endpoint to the tenant registration. It checks SMART discovery for the pinned endpoints and PKCE S256. State, nonce and the verifier live in a short-lived, single-use record bound to an opaque browser cookie.

The callback exchanges the code and verifies the signed ID token, including issuer, audience, authorized party, nonce and expiration. A tenant-administered mapping binds the verified subject and `fhirUser` to a stable clinician UUID and role. The SMART grant supplies patient and encounter IDs. Authenticated FHIR reads confirm resource identity and the encounter's patient. The clinician uses their hospital session throughout the launch.

The platform creates a revocable session containing clinician UUID, tenant, roles, scopes, chart context, expiry and active authorization. The EHR token remains server-side. Browser cookies contain opaque random handles and use HTTP-only, SameSite=Lax and Secure in deployed environments. Logout revokes the local session. A new launch replaces the prior chart session. The Core receives a `ClinicianContext` and typed interfaces. Future trusted identity adapters can supply the same context.

## Database authorization

Supabase can host PostgreSQL for a dedicated tenant. The backend uses a restricted login role and applies verified identity and chart context within each transaction. RLS checks tenant, clinician, patient, encounter and expiry. Browser roles have no direct draft privileges. Historical tenantless drafts are inaccessible from EHR sessions. The review command checks physician role and review scope, locks the scoped draft and records the decision against the reviewed version and selected destination. The routing command requires its own scope and checks that the immutable approval matches the chart, content and current tenant allowlist. The runtime role cannot update approval state directly or alter approval events and revisions. [Persistence setup](../decisions/supabase-connection.md)

## Provider routing and specialist responses

Routing is separate from approval and from the EHR connector. `core/routing` owns three small ports: `ProviderRegistry` (the tenant's allowed providers), `ProviderTransport` (send one envelope, idempotent on its request id) and `DeliveryRepository`/`ProviderResponseSink` (durable state). The mock specialist is one transport; a provider portal or partner API would be others using the same versioned envelope and callback contracts in `shared/contracts/provider.ts`.

```text
physician approval -> review_ehr_consultation                    (records the reviewed version and the chosen destination)
physician session  -> router.route -> dispatch_ehr_consultation  (matching approval + allowlisted + versioned; stores request id and envelope)
                                   -> ProviderTransport.send     (outside any transaction)
                                   -> record_ehr_dispatch_result (sent | failed, re-checked by the command engine)
provider callback -> verify HMAC signature -> validate -> record_provider_callback (tenant + request id + provider must match)
clinician readback -> delivery view (RLS: same tenant, clinician, patient, encounter)
```

- Review and routing use separate physician scopes (`consultation:approve`, `consultation:route`). The physician approves one version of the content for one destination; only that destination can receive it. The model has no tool for approval, routing or responses.
- The destination must be on the tenant allowlist (checked in Core and again in PostgreSQL), active, and offer the requested specialty. A retry after a transport failure goes to the same destination with a new request id.
- A delivery attempt row is the request: its id is the immutable correlation id. PostgreSQL refuses an envelope whose summary, assessment, plan or approval attribution differs from the approved consultation. The envelope carries the clinical content, sources and gaps, and no demographics or chart identifiers.
- Sending is at-least-once with an idempotent receiver. Repeated or concurrent commands create one request; a request recorded but not transmitted is resumed by repeating the command.
- Clinician commands cannot set `sent`, `accepted`, `responded` or `failed`. Those come only from the transport result and from verified provider callbacks.
- Callbacks are deduplicated by response id, never move state backwards, are refused for superseded, rejected or cancelled requests, and are still linked when they arrive before the transport result or after a timeout.

Routing currently runs only for synthetic sessions (local development or preview staging) with the synthetic provider directory. Elsewhere the routes answer 501 or 404.

## Consultation assistant

`core/consultation/authoring.ts` turns a physician's natural-language request and the normalized chart facts into a consultation draft. The model returns one structured JSON object and has no tools. Every statement must cite documented facts and is checked against them; unsupported statements are removed and counted, missing information is written from the chart, and suggestions are kept apart. Revision reuses the same checks and the recorded lifecycle, so a revised draft is again awaiting physician review. The OpenAI adapter enforces a per-call cost bound, a per-instance daily limit, a deadline and bounded retries, and reports tokens, estimated cost and latency. The deterministic mock remains for tests and as a fallback the interface labels as not being AI. [Assistant guide](../ai/consultation-assistant.md)

Provider-specific logic sits behind `ProviderAdapter` in `integrations/providers/`. No real provider is connected. [Provider integration](../providers/integration.md)

## Synthetic staging and clinical safety

A preview-only route verifies a server-configured secret and resolves fixed synthetic launch profiles. It exercises the same durable session and database boundaries as SMART. Local development opens a fixed synthetic chart for the mock workflow. Vercel production denies both synthetic authentication modes. [Staging checks](../../tests/e2e/README.md)

Staging uses the deterministic mock model unless a live model is explicitly enabled; only synthetic charts are sent either way. Synthetic output checks reject invalid draft structures, unsafe formatting and selected unauthorized claims or treatment instructions. Generated drafts remain pending until physician review. SMART chart access is read-only.

Before enabling a hospital integration, register the SMART client, provision the clinician mapping and restricted database login, verify actual launch and supported FHIR scopes, and test the embedding and cookie model with the hospital. Review provider and database data residency, schedule expiration cleanup, and configure infrastructure logs to omit OAuth query strings and clinical payloads. Delivery to real providers and validation of model behavior with hospital data require separate integration work. [SMART setup](../openemr.md)
