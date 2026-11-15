import "server-only";
import { getTenant } from "@/platform/tenants";
import { createProviderRegistry } from "@/core/routing/registry";
import type { ProviderDescriptor } from "@/shared/contracts";
import { createPortalTransport } from "@/integrations/providers/portal";

/** Consultations are sent only to the active, allowlisted services of the tenant's configured directory. */
export function routingEnabled() {
  const tenant = getTenant();
  return tenant.directory.some((provider) => provider.active && tenant.recipients.has(provider.id));
}
/** The tenant's allowed providers. The same allowlist is enforced again inside the database. */
export function getProviderRegistry() {
  const tenant = getTenant();
  return createProviderRegistry(tenant.directory, tenant.recipients);
}
const portalTransport = createPortalTransport();
/** There is no simulated specialist: a provider without a real transport gets none, and the send fails visibly. */
export function getProviderTransport(provider: ProviderDescriptor) {
  return !provider.synthetic && provider.transport === "portal" ? portalTransport : undefined;
}
/**
 * Callback secret of a provider that answers over HTTP. No such transport is registered yet
 * (the specialist inbox is the only one), so no provider has a secret and every callback is refused.
 */
export function providerCallbackSecret(providerId: string): string | undefined {
  void providerId;
  return undefined;
}
