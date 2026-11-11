import type { ClinicianContext } from "@/core/auth/clinician";
import { RouteError } from "@/core/errors";
import type { ConsultationDeliveryView, ConsultationDraft, ConsultationEnvelopeContent, DispatchRequest, ProviderDescriptor } from "@/shared/contracts";
import { consultationEnvelopeContentSchema, consultationEnvelopeSchema, dispatchRequestSchema } from "@/shared/schemas";
import { ProviderTransportError, type DeliveryRecord, type DeliveryRepository, type ProviderRegistry, type ProviderTransport, type TransportFailure } from "./ports";
import { eligibleProviders } from "./registry";

export interface RoutingEvent {
  action: "consultation.dispatched" | "consultation.dispatch_failed";
  tenantId: string;
  clinicianId: string;
  draftId: string;
  requestId: string;
  providerId: string;
  failureCode?: TransportFailure;
}

const lifecycle = (draft: ConsultationDraft) => draft.lifecycleStatus ?? draft.status;
const IN_FLIGHT = ["queued", "sent", "accepted", "responded"];

/** The exact, minimal content a provider receives. No demographics or chart identifiers. */
export function buildEnvelope(draft: ConsultationDraft, provider: ProviderDescriptor, tenantId: string): ConsultationEnvelopeContent {
  const grounding = draft.grounding;
  if (lifecycle(draft) !== "approved" && lifecycle(draft) !== "failed") throw new RouteError("conflict", "Physician approval is required before routing");
  if (!draft.reviewedBy || !draft.reviewedAt) throw new RouteError("conflict", "Physician approval is required before routing");
  if (!grounding?.provenance.syntheticOnly) throw new RouteError("forbidden", "Only synthetic consultations can be routed");
  if (!grounding.specialty?.trim() || !grounding.question?.trim()) {
    throw new RouteError("conflict", "The consultation needs a specialty and clinical question before routing");
  }
  const parsed = consultationEnvelopeContentSchema.safeParse({
    contractVersion: "1.0", tenantId, providerId: provider.id,
    specialty: grounding.specialty, reason: grounding.reason, question: grounding.question,
    summary: draft.summary, assessment: draft.assessment, plan: draft.plan,
    clinicalFacts: draft.clinicalFacts ?? [], missingInformation: draft.missingInformation ?? [],
    attachments: draft.attachments ?? [], safetyFlags: grounding.safetyFlags,
    approval: { approvedBy: draft.reviewedBy, approvedAt: draft.reviewedAt }, syntheticOnly: true,
  });
  if (!parsed.success) throw new RouteError("conflict", "The approved consultation cannot be packaged for a provider");
  return parsed.data;
}

export function deliveryView(draft: ConsultationDraft, attempts: DeliveryRecord[], responses: ConsultationDeliveryView["responses"],
  providers: readonly ProviderDescriptor[], simulator: boolean): ConsultationDeliveryView {
  const status = lifecycle(draft);
  const latest = attempts[0];
  const provider = latest ? providers.find((candidate) => candidate.id === latest.providerId) : undefined;
  return {
    draftId: draft.id, version: draft.version ?? 1, status,
    provider: latest ? { id: latest.providerId, displayName: provider?.displayName ?? latest.providerId, transport: provider?.transport ?? "mock" } : null,
    attempts: attempts.map((attempt) => ({ requestId: attempt.requestId, number: attempt.number, providerId: attempt.providerId,
      status: attempt.status, failureCode: attempt.failureCode, createdAt: attempt.createdAt, updatedAt: attempt.updatedAt })),
    responses,
    report: latest ? responses.findLast((response) => response.kind === "report" && response.requestId === latest.requestId) ?? null : null,
    canSend: status === "approved",
    canRetry: status === "failed" && latest?.status === "failed",
    canSimulate: simulator && !!latest && provider?.transport === "mock" && ["sent", "accepted"].includes(latest.status) && ["sent", "accepted"].includes(status),
  };
}

