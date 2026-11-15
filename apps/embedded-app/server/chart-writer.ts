import "server-only";
import type { ClinicalWriteAdapter } from "@/core/tools/chart-writer";
import { createFhirWriter } from "@/integrations/fhir/writer";
import type { VerifiedLaunch } from "@/platform/auth/identity";
import { getTenant } from "@/platform/tenants";
import { getEnv } from "@/platform/tenants/env";

/**
 * The EHR writer exists only for a verified SMART session of a tenant configured for live data
 * with write-back switched on. A synthetic session never gets one, so it cannot write to a real
 * EHR; a live session never writes anywhere but its own launched chart.
 */
export function getChartWriter(session: VerifiedLaunch): ClinicalWriteAdapter | null {
  const env = getEnv();
  const tenant = getTenant();
  if (env.EHR_WRITE_ENABLED !== "true" || session.source !== "smart" || !session.ehrAccessToken || !env.FHIR_BASE_URL ||
      tenant.dataClassification !== "live" || session.context.dataClassification !== "live" || !session.context.encounterId || !session.context.scopes.includes("chart:write")) return null;
  return createFhirWriter({
    baseUrl: env.FHIR_BASE_URL, accessToken: session.ehrAccessToken, patientId: session.context.patientId, encounterId: session.context.encounterId,
    practitionerReference: session.ehrUser, grantedScopes: session.context.scopes.filter((scope) => scope.startsWith("smart:")).map((scope) => scope.slice(6)),
  }, fetch, { docStatus: env.FHIR_NOTE_DOC_STATUS, noteTypeCode: env.FHIR_NOTE_TYPE_CODE });
}

