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
import { getEnv } from "@/platform/tenants/env";
import { localSyntheticEnabled } from "@/platform/auth/session";
import { RouteError } from "@/core/errors";
import { getTenant } from "@/platform/tenants";
import { createProviderRouter } from "@/core/routing/router";
import { auditConsultation } from "@/platform/audit";
import { getProviderRegistry, getProviderTransport, providerCallbackSecret, syntheticRoutingEnabled } from "@/platform/providers";
import { CALLBACK_HEADERS, signProviderCallback } from "@/platform/providers/callback-auth";
import { mockSpecialistCallback, mockSpecialistNextStep } from "@/integrations/mock/specialist";
import type { DispatchRequest } from "@/shared/contracts";
import { receiveProviderCallback } from "./provider-callbacks";

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
  const durable = !local || !!getEnv().STETHOLINK_DATABASE_URL;
  const lifecycle = createConsultationRepository(actor, tenant.recipients);
  const repository = !durable
    ? mockConsultationRepository(tenant.id, actor.clinicianId, actor.patientId, actor.encounterId)
    : lifecycle;
  const { adapter } = getClinicalServices(session);
  const service = createConsultationService({
    repository, provider: getModelProvider(), safety: syntheticSafetyGuard, adapter,
  });
  // Routing needs durable storage and is limited to synthetic sessions with synthetic providers.
  const routing = durable && session.source === "synthetic" && syntheticRoutingEnabled();
  const router = createProviderRouter({
    repository: lifecycle, registry: getProviderRegistry(), transport: getProviderTransport, tenantId: tenant.id,
    timeoutMs: getEnv().PROVIDER_TIMEOUT_MS, simulator: routing, audit: auditConsultation,
  });
  function requireRouting() {
    if (!durable) throw new RouteError("provider_unavailable", "Configure durable consultation storage");
    if (!routing) throw new RouteError("not_implemented", "Hospital consultation delivery is not configured");
  }
  return {
    get: service.get,
    list: async () => durable ? lifecycle.list() : [],
    async revise(id: string, input: Parameters<typeof lifecycle.revise>[1]) {
      if (!durable) throw new RouteError("provider_unavailable", "Configure durable consultation storage");
      const safety = await syntheticSafetyGuard.assess([input.summary, input.assessment, ...input.plan].join("\n"));
      if (safety.level === "blocked") throw new RouteError("safety_blocked", "Revision withheld by safety check");
      return lifecycle.revise(id, input);
    },
    /** Clinician bookkeeping only (submit, cancel). Delivery states are never set from here. */
    async transition(id: string, input: Parameters<typeof lifecycle.transition>[1]) {
      if (!durable) throw new RouteError("provider_unavailable", "Configure durable consultation storage");
      return lifecycle.transition(id, input);
    },
    async history(id: string, beforeVersion?: number) {
      if (!durable) throw new RouteError("provider_unavailable", "Configure durable consultation storage");
      return lifecycle.history(id, beforeVersion);
    },
    create: (input: Parameters<typeof service.create>[0]) => service.create(input, actor),
    approve: (input: Parameters<typeof service.approve>[0]) => service.approve(input, actor),
    async route(draftId: string, input: DispatchRequest) {
      requireRouting();
      return router.route(draftId, input, actor);
    },
    async providers(draftId: string) {
      if (!routing) {
        if (!(await repository.get(draftId))) throw new RouteError("not_found", "Draft not found");
        return [];
      }
      return (await router.eligible(draftId)).map(({ id, displayName, specialties, transport }) => ({ id, displayName, specialties, transport }));
    },
    async delivery(draftId: string) {
      if (durable) return router.view(draftId);
      if (!(await repository.get(draftId))) throw new RouteError("not_found", "Draft not found");
      return null;
    },
    /**
     * Demo aid: plays the synthetic specialist's next message. It is signed and sent through
     * the same verification and correlation path as a real provider callback.
     */
    async simulateSpecialist(draftId: string) {
      requireRouting();
      if (!(await lifecycle.get(draftId))) throw new RouteError("not_found", "Draft not found");
      const [latest] = await lifecycle.deliveries(draftId);
      const secret = latest && providerCallbackSecret(latest.providerId);
      if (!latest?.envelope || !secret || !["sent", "accepted"].includes(latest.status)) {
        throw new RouteError("conflict", "There is no delivered synthetic request awaiting a specialist reply");
      }
      const body = JSON.stringify(mockSpecialistCallback(latest.envelope, mockSpecialistNextStep(latest.providerId, latest.status)));
      const timestamp = String(Date.now());
      await receiveProviderCallback(new Headers({
        [CALLBACK_HEADERS.provider]: latest.providerId, [CALLBACK_HEADERS.timestamp]: timestamp,
        [CALLBACK_HEADERS.signature]: signProviderCallback(secret, timestamp, body),
      }), body);
      return router.view(draftId);
    },
  };
}
