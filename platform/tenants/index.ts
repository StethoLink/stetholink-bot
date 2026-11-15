import "server-only";
import type { DataClassification } from "@/shared/contracts";
import { getEnv, providerDirectory } from "./env";

// One configured tenant per deployment.
export function getTenant() {
  const env = getEnv();
  return {
    id: env.TENANT_ID,
    connector: env.CLINICAL_DATA_SOURCE,
    /**
     * The one classification every session, draft, envelope and callback of this tenant carries.
     * A deployment reads a real EHR, so it is always "live"; "synthetic" survives only as the
     * label of fictional test fixtures and of rows stored by earlier versions, which no session can open.
     */
    dataClassification: "live" as DataClassification,
    recipients: new Set((env.PROVIDER_ALLOWLIST ?? "").split(",").map((id) => id.trim()).filter(Boolean)),
    /** Receiving services of the tenant. */
    directory: providerDirectory(env).map((entry) => ({ ...entry, synthetic: false })),
  };
}
