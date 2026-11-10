import "server-only";
import { getTenant } from "@/platform/tenants";
import { getSmartGrant } from "@/platform/auth/smart-session";
import type { ClinicianSession } from "@/platform/auth/session";
import { createFhirConnector } from "./fhir/connector";
import { createOpenEmrConnector } from "./openemr/connector";
import { syntheticClinicalAdapter } from "./mock/connector";

export async function getClinicalDataAdapter(session: ClinicianSession) {
  const { connector } = getTenant();
  if (connector === "synthetic") return syntheticClinicalAdapter;
  const grant = await getSmartGrant(session);
  return connector === "openemr" ? createOpenEmrConnector(grant) : createFhirConnector(grant);
}
