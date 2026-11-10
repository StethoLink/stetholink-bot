import "server-only";
import { createChatOrchestrator } from "@/core/agent/orchestrator/orchestrator";
import { getModelProvider } from "@/platform/tenants/model-provider";
import { createPatientContextService } from "@/core/patient-context/service";
import { getClinicalDataAdapter } from "@/integrations";
import { syntheticClinicalAdapter } from "@/integrations/mock/connector";
import { passthroughSafetyGuard } from "@/core/agent/safety/guard";
import { createConsultationRepository } from "@/platform/persistence";
import { mockConsultationRepository } from "@/integrations/mock/repository";
import { createConsultationService } from "@/core/consultation/service";
import type { ClinicianSession } from "@/platform/auth/session";
import { RouteError } from "@/core/errors";
import { getTenant } from "@/platform/tenants";
import { getEnv } from "@/platform/tenants/env";
import { routeConsultation } from "@/core/consultation/routing";
import { auditConsultation } from "@/platform/audit";

export async function getClinicalServices(session: ClinicianSession) {
  const adapter = await getClinicalDataAdapter(session);
  return { adapter, patientContext: createPatientContextService(adapter) };
}

export function getChat() {
  if (getTenant().connector !== "synthetic") {
    throw new RouteError("forbidden", "Chat is limited to synthetic data");
  }
  const patientContext = createPatientContextService(syntheticClinicalAdapter);
  return createChatOrchestrator({
    provider: getModelProvider(),
    safety: passthroughSafetyGuard,
    loadPatientContext: (id) => patientContext.getContext(id),
  });
}

export { requireClinician } from "@/platform/auth/session";
export { contractResponse, errorResponse, handleRouteError } from "./http/respond";
export * as authRoutes from "@/apps/embedded-app/server/auth-routes";

export function getConsultations(session: ClinicianSession) {
  const tenant = getTenant();
  const env = getEnv();
  const repository = session.accessToken
    ? createConsultationRepository(session.accessToken)
    : env.NODE_ENV !== "production" && env.AUTH_MODE === "dev" && tenant.connector === "synthetic"
      ? mockConsultationRepository(tenant.id, session.clinicianId)
      : null;
  if (!repository) throw new RouteError("unauthenticated", "Sign in to save consultations");
  if (tenant.connector !== "synthetic") {
    throw new RouteError("forbidden", "Consultation generation and delivery are limited to synthetic data");
  }
  const adapter = syntheticClinicalAdapter;
  const service = createConsultationService({
    repository, provider: getModelProvider(), safety: passthroughSafetyGuard, adapter,
  });
  return {
    ...service,
    async route(draftId: string, recipientId: string) {
      if (env.NODE_ENV === "production" || !adapter.consultations) {
        throw new RouteError("not_implemented", "Durable hospital consultation delivery is not configured");
      }
      const result = await routeConsultation(repository, adapter.consultations, tenant.recipients, draftId, recipientId);
      if ("code" in result) throw new RouteError(result.code, "Consultation cannot be routed");
      auditConsultation({ action: "consultation.routed", tenantId: tenant.id, clinicianId: session.clinicianId, draftId });
      return result.delivery;
    },
    async delivery(draftId: string) {
      if (!(await repository.get(draftId))) throw new RouteError("not_found", "Draft not found");
      return adapter.consultations?.status(draftId) ?? null;
    },
  };
}
