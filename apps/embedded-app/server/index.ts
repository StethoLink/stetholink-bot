import "server-only";
import { createChatOrchestrator } from "@/core/agent/orchestrator/orchestrator";
import { getModelProvider } from "@/platform/tenants/model-provider";
import { createPatientContextService } from "@/core/patient-context/service";
import { getClinicalDataAdapter } from "@/integrations";
import { syntheticSafetyGuard } from "@/core/agent/safety/guard";
import { createConsultationRepository } from "@/platform/persistence";
import { mockConsultationRepository } from "@/integrations/mock/repository";
import { createConsultationService } from "@/core/consultation/service";
import type { VerifiedLaunch } from "@/platform/auth/identity";
import { localSyntheticEnabled } from "@/platform/auth/session";
import { RouteError } from "@/core/errors";
import { getTenant } from "@/platform/tenants";
import { routeConsultation } from "@/core/consultation/routing";
import { auditConsultation } from "@/platform/audit";

export function getClinicalServices(session: VerifiedLaunch) {
  const adapter = getClinicalDataAdapter(session);
  return { adapter, patientContext: createPatientContextService(adapter) };
}

export function getChat(session: VerifiedLaunch) {
  if (session.source !== "synthetic") throw new RouteError("forbidden", "Chat is limited to synthetic data");
  const { patientContext } = getClinicalServices(session);
  return createChatOrchestrator({
    provider: getModelProvider(), safety: syntheticSafetyGuard,
    loadPatientContext: (id) => patientContext.getContext(id),
  });
}

export { requireClinician } from "@/platform/auth/session";
export { contractResponse, errorResponse, handleRouteError } from "./http/respond";
export * as authRoutes from "./auth-routes";

export function getConsultations(session: VerifiedLaunch) {
  if (session.source !== "synthetic") throw new RouteError("forbidden", "Consultation generation is limited to synthetic data");
  const actor = session.context;
  const tenant = getTenant();
  const local = localSyntheticEnabled();
  const repository = local
    ? mockConsultationRepository(tenant.id, actor.clinicianId, actor.patientId, actor.encounterId)
    : createConsultationRepository(actor);
  const { adapter } = getClinicalServices(session);
  const service = createConsultationService({
    repository, provider: getModelProvider(), safety: syntheticSafetyGuard, adapter,
  });
  return {
    get: service.get,
    create: (input: Parameters<typeof service.create>[0]) => service.create(input, actor),
    approve: (input: Parameters<typeof service.approve>[0]) => service.approve(input, actor),
    async route(draftId: string, recipientId: string) {
      if (!local || !adapter.consultations) throw new RouteError("not_implemented", "Durable hospital consultation delivery is not configured");
      const result = await routeConsultation(repository, adapter.consultations, tenant.recipients, draftId, recipientId);
      if ("code" in result) throw new RouteError(result.code, "Consultation cannot be routed");
      auditConsultation({ action: "consultation.routed", tenantId: tenant.id, clinicianId: actor.clinicianId, draftId });
      return result.delivery;
    },
    async delivery(draftId: string) {
      if (!(await repository.get(draftId))) throw new RouteError("not_found", "Draft not found");
      return local ? adapter.consultations?.status(draftId) ?? null : null;
    },
  };
}
