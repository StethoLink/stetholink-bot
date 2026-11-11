import { describe, expect, it, vi } from "vitest";
import type { ClinicianContext } from "@/core/auth/clinician";
import { RouteError } from "@/core/errors";
import { ProviderTransportError, type DeliveryRecord, type DeliveryRepository, type ProviderTransport } from "@/core/routing/ports";
import { createProviderRegistry, eligibleProviders } from "@/core/routing/registry";
import { createProviderResponseService } from "@/core/routing/responses";
import { buildEnvelope, createProviderRouter } from "@/core/routing/router";
import { toolRegistry } from "@/core/tools/registry";
import { createConsultationService } from "@/core/consultation/service";
import { mockProvider } from "@/core/agent/providers/mock-provider";
import { syntheticSafetyGuard } from "@/core/agent/safety/guard";
import { syntheticClinicalAdapter } from "@/integrations/mock/connector";
import { createMockSpecialistTransport, mockSpecialistCallback, mockSpecialistNextStep, syntheticProviderDirectory } from "@/integrations/mock/specialist";
import { signProviderCallback, verifyProviderCallback, CALLBACK_HEADERS } from "@/platform/providers/callback-auth";
import type { ConsultationDraft, ConsultationEnvelope, ProviderCallback } from "@/shared/contracts";
import { consultationEnvelopeSchema, createConsultationDraftRequestSchema, providerCallbackSchema, transitionRequestSchema } from "@/shared/schemas";
import { ahmedConsultationRequest, ahmedPatient } from "@/shared/mocks/synthetic-data";

const TENANT = "synthetic-tenant";
const physician: ClinicianContext = {
  clinicianId: "11111111-1111-4111-8111-111111111111", tenantId: TENANT, roles: ["physician"],
  scopes: ["chart:read", "consultation:draft", "consultation:approve"], patientId: "syn-pt-ahmed", encounterId: "syn-enc-ahmed",
  expiresAt: Date.now() + 600_000, authorization: "active",
};
const allowed = new Set(["synthetic-cardiology", "synthetic-cardiology-offline", "synthetic-radiology", "synthetic-cardiology-suspended"]);
const registry = createProviderRegistry(syntheticProviderDirectory, allowed);

async function approvedDraft(): Promise<ConsultationDraft> {
  const service = createConsultationService({
    repository: { get: vi.fn(), approve: vi.fn(), create: vi.fn(async (draft) => draft) },
    provider: mockProvider, safety: syntheticSafetyGuard, adapter: syntheticClinicalAdapter,
  });
  const draft = await service.create({ patientId: "syn-pt-ahmed", specialty: ahmedConsultationRequest.specialty, clinicalQuestion: ahmedConsultationRequest.clinicalQuestion }, physician);
  return { ...draft, status: "approved", lifecycleStatus: "approved", version: 2, tenantId: TENANT,
    reviewedBy: physician.clinicianId, reviewedAt: "2026-01-15T10:05:00.000Z" };
}

/** Minimal stand-in for the durable store; the real state machine is tested against PostgreSQL. */
function memoryRepository(initial: ConsultationDraft) {
  let draft = initial;
  const attempts: DeliveryRecord[] = [];
  const keys = new Map<string, ConsultationDraft>();
  const bump = (status: ConsultationDraft["status"]) => (draft = { ...draft, status, lifecycleStatus: status, version: draft.version! + 1 });
  const repository: DeliveryRepository = {
    get: async (id) => id === draft.id ? draft : null,
    async dispatch(_id, input) {
      const cached = keys.get(input.idempotencyKey);
      if (cached) return cached;
      if (input.expectedVersion !== draft.version || !["approved", "failed"].includes(draft.status)) throw new RouteError("conflict", "Stale");
      if (attempts[0] && attempts[0].providerId !== input.providerId) throw new RouteError("conflict", "Redirect");
      const requestId = crypto.randomUUID();
      const now = new Date().toISOString();
      attempts.unshift({ requestId, number: attempts.length + 1, providerId: input.providerId, status: "queued", createdAt: now, updatedAt: now,
        envelope: { ...input.envelope, requestId, attempt: attempts.length + 1 } });
      keys.set(input.idempotencyKey, bump("queued"));
      return draft;
    },
    async recordDispatchResult(requestId, result) {
      const attempt = attempts.find((candidate) => candidate.requestId === requestId)!;
      if (attempt.status !== "queued") return draft;
      attempt.status = result.outcome;
      if (result.outcome === "failed") attempt.failureCode = result.failureCode;
      return bump(result.outcome);
    },
    deliveries: async () => attempts.map((attempt) => ({ ...attempt })),
    responses: async () => [],
  };
  return { repository, attempts, set: (next: Partial<ConsultationDraft>) => (draft = { ...draft, ...next }) };
}

