# StethoLink architecture

```text
apps/embedded-app/       Embedded UI, HTTP contracts and service composition
core/auth/               Provider-neutral clinician authorization context
core/agent/              Model interfaces, prompts, orchestration and safety checks
core/privacy/            De-identification before the model and the way back (ports: IdentitySource, SurrogateVault)
core/consultation/       Draft generation, grounding and approval
core/routing/            Provider registry, router, transport port and callback ingestion
core/patient-context/    Patient-context service
core/scribe/             Transcription port, sentence splitting, SOAP note generation and validation, scribe service
core/tools/              Clinical read port, clinical write port (create only), empty model tool allowlist
integrations/            FHIR reader, fact normalization and writer; OpenEMR connector; transcription
                         adapters; provider adapters; the inbox (portal) transport
platform/auth/           Identity adapters and opaque server-side sessions
platform/persistence/    PostgreSQL session and consultation storage
platform/tenants/        Server-side tenant configuration
platform/providers/      Tenant provider configuration and callback signature verification
platform/audit/          Structured routing, callback and chart-write events
platform/http/           Request limits
shared/                  HTTP contracts, validation and API client
supabase/                PostgreSQL migrations, RLS and authorization tests
```

## EHR-first identity

The clinician launches StethoLink from an active EHR chart. SMART App Launch is the initial identity adapter. The server pins the FHIR base, authorization and token endpoints, OIDC issuer and JWKS endpoint to the tenant registration. It checks SMART discovery for the pinned endpoints and PKCE S256. State, nonce and the verifier live in a short-lived, single-use record bound to an opaque browser cookie.

The callback exchanges the code and verifies the signed ID token, including issuer, audience, authorized party, nonce and expiration. A tenant-administered mapping binds the verified subject and `fhirUser` to a stable clinician UUID and role. The SMART grant supplies patient and encounter IDs. Authenticated FHIR reads confirm resource identity and the encounter's patient. The clinician uses their hospital session throughout the launch.

The platform creates a revocable session containing clinician UUID, tenant, roles, scopes, chart context, expiry and active authorization. StethoLink permissions come from the tenant's clinician mapping, never from the EHR token: every mapped clinician may read, record and draft (`chart:read`, `scribe:record`, `consultation:draft`); only a mapped physician may approve, send and write to the chart (`consultation:approve`, `consultation:route`, `chart:write`). The EHR token remains server-side and the stored session is encrypted (AES-256-GCM, key from configuration, rotation by a list of previous keys). Browser cookies contain opaque random handles and are HTTP-only and Secure; SameSite=Lax for a top-level window, or SameSite=None with Partitioned for the EHR's iframe (`COOKIE_MODE`). A session lasts at most 15 minutes; the clinician then reopens StethoLink from the chart.

A launch whose token carries no patient, for a signed identity listed in the tenant's specialist map, creates a specialist session instead. It holds no patient, no encounter and no EHR token, uses a separate database setting (`stetholink.specialist`), and can reach only the inbox of its own service. Logout revokes the local session. A new launch replaces the prior chart session. The Core receives a `ClinicianContext` and typed interfaces. Future trusted identity adapters can supply the same context.

## Database authorization

Supabase can host PostgreSQL for a dedicated tenant. The backend uses a restricted login role and applies verified identity and chart context within each transaction. RLS checks tenant, clinician, patient, encounter and expiry. Browser roles have no direct draft privileges. Historical tenantless drafts are inaccessible from EHR sessions. The review command checks physician role and review scope, locks the scoped draft and records the decision against the reviewed version and selected destination. The routing command requires its own scope and checks that the immutable approval matches the chart, content and current tenant allowlist. The runtime role cannot update approval state directly or alter approval events and revisions. [Persistence setup](../decisions/supabase-connection.md)

## Provider routing and specialist responses

