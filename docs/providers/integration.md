# Connecting a real consultation provider

**No real provider is integrated.** The only providers are the built-in simulated ones, and the interface labels them and their responses as simulated. This page describes what exists and what a real integration still needs. It names no provider, price, turnaround time or API, because none has been agreed.

## What exists

| Concern | Where | State |
| --- | --- | --- |
| Provider identity, specialties, transport kind, active flag | `ProviderDescriptor`, `core/routing/registry.ts` | Built. Directory is in code; no administration |
| Tenant allowlist | `MOCK_RECIPIENT_IDS`, checked in Core and PostgreSQL | Built |
| Request format | Envelope contract 1.0, `shared/contracts/provider.ts` | Built. Synthetic-only by contract |
| Outbound transmission | `ProviderTransport` / `ProviderAdapter`, `core/routing/ports.ts` | Interface built |
| Authentication | HMAC-SHA256 over timestamp and body, per-provider secret | Built for callbacks and the reference adapter |
| Delivery acknowledgment | Adapter returns `{requestId, providerReference}`; stored on the request | Built |
| Responses | Signed callbacks to `POST /api/provider/v1/callbacks`; `poll()` on the adapter | Callbacks built. Polling is defined, not scheduled |
| Response normalization | `ProviderAdapter.normalize()` to `ProviderCallback` | Interface built |
| Failure handling | Typed failures, timeout, retry to the approved provider only | Built |
| Idempotency | Request id is the idempotency key; callbacks deduplicated by response id | Built |
| Audit | Lifecycle events in PostgreSQL; identifier-only routing and callback logs | Built |
| Reference HTTPS adapter | `integrations/providers/http-partner.ts` | Built and tested with a fake transport. Not registered, not connected |

`tests/backend/provider-adapter.test.ts` holds the conformance checks every transport must pass.

## Adding a provider

1. Write an adapter in `integrations/providers/` implementing `ProviderAdapter`. Provider wire formats, authentication and error mapping stay inside it.
2. Run the conformance tests against it.
3. Register its descriptor and adapter in `platform/providers/index.ts`, with its secret read from server-side configuration.
4. Add its id to the tenant allowlist.

## What a real integration still needs

- A provider, an agreement, and its sandbox credentials and API documentation.
- A decision on real patient data. The envelope, the database and the router refuse anything not marked synthetic. Lifting that needs clinical safety, privacy and data residency review, not a code change alone.
- Durable provider and secret administration per tenant (currently environment variables and code).
- A scheduled poller for providers without callbacks, and rate limiting on the callback route.
- A reassignment path after a provider declines (today the consultation is cancelled and prepared again).

An integration is complete only after a permitted test request reaches an authenticated provider and a verified response comes back. Until then, report the provider as simulated.