function setup(draft: ConsultationDraft, transport: ProviderTransport = createMockSpecialistTransport(), timeoutMs = 200) {
  const store = memoryRepository(draft);
  const send = vi.spyOn(transport, "send");
  const audit = vi.fn();
  const router = createProviderRouter({ repository: store.repository, registry, transport: () => transport, tenantId: TENANT, timeoutMs, simulator: true, audit });
  const command = (providerId = "synthetic-cardiology", key = "key-1", version = 2) => ({ providerId, expectedVersion: version, idempotencyKey: key });
  return { ...store, router, send, audit, command };
}

describe("provider registry and eligibility", () => {
  it("lists only active providers on the tenant allowlist", async () => {
    expect((await registry.list()).map((provider) => provider.id)).toEqual(["synthetic-cardiology", "synthetic-cardiology-offline", "synthetic-radiology"]);
    expect(await createProviderRegistry(syntheticProviderDirectory, new Set()).list()).toEqual([]);
  });

  it("requires a matching specialty and never treats a missing specialty as a wildcard", async () => {
    const providers = await registry.list();
    expect(eligibleProviders(providers, " cardiology ").map((provider) => provider.id)).toEqual(["synthetic-cardiology", "synthetic-cardiology-offline"]);
    expect(eligibleProviders(providers, null)).toEqual([]);
    expect(eligibleProviders(providers, "Dermatology")).toEqual([]);
  });
});

