import "server-only";
import { getTenant } from "@/platform/tenants";
import { getEnv } from "@/platform/tenants/env";
import type { VerifiedLaunch } from "@/platform/auth/identity";
import { AuthError } from "@/platform/auth/session";
import { createFhirConnector } from "./fhir/connector";
import { createOpenEmrConnector } from "./openemr/connector";
import { syntheticClinicalAdapter } from "./mock/connector";

export function getClinicalDataAdapter(session: VerifiedLaunch) {
  const { connector, id } = getTenant();
  const context = session.context;
  if (context.tenantId !== id || !context.scopes.includes("chart:read")) throw new AuthError("forbidden", "Chart access denied");
  if (session.source === "synthetic" && connector === "synthetic") {
    return {
      ...syntheticClinicalAdapter,
      async getPatient(id: string) {
        return id === context.patientId ? syntheticClinicalAdapter.getPatient(id) : null;
      },
      async getEncounter(id: string) {
        return id === context.encounterId ? syntheticClinicalAdapter.getEncounter(id) : null;
      },
    };
  }
  const baseUrl = getEnv().FHIR_BASE_URL;
  if (session.source !== "smart" || !baseUrl || !session.ehrAccessToken || connector === "synthetic") {
    throw new AuthError("forbidden", "Chart access denied");
  }
  const grant = { baseUrl, accessToken: session.ehrAccessToken, patientId: context.patientId, encounterId: context.encounterId };
  return connector === "openemr" ? createOpenEmrConnector(grant) : createFhirConnector(grant);
}
