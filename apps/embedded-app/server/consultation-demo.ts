import "server-only";
import type { VerifiedLaunch } from "@/platform/auth/identity";
import { localSyntheticEnabled } from "@/platform/auth/session";
import { getTenant } from "@/platform/tenants";
import { getEnv } from "@/platform/tenants/env";
import { getModelProvider } from "@/platform/tenants/model-provider";
import { createConsultationService } from "@/core/consultation/service";
import { clinicalSafetyGuard } from "@/core/agent/safety/guard";
import { RouteError } from "@/core/errors";
import { getClinicalDataAdapter } from "@/integrations";
import { ahmedConsultationRequest } from "@/shared/mocks/synthetic-data";
import type { ConsultationRepository } from "@/core/consultation/repository";

const noPersistence: ConsultationRepository = {
  async get() { throw new RouteError("forbidden", "Demo previews cannot access saved drafts"); },
  async create() { throw new RouteError("forbidden", "Demo previews cannot save drafts"); },
  async approve() { throw new RouteError("forbidden", "Demo previews cannot approve drafts"); },
};

/** Fixed synthetic case, verified host session, no persistence or delivery capability. */
export async function previewConsultationDemo(session: VerifiedLaunch) {
  if (process.env.VERCEL_ENV !== "preview" && getEnv().NODE_ENV === "production") {
    throw new RouteError("forbidden", "Consultation demo is available only in staging or local development");
  }
  if (process.env.VERCEL_ENV === "production") throw new RouteError("forbidden", "Consultation demo is disabled in production");
  if (localSyntheticEnabled() || session.context.authorization !== "active" || session.context.expiresAt <= Date.now() ||
      !session.context.roles.some((role) => role === "clinician" || role === "physician")) throw new RouteError("unauthenticated", "A verified clinician session is required for the demo");
  const { patientId, encounterId, scopes } = session.context;
  if (session.source !== "synthetic" || session.context.dataClassification !== "synthetic" || getTenant().connector !== "synthetic" || !scopes.includes("consultation:draft") ||
      patientId !== ahmedConsultationRequest.patientId || encounterId !== ahmedConsultationRequest.encounterId) {
    throw new RouteError("forbidden", "Open the authorized synthetic demo chart");
  }
  const service = createConsultationService({
    repository: noPersistence, adapter: getClinicalDataAdapter(session),
    provider: getModelProvider(), safety: clinicalSafetyGuard, dataClassification: session.context.dataClassification,
  });
  return service.preview({ patientId, encounterId }, ahmedConsultationRequest);
}