describe("provider router", () => {
  it("sends the approved consultation once and records the acknowledgement", async () => {
    const draft = await approvedDraft();
    const { router, send, command, audit, attempts } = setup(draft);
    await expect(router.route("unknown-draft", command(), physician)).rejects.toMatchObject({ code: "not_found" });
    expect(send).not.toHaveBeenCalled();
    const result = await router.route(draft.id, command(), physician);
    expect(result).toMatchObject({ status: "sent", provider: { id: "synthetic-cardiology" }, canSend: false, canRetry: false, canSimulate: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "consultation.dispatched", requestId: attempts[0].requestId }));
  });

  it("never sends twice when the same or a new command is repeated", async () => {
    const draft = await approvedDraft();
    const { router, send, command, attempts } = setup(draft);
    await router.route(draft.id, command(), physician);
    await router.route(draft.id, command(), physician);
    await router.route(draft.id, command("synthetic-cardiology", "another-key", 3), physician);
    expect(send).toHaveBeenCalledTimes(1);
    expect(attempts).toHaveLength(1);
    await expect(router.route(draft.id, command("synthetic-cardiology-offline", "redirect", 3), physician)).rejects.toMatchObject({ code: "conflict" });
  });

  it("resumes a request that was recorded but not yet transmitted", async () => {
    const draft = await approvedDraft();
    const { router, repository, send, command, attempts } = setup(draft);
    await repository.dispatch(draft.id, { ...command(), envelope: buildEnvelope(draft, (await registry.list())[0], TENANT) });
    expect(attempts[0].status).toBe("queued");
    expect((await router.route(draft.id, command(), physician)).status).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].requestId).toBe(attempts[0].requestId);
  });

  it.each([
    ["an unapproved draft", { status: "pending_approval", lifecycleStatus: "pending_review", reviewedBy: undefined, reviewedAt: undefined }, "conflict"],
    ["a status of approved without a recorded reviewer", { reviewedBy: undefined }, "conflict"],
    ["a rejected draft", { status: "rejected", lifecycleStatus: "rejected" }, "conflict"],
    ["a cancelled draft", { status: "cancelled", lifecycleStatus: "cancelled" }, "conflict"],
  ] as const)("refuses %s", async (_name, change, code) => {
    const draft = { ...(await approvedDraft()), ...change } as ConsultationDraft;
    const { router, send, command, attempts } = setup(draft);
    await expect(router.route(draft.id, command(), physician)).rejects.toMatchObject({ code });
    expect(send).not.toHaveBeenCalled();
    expect(attempts).toHaveLength(0);
  });

  it("refuses a consultation without a specialty and question", async () => {
    const draft = await approvedDraft();
    const incomplete = { ...draft, grounding: { ...draft.grounding!, specialty: null, question: null } };
    const { router, send, command } = setup(incomplete);
    await expect(router.route(draft.id, command(), physician)).rejects.toMatchObject({ code: "conflict" });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["not on the tenant allowlist", "synthetic-cardiology-declines"],
    ["unknown", "attacker-endpoint"],
    ["suspended", "synthetic-cardiology-suspended"],
    ["of another specialty", "synthetic-radiology"],
  ])("refuses a provider that is %s", async (_name, providerId) => {
    const draft = await approvedDraft();
    const { router, send, command, attempts } = setup(draft);
    await expect(router.route(draft.id, command(providerId), physician)).rejects.toMatchObject({ code: "forbidden" });
    expect(send).not.toHaveBeenCalled();
    expect(attempts).toHaveLength(0);
  });

  it.each([
    ["a non-physician", { roles: ["clinician"] }],
    ["a session without the approval scope", { scopes: ["chart:read", "consultation:draft"] }],
    ["an expired session", { expiresAt: Date.now() - 1 }],
    ["another tenant's session", { tenantId: "other-tenant" }],
  ] as const)("refuses %s", async (_name, change) => {
    const draft = await approvedDraft();
    const { router, send, command } = setup(draft);
    await expect(router.route(draft.id, command(), { ...physician, ...change } as ClinicianContext)).rejects.toMatchObject({ code: "forbidden" });
    expect(send).not.toHaveBeenCalled();
  });

  it("records a provider failure and retries as a new request to the same provider", async () => {
    const draft = await approvedDraft();
    const { router, send, command, attempts, audit } = setup(draft);
    const failed = await router.route(draft.id, command("synthetic-cardiology-offline"), physician);
    expect(failed).toMatchObject({ status: "failed", canRetry: true, canSimulate: false });
    expect(failed.attempts[0].failureCode).toBe("transport_error");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "consultation.dispatch_failed", failureCode: "transport_error" }));
    await expect(router.route(draft.id, command("synthetic-cardiology", "redirect", 4), physician)).rejects.toMatchObject({ code: "conflict" });
    await router.route(draft.id, command("synthetic-cardiology-offline", "retry", 4), physician);
    expect(send).toHaveBeenCalledTimes(2);
    expect(attempts).toHaveLength(2);
    expect(attempts[0].requestId).not.toBe(attempts[1].requestId);
  });

  it("times out a silent provider and rejects an acknowledgement for a different request", async () => {
    const draft = await approvedDraft();
    const silent = setup(draft, { kind: "mock", send: () => new Promise(() => undefined) }, 20);
    expect((await silent.router.route(draft.id, silent.command(), physician)).attempts[0].failureCode).toBe("transport_timeout");
    const wrong = setup(draft, { kind: "mock", send: async () => ({ requestId: crypto.randomUUID(), providerReference: "x" }) });
    expect((await wrong.router.route(draft.id, wrong.command(), physician)).attempts[0].failureCode).toBe("invalid_acknowledgement");
    const thrown = setup(draft, { kind: "mock", send: async () => { throw new ProviderTransportError("transport_timeout", "slow"); } });
    expect((await thrown.router.route(draft.id, thrown.command(), physician)).attempts[0].failureCode).toBe("transport_timeout");
  });

  it("packages only approved content, sources and gaps, with no demographics or chart identifiers", async () => {
    const draft = await approvedDraft();
    const { router, send, command } = setup(draft);
    await router.route(draft.id, command(), physician);
    const envelope = send.mock.calls[0][0];
    expect(consultationEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope).toMatchObject({ contractVersion: "1.0", tenantId: TENANT, providerId: "synthetic-cardiology", specialty: "Cardiology",
      question: ahmedConsultationRequest.clinicalQuestion, syntheticOnly: true, approval: { approvedBy: physician.clinicianId } });
    expect(envelope.missingInformation.map((item) => item.label)).toContain("ECG");
    expect(envelope.missingInformation.every((item) => item.status === "unknown" && !("value" in item))).toBe(true);
    const text = JSON.stringify(envelope);
    for (const secret of [ahmedPatient.displayName, ahmedPatient.patientId, "syn-enc-ahmed", "displayName", draft.id]) expect(text).not.toContain(secret);
    expect(consultationEnvelopeSchema.safeParse({ ...envelope, patientName: "x" }).success).toBe(false);
  });

  it("gives the model no tool that can approve, route or answer a consultation", () => {
    expect(toolRegistry).toEqual([]);
  });
});

