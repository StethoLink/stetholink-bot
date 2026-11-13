import "server-only";
import { createChatOrchestrator } from "@/core/agent/orchestrator/orchestrator";
import { getModelProvider } from "@/platform/tenants/model-provider";
import { createPatientContextService } from "@/core/patient-context/service";
import { getClinicalDataAdapter } from "@/integrations";
import { clinicalSafetyGuard } from "@/core/agent/safety/guard";
import { createConsultationRepository } from "@/platform/persistence";
import { mockConsultationRepository } from "@/integrations/mock/repository";
import { createConsultationService } from "@/core/consultation/service";
import type { VerifiedLaunch } from "@/platform/auth/identity";
import { getEnv } from "@/platform/tenants/env";
import { localSyntheticEnabled } from "@/platform/auth/session";
import { RouteError } from "@/core/errors";
import { getTenant } from "@/platform/tenants";
import { createProviderRouter } from "@/core/routing/router";
import { eligibleProviders } from "@/core/routing/registry";
import { auditConsultation } from "@/platform/audit";
import { getProviderRegistry, getProviderTransport, providerCallbackSecret, syntheticRoutingEnabled } from "@/platform/providers";
import { CALLBACK_HEADERS, signProviderCallback } from "@/platform/providers/callback-auth";
import { mockSpecialistCallback, mockSpecialistNextStep, syntheticProviderDirectory } from "@/integrations/mock/specialist";
import type { DataSource, DispatchRequest } from "@/shared/contracts";
import { classificationOfSource } from "@/shared/schemas";
import { receiveProviderCallback } from "./provider-callbacks";

export function getClinicalServices(session: VerifiedLaunch) {
  const adapter = getClinicalDataAdapter(session);
  return { adapter, patientContext: createPatientContextService(adapter) };
}

/**
 * One gate for chat and drafting, in both modes. Chart data reaches a model only when its
 * source matches the classification of the verified session: synthetic fixtures for a synthetic
 * tenant, EHR data for a tenant configured for live clinical data. An EHR launch on a tenant
 * that is not configured for live data stays read-only.
 */
function requireAssistantData(session: VerifiedLaunch, adapter: { source: DataSource }) {
  const tenant = getTenant();
  if (session.context.tenantId !== tenant.id || session.context.dataClassification !== tenant.dataClassification) {
    throw new RouteError("forbidden", "The session does not belong to this tenant's data classification");
  }
  if (classificationOfSource(adapter.source) !== tenant.dataClassification) {
    throw new RouteError("forbidden", "The assistant is not enabled for EHR chart data on this tenant (CLINICAL_DATA_MODE)");
  }
}

export function getChat(session: VerifiedLaunch) {
  const { adapter, patientContext } = getClinicalServices(session);
  requireAssistantData(session, adapter);
  return createChatOrchestrator({
    provider: getModelProvider(), safety: clinicalSafetyGuard, dataClassification: session.context.dataClassification,
    loadPatientContext: (id) => patientContext.getContext(id),
  });
}

export { requireClinician } from "@/platform/auth/session";
export { contractResponse, errorResponse, handleRouteError, readJson } from "./http/respond";
export * as authRoutes from "./auth-routes";

export function getConsultations(session: VerifiedLaunch) {
  const actor = session.context;
  const tenant = getTenant();
  if (actor.tenantId !== tenant.id || !actor.encounterId || !actor.scopes.includes("chart:read")) {
    throw new RouteError("forbidden", "An authorized tenant encounter is required");
  }
  const local = localSyntheticEnabled();
  const env = getEnv();
  const durable = !local || !!env.STETHOLINK_DATABASE_URL;
  const lifecycle = createConsultationRepository(actor, tenant.recipients);
  const repository = !durable
    ? mockConsultationRepository(tenant.id, actor.clinicianId, actor.patientId, actor.encounterId)
    : lifecycle;
  const { adapter } = getClinicalServices(session);
  requireAssistantData(session, adapter);
  // The simulated specialists serve synthetic sessions only. A live tenant's provider directory is configured separately.
  const directory = actor.dataClassification === "synthetic" ? syntheticProviderDirectory : [];
  const service = createConsultationService({
    repository, provider: getModelProvider(), safety: clinicalSafetyGuard, adapter, dataClassification: actor.dataClassification,
    // The model is asked to use the spelling of specialties this tenant can actually route to.
    specialties: [...new Set(directory.filter((provider) => provider.active && tenant.recipients.has(provider.id)).flatMap((provider) => provider.specialties))],
  });
  // Routing needs durable storage and a configured provider directory. Today the only directory is
  // the simulated one, which the classification check keeps to synthetic sessions.
  const routing = durable && actor.dataClassification === "synthetic" && syntheticRoutingEnabled();
  const router = createProviderRouter({
    repository: lifecycle, registry: getProviderRegistry(), transport: getProviderTransport, tenantId: tenant.id, dataClassification: actor.dataClassification,
    timeoutMs: env.PROVIDER_TIMEOUT_MS, simulator: routing, audit: auditConsultation,
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
      const safety = await clinicalSafetyGuard.assess([input.summary, input.assessment, ...input.plan].join("\n"));
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
    /** Natural-language revision by the model. The result always returns to physician review. */
    async reviseWithModel(id: string, input: Parameters<typeof service.reviseWithModel>[1]) {
      if (!durable) throw new RouteError("provider_unavailable", "Configure durable consultation storage");
      const result = await service.reviseWithModel(id, input, actor, lifecycle);
      auditConsultation({ action: "consultation.model_revised", tenantId: tenant.id, clinicianId: actor.clinicianId, draftId: id });
      return result.draft;
    },
    async approve(input: Parameters<typeof service.approve>[0]) {
      if (local) throw new RouteError("forbidden", "A verified physician session is required");
      if (!actor.roles.includes("physician") || !actor.scopes.includes("consultation:approve")) throw new RouteError("forbidden", "Physician approval is required");
      // When the consultation names a specialty, the destination must be an active, allowlisted provider
      // offering it. The database enforces the allowlist again and binds the approval to this destination.
      if (input.decision === "approve" && routing) {
        const draft = await repository.get(input.draftId);
        if (draft?.grounding?.specialty && !eligibleProviders(await getProviderRegistry().list(), draft.grounding.specialty).some((provider) => provider.id === input.recipientId)) {
          throw new RouteError("forbidden", "Choose a provider that is allowed for this consultation");
        }
      }
      return service.approve(input, actor);
    },
    async route(draftId: string, input: DispatchRequest) {
      requireRouting();
      return router.route(draftId, input, actor);
    },
    /** Destinations the physician may approve this consultation for. */
    async providers(draftId: string) {
      if (!routing) {
        if (!(await repository.get(draftId))) throw new RouteError("not_found", "Draft not found");
        return [];
      }
      return (await router.eligible(draftId)).map(({ id, displayName, specialties, transport, synthetic }) => ({ id, displayName, specialties, transport, synthetic }));
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
