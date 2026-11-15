import "server-only";
import { getEnv, providerDirectory } from "./env";

// One configured tenant per deployment. Supabase deployments also require a dedicated project.
export function getTenant() {
  const env = getEnv();
  return {
    id: env.TENANT_ID,
    connector: env.CLINICAL_DATA_SOURCE,
    /** The one classification every session, draft, envelope and callback of this tenant carries. */
    dataClassification: env.CLINICAL_DATA_MODE,
    // A live tenant sends only to its configured services; the simulated ones exist for synthetic tenants only.
    recipients: new Set((env.CLINICAL_DATA_MODE === "live" ? env.PROVIDER_ALLOWLIST ?? "" : env.MOCK_RECIPIENT_IDS).split(",").map((id) => id.trim()).filter(Boolean)),
    /** Receiving services of a live tenant. */
    directory: env.CLINICAL_DATA_MODE === "live"
      ? providerDirectory(env).map((entry) => ({ ...entry, synthetic: false }))
      : [],
  };
}