describe("clinician lifecycle commands", () => {
  it("cannot set delivery or provider outcome states", () => {
    for (const action of ["queue", "sent", "accepted", "responded", "failed", "approve"]) {
      expect(transitionRequestSchema.safeParse({ action, expectedVersion: 1, idempotencyKey: "k" }).success).toBe(false);
    }
    expect(transitionRequestSchema.safeParse({ action: "cancel", expectedVersion: 1, idempotencyKey: "k" }).success).toBe(true);
    expect(transitionRequestSchema.safeParse({ action: "cancel", expectedVersion: 1, idempotencyKey: "k", recipientId: "x" }).success).toBe(false);
  });

  it("requires the specialty and clinical question together", () => {
    expect(createConsultationDraftRequestSchema.safeParse({ patientId: "p", specialty: "Cardiology" }).success).toBe(false);
    expect(createConsultationDraftRequestSchema.safeParse({ patientId: "p", specialty: "Cardiology", clinicalQuestion: "Q?" }).success).toBe(true);
    expect(createConsultationDraftRequestSchema.safeParse({ patientId: "p" }).success).toBe(true);
  });
});

describe("mock specialist", () => {
  const envelope = async (): Promise<ConsultationEnvelope> => ({
    ...buildEnvelope(await approvedDraft(), syntheticProviderDirectory[0], TENANT), requestId: "8d5f6f0e-6f0e-4d7c-9b65-0f7a4f0f5a11", attempt: 1,
  });

  it("acknowledges the same request identically every time", async () => {
    const transport = createMockSpecialistTransport();
    const request = await envelope();
    expect(await transport.send(request)).toEqual(await transport.send(request));
    await expect(transport.send({ ...request, requestId: "not-a-uuid" })).rejects.toBeInstanceOf(ProviderTransportError);
  });

  it("replies with valid callbacks that restate gaps and invent no results", async () => {
    const request = await envelope();
    const report = mockSpecialistCallback(request, "report");
    expect(providerCallbackSchema.safeParse(report).success).toBe(true);
    expect(providerCallbackSchema.safeParse(mockSpecialistCallback(request, "accepted")).success).toBe(true);
    expect(providerCallbackSchema.safeParse(mockSpecialistCallback(request, "rejected")).success).toBe(true);
    expect(report.report!.summary).toMatch(/SYNTHETIC SPECIALIST RESPONSE/);
    expect(report.report!.summary).toMatch(/ECG; Troponin/);
    expect(JSON.stringify(report)).not.toMatch(/normal|mmHg|mg\/dL|diagnos/i);
    expect(mockSpecialistNextStep("synthetic-cardiology", "sent")).toBe("accepted");
    expect(mockSpecialistNextStep("synthetic-cardiology", "accepted")).toBe("report");
    expect(mockSpecialistNextStep("synthetic-cardiology-declines", "sent")).toBe("rejected");
  });
});