export function createProviderRouter(deps: {
  repository: DeliveryRepository;
  registry: ProviderRegistry;
  transport(provider: ProviderDescriptor): ProviderTransport | undefined;
  tenantId: string;
  timeoutMs?: number;
  simulator?: boolean;
  audit?(event: RoutingEvent): void;
}) {
  const timeoutMs = deps.timeoutMs ?? 10_000;

  async function view(draftId: string) {
    const draft = await deps.repository.get(draftId);
    if (!draft) throw new RouteError("not_found", "Draft not found");
    const [attempts, responses, providers] = await Promise.all([deps.repository.deliveries(draftId), deps.repository.responses(draftId), deps.registry.list()]);
    return deliveryView(draft, attempts, responses, providers, deps.simulator ?? false);
  }

  /** Transmits a queued request once and records the outcome. Safe to call again after a crash. */
  async function transmit(draftId: string, actor: ClinicianContext) {
    const [current] = await deps.repository.deliveries(draftId);
    if (current?.status !== "queued") return;
    const provider = (await deps.registry.list()).find((candidate) => candidate.id === current.providerId);
    if (!provider) throw new RouteError("forbidden", "Recipient is not allowed for this tenant");
    const event = { tenantId: deps.tenantId, clinicianId: actor.clinicianId, draftId, requestId: current.requestId, providerId: provider.id };
    let failureCode: TransportFailure | undefined;
    let providerReference = "";
    const transport = deps.transport(provider);
    const envelope = consultationEnvelopeSchema.safeParse(current.envelope);
    if (!transport || !envelope.success || envelope.data.requestId !== current.requestId || envelope.data.providerId !== provider.id) {
      failureCode = "transport_error";
    } else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const ack = await Promise.race([
          transport.send(envelope.data),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ProviderTransportError("transport_timeout", "Provider did not answer in time")), timeoutMs); }),
        ]);
        if (ack?.requestId !== current.requestId || typeof ack.providerReference !== "string" || !ack.providerReference || ack.providerReference.length > 256) {
          failureCode = "invalid_acknowledgement";
        } else providerReference = ack.providerReference;
      } catch (error) {
        failureCode = error instanceof ProviderTransportError ? error.code : "transport_error";
      } finally {
        clearTimeout(timer);
      }
    }
    if (failureCode) {
      await deps.repository.recordDispatchResult(current.requestId, { outcome: "failed", failureCode });
      deps.audit?.({ action: "consultation.dispatch_failed", ...event, failureCode });
    } else {
      await deps.repository.recordDispatchResult(current.requestId, { outcome: "sent", providerReference });
      deps.audit?.({ action: "consultation.dispatched", ...event });
    }
  }

  return {
    view,
    /** Providers the physician may choose for this consultation. */
    async eligible(draftId: string) {
      const draft = await deps.repository.get(draftId);
      if (!draft) throw new RouteError("not_found", "Draft not found");
      return eligibleProviders(await deps.registry.list(), draft.grounding?.specialty);
    },
    /**
     * The only path that sends a consultation. Authority comes from the verified physician
     * session and the stored approval; nothing generated by a model can reach this function.
     */
    async route(draftId: string, request: DispatchRequest, actor: ClinicianContext) {
      if (actor.authorization !== "active" || actor.expiresAt <= Date.now() || actor.tenantId !== deps.tenantId ||
          !actor.roles.includes("physician") || !actor.scopes.includes("consultation:approve")) {
        throw new RouteError("forbidden", "Physician authorization is required to send a consultation");
      }
      const input = dispatchRequestSchema.safeParse(request);
      if (!input.success) throw new RouteError("invalid_request", "Invalid routing request");
      const draft = await deps.repository.get(draftId);
      if (!draft) throw new RouteError("not_found", "Draft not found");
      const status = lifecycle(draft);
      if (IN_FLIGHT.includes(status)) {
        // Repeating the command for the same provider resumes or reports; it never sends twice.
        const [latest] = await deps.repository.deliveries(draftId);
        if (latest?.providerId !== input.data.providerId) throw new RouteError("conflict", "This consultation was already routed to another provider");
      } else {
        const provider = (await deps.registry.list()).find((candidate) => candidate.id === input.data.providerId);
        if (!provider) throw new RouteError("forbidden", "Recipient is not allowed for this tenant");
        const envelope = buildEnvelope(draft, provider, deps.tenantId);
        if (!eligibleProviders([provider], envelope.specialty).length) throw new RouteError("forbidden", "Recipient does not offer the requested specialty");
        if (!deps.transport(provider)) throw new RouteError("not_implemented", "No transport is configured for this provider");
        await deps.repository.dispatch(draftId, { ...input.data, envelope });
      }
      await transmit(draftId, actor);
      return view(draftId);
    },
  };
}