Routing is separate from approval and from the EHR connector. `core/routing` owns three small ports: `ProviderRegistry` (the tenant's allowed providers), `ProviderTransport` (send one envelope, idempotent on its request id) and `DeliveryRepository`/`ProviderResponseSink` (durable state). The in-hospital inbox (`portal`) is the one transport; a partner API would be another using the same versioned envelope and callback contracts in `shared/contracts/provider.ts`.

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
- A delivery attempt row is the request: its id is the immutable correlation id. PostgreSQL refuses an envelope whose summary, assessment, plan or approval attribution differs from the approved consultation. The envelope carries the clinical content (which states the patient's age, top-coded at 90, and sex) and only the sources and gaps that content cites, and no name, birth date or chart identifiers.
- Sending is at-least-once with an idempotent receiver. Repeated or concurrent commands create one request; a request recorded but not transmitted is resumed by repeating the command.
- Clinician commands cannot set `sent`, `accepted`, `responded` or `failed`. Those come only from the transport result and from verified provider callbacks.
- Callbacks are deduplicated by response id, never move state backwards, are refused for superseded, rejected or cancelled requests, and are still linked when they arrive before the transport result or after a timeout.

A tenant routes only to the receiving services in its own configuration (`PROVIDER_DIRECTORY`, `PROVIDER_ALLOWLIST`). There is no simulated specialist: a provider without a real transport cannot be sent to. The transport is `portal`: a specialist service inside the same hospital. The stored delivery request is its inbox entry, so "sending" is an acknowledgement of a durable row and is idempotent by nature. The specialist reads only requests sent to that service (same tenant, same classification), sees only the envelope, and accepts, declines with a reason or reports. The reply is recorded through the same `ProviderResponseService` and `record_provider_callback` as a signed callback; only the way the sender is authenticated differs. The envelope and the consultation text carry no EHR record reference: a fact travels under its own opaque id.

## Consultation assistant

`core/consultation/authoring.ts` turns a physician's natural-language request, the normalized chart facts and the patient's age and sex into a consultation draft. The model first reviews the request and, when it does not fit the chart or is unclear, returns questions instead of a draft; the physician answers, proceeds anyway or rewrites the request. The model returns one structured JSON object and has no tools. Every statement must cite documented facts and is checked against them; unsupported statements are removed and counted, missing information is written from the chart, and suggestions are kept apart. Revision reuses the same checks and the recorded lifecycle, so a revised draft is again awaiting physician review. The OpenAI adapter enforces a per-call cost bound, a per-instance daily limit, a deadline and bounded retries, and reports tokens, estimated cost and latency. There is no fallback: the deterministic stand-in exists only under `tests/fixtures`, and the server does not start without a configured model. [Assistant guide](../ai/consultation-assistant.md)

Provider-specific logic sits behind `ProviderAdapter` in `integrations/providers/`. No real provider is connected. [Provider integration](../providers/integration.md)

## De-identification at the model boundary

`getModelProvider(privacy, task)` in `platform/tenants/model-provider.ts` is the only place a model client is built, for consultations and for the scribe's note. It returns `createPseudonymizingProvider` (`core/privacy/provider.ts`) around the client, never the client itself, and the client refuses any request not marked by that layer (`ModelRequest.pseudonymized`). A test fails if product code outside those two files constructs the client.

The layer reads who the chart names through the `IdentitySource` port (`getIdentity()` on the FHIR connector: Patient, its contacts, RelatedPerson, the signed-in Practitioner, the visit start), replaces names, identifiers and dates in every message (`core/privacy/pseudonymizer.ts`), checks the result independently for any identifier the chart supplied, sends it, and maps the answer back before the caller's own validation runs. Callers and validators therefore keep working on real chart text. The stand-in map is held through the `SurrogateVault` port; the only implementation is process memory keyed by session and dropped at session expiry (`platform/privacy/vault.ts`). Clinical values are not touched: JSON numbers, fact ids and anything that is not a name, an identifier or a calendar date pass unchanged. Audio is outside this layer; see `docs/go-live.md`.

## One mode, and where test data lives

The running product has no built-in patients, no stand-in model or transcription, no simulated specialist, no in-memory browser client and no sign-in other than the SMART launch. `platform/tenants/env.ts` refuses to start unless the EHR launch, the EHR data source, PostgreSQL, session encryption and an approved, priced model are configured, and it refuses by name any setting of the removed synthetic modes. Nothing falls back to fabricated content: a missing part is a configuration error at startup or a visible error on the request.

Fictional charts, the deterministic model and transcription stand-ins, the simulated specialist and the fake EHR, model and transcription servers live under `tests/` (`tests/fixtures`, `tests/helpers`, `tests/e2e/fakes`). `eslint.config.mjs` (`no-restricted-imports`) and `tests/backend/no-fixtures-in-product.test.ts` fail when `apps/`, `core/`, `platform/`, `integrations/`, `shared/` or `scripts/` import from `tests/`, a `fixtures` folder or a `mocks` folder. Real patient data is never committed and never used in automated tests.

`DataClassification` keeps two values. Every session, draft, envelope and reply of a deployment is `live`, because it comes from an EHR. `synthetic` remains as the label of test fixtures, so a fixture can never pass a live-only guard, and of rows stored by earlier versions, which no session can open.

Output checks reject invalid draft structures, unsafe formatting and selected unauthorized claims or treatment instructions. Generated drafts remain pending until physician review. [End-to-end checks](../../tests/e2e/README.md)

## Chart facts from FHIR

`integrations/fhir/connector.ts` reads the launched patient and encounter and five patient-scoped searches, following `next` links only on the registered FHIR base and up to fixed caps. `integrations/fhir/facts.ts` turns the resources into facts with a keyed-digest id, the record reference and the documented time: active problems (not refuted or entered in error; a provisional diagnosis keeps that word), active medication orders (the dose only as recorded, otherwise "Dose not recorded in the order"), allergies (none recorded is an explicit unknown; a recorded "no known allergy" is a fact in its own words), and the latest final value of each vital sign and laboratory test inside a time window, with interpretation and reference range copied as text. Selection under the Core limits is deterministic, and whatever was left out or could not be loaded is listed in `chartNotes`, shown to the clinician and written into the draft. A visit whose status or class cannot be used is refused with its reason.

## AI scribe

The clinician confirms that the patient agreed; only then is the microphone requested. The browser records mono Opus in parts of 20 to 30 seconds cut at pauses, drops silent parts and uploads each part in order. The server checks session, classification, size, duration, the visit's time limit and its cost ceiling, sends the part to the `TranscriptionProvider` from memory and stores only the recognized sentences (`scribe_segments`, row-level security on tenant, clinician, patient, encounter and classification). Audio is never written to disk or database.

Ending the visit makes one model call (`core/scribe/note.ts`). The model has no tools and returns one JSON object. Every statement must quote the exact words of a transcript sentence or cite a chart fact; every figure must have been said (Arabic number words are read as numbers); assessment and plan must quote the clinician. What fails is removed and counted; a response that is mostly unsupported is refused. Items heard in the visit (allergies, conditions, medicines the patient takes, measurements) are compared with the chart and marked new, already in chart or conflicting. A conflict is shown and never resolved.

## Writing to the EHR

Writing replaces the earlier read-only rule, by product decision, under these controls. `ClinicalWriteAdapter` (`core/tools/chart-writer.ts`) has one operation, create; `integrations/fhir/writer.ts` issues only a conditional `POST` (`If-None-Exist` on StethoLink's own identifier) for the launched patient and encounter with the clinician's own token, after checking the granted scopes and the server's CapabilityStatement. What can be written: the visit note, the approved consultation and the specialist's reply as `DocumentReference`; and the items the physician selected as `AllergyIntolerance` (unconfirmed unless the physician confirms it), `Condition` and `MedicationStatement`.

```text
physician approval -> approve_scribe_note     (physician + chart:write; the note version and the exact selected items; only new, non-conflicting items)
each item          -> begin_chart_write       (refused unless that item's origin was approved by this physician for this chart)
                   -> ClinicalWriteAdapter.create (conditional create, outside any transaction)
                   -> record_chart_write      (created | existing | failed | unsupported; a success is final)
all items done     -> finish_scribe_session   (audit; the transcript is deleted once the note is in the chart)
```

The model cannot reach this path: it has no tools, and an item exists for writing only after a physician selected it. A session writes only to its own launched chart. Where the EHR grants no scope or support, or write-back is off, the item is offered as text to copy.

## Operations

Model and transcription spending is reserved in PostgreSQL per tenant and day (`reserve_spend`), so the limit holds across instances and restarts. `run_retention`, called daily by a separate maintenance login, removes expired sessions, transcripts past their date and, where periods are set, closed visits, finished consultations and ledger rows. [Data map](../data-map.md), [go-live runbook](../go-live.md).

Before enabling a hospital integration, follow the [go-live runbook](../go-live.md). What has and has not been verified against real servers is listed in [sandbox checks](../sandbox.md). [SMART setup](../openemr.md)
