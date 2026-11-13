import "server-only";
import { createHmac } from "node:crypto";
import { getEnv, syntheticStagingEnabled } from "@/platform/tenants/env";
import { getTenant } from "@/platform/tenants";
import { localSyntheticEnabled } from "@/platform/auth/session";
import { createProviderRegistry } from "@/core/routing/registry";
import type { ProviderDescriptor } from "@/shared/contracts";
import { createMockSpecialistTransport, syntheticProviderDirectory } from "@/integrations/mock/specialist";

/**
 * The simulated specialists exist only for a synthetic tenant in local development or preview
 * staging. They are never available to a tenant configured for live clinical data.
 */
export function syntheticRoutingEnabled() {
  return getTenant().dataClassification === "synthetic" && (localSyntheticEnabled() || syntheticStagingEnabled(getEnv()));
}

/** The tenant's allowed providers. The same allowlist is enforced again inside the database. */
export function getProviderRegistry() {
  return createProviderRegistry(syntheticRoutingEnabled() ? syntheticProviderDirectory : [], getTenant().recipients);
}

const mockTransport = createMockSpecialistTransport();
export function getProviderTransport(provider: ProviderDescriptor) {
  return syntheticRoutingEnabled() && provider.synthetic && provider.transport === "mock" ? mockTransport : undefined;
}

/**
 * Per-provider callback secret for the synthetic specialists. Deployed previews must use
 * a server-side secret; the fixed development value works only on a local machine.
 */
export function providerCallbackSecret(providerId: string) {
  const env = getEnv();
  if (!syntheticRoutingEnabled() || !getTenant().recipients.has(providerId)) return undefined;
  const provider = syntheticProviderDirectory.find((candidate) => candidate.id === providerId);
  if (!provider?.active || provider.transport !== "mock") return undefined;
  const root = env.MOCK_PROVIDER_SECRET ?? env.STAGING_LAUNCH_SECRET ??
    (localSyntheticEnabled() ? "local-development-only-mock-provider-secret" : undefined);
  return root && createHmac("sha256", root).update(`stetholink-provider-callback:${providerId}`).digest("hex");
}
