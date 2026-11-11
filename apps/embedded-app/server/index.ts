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
import { getEnv, syntheticStagingEnabled } from "@/platform/tenants/env";
import { localSyntheticEnabled } from "@/platform/auth/session";
import { RouteError } from "@/core/errors";
import { getTenant } from "@/platform/tenants";

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
export { contractResponse, errorResponse, handleRouteError, readJson } from "./http/respond";
export * as authRoutes from "./auth-routes";

export function getConsultations(session: VerifiedLaunch) {
  if (session.source !== "synthetic") throw new RouteError("forbidden", "Consultation generation is limited to synthetic data");
  const actor = session.context;
  const tenant = getTenant();
  if (actor.tenantId !== tenant.id || !actor.encounterId || !actor.scopes.includes("chart:read")) {
    throw new RouteError("forbidden", "An authorized tenant encounter is required");
  }
  const local = localSyntheticEnabled();
  const env = getEnv();
  const mockRouting = syntheticStagingEnabled(env);
  const durable = !local || !!env.STETHOLINK_DATABASE_URL;
  const lifecycle = createConsultationRepository(actor, tenant.recipients);
  const repository = !durable
    ? mockConsultationRepository(tenant.id, actor.clinicianId, actor.patientId, actor.encounterId)
    : lifecycle;
  const { adapter } = getClinicalServices(session);
  const service = createConsultationService({
    repository, provider: getModelProvider(), safety: syntheticSafetyGuard, adapter,
  });
  return {
    get: service.get,
    async revise(id: string, input: Parameters<typeof lifecycle.revise>[1]) {
      if (!durable) throw new RouteError("provider_unavailable", "Configure durable consultation storage");
      const safety = await syntheticSafetyGuard.assess([input.summary, input.assessment, ...input.plan].join("\n"));
      if (safety.level === "blocked") throw new RouteError("safety_blocked", "Revision withheld by safety check");
      return lifecycle.revise(id, input);
    },
    async transition(id: string, input: Parameters<typeof lifecycle.transition>[1]) {
      if (!durable) throw new RouteError("provider_unavailable", "Configure durable consultation storage");
      if (!["submit", "cancel"].includes(input.action) && !mockRouting) {
        throw new RouteError("not_implemented", "Only synthetic mock lifecycle delivery is supported");
      }
      return lifecycle.transition(id, input);
    },
    async history(id: string, beforeVersion?: number) {
      if (!durable) throw new RouteError("provider_unavailable", "Configure durable consultation storage");
      return lifecycle.history(id, beforeVersion);
    },
    create: (input: Parameters<typeof service.create>[0]) => service.create(input, actor),
    async approve(input: Parameters<typeof service.approve>[0]) {
      if (local) throw new RouteError("forbidden", "A verified physician session is required");
      return service.approve(input, actor);
    },
    async route(draftId: string, input: Parameters<typeof lifecycle.dispatch>[1]) {
      if (!mockRouting) throw new RouteError("not_implemented", "Only synthetic mock lifecycle delivery is supported");
      const draft = await lifecycle.dispatch(draftId, input);
      return { draftId: draft.id, recipientId: input.recipientId, status: "submitted" as const };
    },
    async delivery(draftId: string) {
      if (!(await repository.get(draftId))) throw new RouteError("not_found", "Draft not found");
      if (durable) {
        const attempt = (await lifecycle.history(draftId)).attempts[0];
        if (!attempt || !["sent", "accepted", "responded"].includes(attempt.status)) return null;
        return { draftId, recipientId: attempt.recipientId, status: attempt.status === "responded" ? "responded" as const : "submitted" as const };
      }
      return null;
    },
  };
}