describe("provider callbacks", () => {
  const secretFor = (id: string) => id === "synthetic-cardiology" ? "s".repeat(64) : id === "synthetic-radiology" ? "r".repeat(64) : undefined;
  const callback: ProviderCallback = { contractVersion: "1.0", requestId: "8d5f6f0e-6f0e-4d7c-9b65-0f7a4f0f5a11", providerId: "synthetic-cardiology",
    responseId: "r1", kind: "report", sentAt: "2026-01-15T10:10:00.000Z", syntheticOnly: true,
    report: { summary: "Synthetic", recommendations: [], responder: "Simulated" } };
  function signed(body: string, providerId = "synthetic-cardiology", secret = secretFor(providerId) ?? "none", timestamp = Date.now()) {
    return new Headers({ [CALLBACK_HEADERS.provider]: providerId, [CALLBACK_HEADERS.timestamp]: String(timestamp),
      [CALLBACK_HEADERS.signature]: signProviderCallback(secret, String(timestamp), body) });
  }

  it("authenticates only a correctly signed, fresh callback from a known provider", () => {
    const body = JSON.stringify(callback);
    expect(verifyProviderCallback(signed(body), body, secretFor)).toBe("synthetic-cardiology");
    expect(verifyProviderCallback(signed(body), body + " ", secretFor)).toBeUndefined();
    expect(verifyProviderCallback(signed(body, "synthetic-cardiology", "wrong"), body, secretFor)).toBeUndefined();
    expect(verifyProviderCallback(signed(body, "synthetic-cardiology", "r".repeat(64)), body, secretFor)).toBeUndefined();
    expect(verifyProviderCallback(signed(body, "unknown", "unknown-provider"), body, secretFor)).toBeUndefined();
    expect(verifyProviderCallback(signed(body, undefined, undefined, Date.now() - 6 * 60_000), body, secretFor)).toBeUndefined();
    expect(verifyProviderCallback(signed(body, undefined, undefined, Date.now() + 6 * 60_000), body, secretFor)).toBeUndefined();
    expect(verifyProviderCallback(new Headers(), body, secretFor)).toBeUndefined();
    const malformed = signed(body);
    malformed.set(CALLBACK_HEADERS.signature, "zz");
    expect(verifyProviderCallback(malformed, body, secretFor)).toBeUndefined();
  });

  it("stores a valid callback only for the provider that was authenticated", async () => {
    const record = vi.fn(async () => "applied" as const);
    const service = createProviderResponseService({ sink: { record } });
    expect(await service.ingest("synthetic-cardiology", callback)).toEqual({ requestId: callback.requestId, disposition: "applied" });
    await expect(service.ingest("synthetic-radiology", callback)).rejects.toMatchObject({ code: "forbidden" });
    expect(record).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a report without content", { report: undefined }],
    ["an acceptance carrying a report", { kind: "accepted" }],
    ["a non-synthetic message", { syntheticOnly: false }],
    ["an unknown field", { draftId: "x" }],
    ["a malformed request id", { requestId: "1" }],
    ["markup in the report", { report: { summary: "<img src=x>", recommendations: [], responder: "s" } }],
    ["hidden direction overrides", { report: { summary: "ok‮", recommendations: [], responder: "s" } }],
    ["an oversized report", { report: { summary: "a".repeat(8001), recommendations: [], responder: "s" } }],
  ])("rejects %s without storing it", async (_name, change) => {
    const record = vi.fn();
    await expect(createProviderResponseService({ sink: { record } }).ingest("synthetic-cardiology", { ...callback, ...change })).rejects.toMatchObject({ code: "invalid_request" });
    expect(record).not.toHaveBeenCalled();
  });
});
