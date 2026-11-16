import type { ModelProvider } from "@/core/agent/providers/types";
import type { ChartIdentity, SurrogateVault } from "@/core/privacy/ports";
import { createPseudonymizingProvider } from "@/core/privacy/provider";
import type { SurrogateState } from "@/core/privacy/pseudonymizer";

/** A vault for one test: the same map for every call, visible to the test. */
export function testVault(): SurrogateVault<SurrogateState> & { state?: SurrogateState } {
  const vault: SurrogateVault<SurrogateState> & { state?: SurrogateState } = { open: (_key, _expiresAt, create) => vault.state ??= create() };
  return vault;
}

/** The product's de-identification layer around a test's provider, as `getModelProvider()` builds it. */
export function deidentified(provider: ModelProvider, identity: ChartIdentity = { people: [], identifiers: [] }, vault = testVault()): ModelProvider {
  return createPseudonymizingProvider(provider, { sessionKey: "test-session", expiresAt: Date.now() + 600_000, identity: async () => identity }, vault);
}
