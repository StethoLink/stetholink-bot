import "server-only";
import { getEnv } from "./env";

// One configured tenant per deployment. Supabase deployments also require a dedicated project.
export function getTenant() {
  const env = getEnv();
  return {
    id: env.TENANT_ID,
    connector: env.CLINICAL_DATA_SOURCE,
    recipients: new Set(env.MOCK_RECIPIENT_IDS.split(",").map((id) => id.trim()).filter(Boolean)),
  };
}
