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
import { getProviderRegistry, getProviderTransport, liveRoutingEnabled, providerCallbackSecret, syntheticRoutingEnabled } from "@/platform/providers";
import { CALLBACK_HEADERS, signProviderCallback } from "@/platform/providers/callback-auth";
import { mockSpecialistCallback, mockSpecialistNextStep, syntheticProviderDirectory } from "@/integrations/mock/specialist";
import type { DataSource, DispatchRequest } from "@/shared/contracts";
import { classificationOfSource } from "@/shared/schemas";
import { receiveProviderCallback } from "./provider-callbacks";
import { getChartWriter } from "./chart-writer";
import { createChartWriteLedger } from "@/platform/persistence/scribe";
import type { ChartWriteItem } from "@/core/tools/chart-writer";
import type { ChartWriteResult } from "@/shared/contracts";
import { parseStatement } from "@/shared/utils/referral-text";

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
export function requireAssistantData(session: VerifiedLaunch, adapter: { source: DataSource }) {
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
  // Product decision: free-text chat would send the whole patient summary to the model, so it stays off for real patients.
  if (session.context.dataClassification === "live") throw new RouteError("not_implemented", "Free-text chat is not available with real patient data. Use a consultation request instead.");
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
  const directory = actor.dataClassification === "synthetic" ? syntheticProviderDirectory : tenant.directory;
  const service = createConsultationService({
    repository, provider: getModelProvider(), safety: clinicalSafetyGuard, adapter, dataClassification: actor.dataClassification,
    // The model is asked to use the spelling of specialties this tenant can actually route to.
    specialties: [...new Set(directory.filter((provider) => provider.active && tenant.recipients.has(provider.id)).flatMap((provider) => provider.specialties))],
  });
  // Routing needs durable storage and a configured provider directory. Today the only directory is
  // the simulated one, which the classification check keeps to synthetic sessions.
  const simulated = durable && actor.dataClassification === "synthetic" && syntheticRoutingEnabled();
  const routing = simulated || (durable && actor.dataClassification === "live" && liveRoutingEnabled());
  const router = createProviderRouter({
    repository: lifecycle, registry: getProviderRegistry(), transport: getProviderTransport, tenantId: tenant.id, dataClassification: actor.dataClassification,
    timeoutMs: env.PROVIDER_TIMEOUT_MS, simulator: simulated, audit: auditConsultation,
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
    /**
     * Writes the approved consultation, and the specialist's report once received, to the chart as
     * clinical notes. Physician only; each document is created at most once; where the EHR takes
     * no write, the text is returned for copying. With `write` false it only reports what was written.
     */
    async chart(draftId: string, write: readonly ("consultation" | "report")[] = []): Promise<ChartWriteResult[]> {
      if (!durable) throw new RouteError("provider_unavailable", "Configure durable consultation storage");
      const draft = await lifecycle.get(draftId);
      if (!draft) throw new RouteError("not_found", "Draft not found");
      const status = draft.lifecycleStatus ?? draft.status;
      if (!["approved", "queued", "sent", "accepted", "responded", "failed"].includes(status)) return [];
      // Citation markers are for the review screen; the chart note is the approved wording alone.
      const plain = (text: string) => text.split("\n").map((line) => /^\s*[-•]/.test(line) ? `- ${parseStatement(line).text}` : line).join("\n");
      const key = (item: string) => `sl-${draftId.replaceAll("-", "").slice(0, 40)}-${item}`;
      const report = status === "responded" ? (await lifecycle.responses(draftId)).findLast((response) => response.kind === "report")?.report : undefined;
      const documents: { item: "consultation" | "report"; origin: "consultation" | "specialist_report"; write: Extract<ChartWriteItem, { kind: "document" }> }[] = [
        { item: "consultation", origin: "consultation", write: { kind: "document", itemKey: key("consult"), documentType: "consultation_request", language: "en",
          title: `Consultation request: ${draft.grounding?.specialty ?? "specialist"}`, text: [plain(draft.summary), plain(draft.assessment)].filter(Boolean).join("\n\n") } },
        ...(report ? [{ item: "report" as const, origin: "specialist_report" as const, write: { kind: "document" as const, itemKey: key("report"), documentType: "specialist_report" as const, language: "en",
          title: `Specialist reply: ${draft.grounding?.specialty ?? "consultation"}`,
          text: [`Reply from ${report.responder}`, report.summary, ...(report.recommendations.length ? ["Recommendations:", ...report.recommendations.map((line) => `- ${line}`)] : [])].join("\n") } }] : []),
      ];
      const ledger = createChartWriteLedger(actor);
      if (write.length) {
        if (!actor.roles.includes("physician") || !actor.scopes.includes("chart:write")) throw new RouteError("forbidden", "Only the physician can write to the chart");
        const writer = getChartWriter(session);
        for (const document of documents.filter((entry) => write.includes(entry.item))) {
          // The database opens the ledger row only for a consultation this physician session may write, in an approved state.
          const opened = await ledger.begin(document.origin, draftId, document.write.itemKey, "DocumentReference");
          if (opened.status === "created" || opened.status === "existing") continue;
          const outcome = writer ? await writer.create(document.write) : { status: "unsupported" as const, resourceType: "DocumentReference" as const, failure: "Writing to the chart is not switched on for this session" };
          await ledger.record(document.write.itemKey, outcome.status, outcome.resourceId, outcome.failure);
          auditConsultation({ action: "chart.write", tenantId: tenant.id, clinicianId: actor.clinicianId, draftId, itemKey: document.write.itemKey, resourceType: "DocumentReference", status: outcome.status, resourceId: outcome.resourceId });
        }
      }
      const stored = await ledger.forOrigin(["consultation", "specialist_report"], draftId);
      return documents.map((document) => {
        const row = stored.find((entry) => entry.itemKey === document.write.itemKey);
        const done = row?.status === "created" || row?.status === "existing";
        return { itemKey: document.write.itemKey, item: document.item, resourceType: "DocumentReference", status: row?.status ?? "pending", resourceId: row?.resourceId, failure: row?.failure,
          ...(done ? {} : { copyText: document.write.text }) };
      });
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
      if (!simulated) throw new RouteError("not_implemented", "There is no simulated specialist for real patient data");
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
