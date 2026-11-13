import { describe, expect, it, vi } from "vitest";
import type { ClinicianContext } from "@/core/auth/clinician";
import type { ClinicalFact, ConsultationDraft, EncounterContext, PatientContext } from "@/shared/contracts";
import type { ClinicalDataAdapter } from "@/core/tools/connector";
import type { ModelProvider, ModelRequest } from "@/core/agent/providers/types";
import { createConsultationService } from "@/core/consultation/service";
import { createChatOrchestrator } from "@/core/agent/orchestrator/orchestrator";
import { createOpenAIProvider } from "@/core/agent/providers/openai-provider";
import { mockProvider } from "@/core/agent/providers/mock-provider";
import { clinicalSafetyGuard } from "@/core/agent/safety/guard";
import { buildEnvelope, createProviderRouter } from "@/core/routing/router";
import { createProviderRegistry } from "@/core/routing/registry";
import { createProviderResponseService } from "@/core/routing/responses";
import type { DeliveryRecord, DeliveryRepository, ProviderTransport } from "@/core/routing/ports";
import { createMockSpecialistTransport, mockSpecialistCallback } from "@/integrations/mock/specialist";
import { syntheticClinicalAdapter } from "@/integrations/mock/connector";
import { consultationDraftSchema, consultationEnvelopeSchema } from "@/shared/schemas";

/**
 * The LIVE code path, driven with a fake FHIR adapter, a fake model transport and a fake
 * provider. Every patient, clinician, provider and identifier here is fictional. No real
 * patient data may ever be added to this file.
 */
const TENANT = "fictional-hospital";
const chart = { patientId: "fic-pt-layla", encounterId: "fic-enc-layla" };
const physician: ClinicianContext = {
  clinicianId: "55555555-5555-4555-8555-555555555555", tenantId: TENANT, roles: ["physician"],
  scopes: ["chart:read", "consultation:draft", "consultation:approve", "consultation:route"], ...chart,
  expiresAt: Date.now() + 600_000, authorization: "active", dataClassification: "live",
};
const fhir = (reference: string) => ({ type: "fhir" as const, reference });
const liveFacts: ClinicalFact[] = [
  { id: "Condition-fic-htn", category: "problem", label: "Hypertension", status: "known", value: true, source: fhir("Condition/fic-htn"), timestamp: "2026-03-01T08:00:00.000Z" },
  { id: "MedicationRequest-fic-aml", category: "medication", label: "Amlodipine", status: "known", value: "5 mg daily", source: fhir("MedicationRequest/fic-aml"), timestamp: "2026-03-01T08:05:00.000Z" },
  { id: "Observation-fic-ecg", category: "investigation", label: "ECG", status: "unknown", reason: "pending", source: fhir("ServiceRequest/fic-ecg"), timestamp: "2026-03-02T09:00:00.000Z" },
];
const encounterFacts: ClinicalFact[] = [
  { id: "Observation-fic-bp", category: "vital_sign", label: "Blood pressure", status: "known", value: "168/96", unit: "mmHg", source: { type: "openemr", reference: "Observation/fic-bp" }, timestamp: "2026-03-02T09:10:00.000Z" },
];
const patient: PatientContext = {
  patientId: chart.patientId, displayName: "Layla Fictional-Example", birthDate: "1961-04-12", sex: "female",
  allergies: [], activeProblems: ["Hypertension"], medications: ["Amlodipine"], source: "fhir", clinicalFacts: liveFacts,
};
const encounter: EncounterContext = {
  encounterId: chart.encounterId, patientId: chart.patientId, type: "outpatient", status: "in_progress",
  startedAt: "2026-03-02T09:00:00.000Z", reasonForVisit: "Poorly controlled blood pressure", clinicalFacts: encounterFacts,
};
/** Stand-in for the pinned FHIR connector: serves only the launched chart. */
function fakeFhirAdapter(overrides: { patient?: PatientContext; encounter?: EncounterContext; source?: ClinicalDataAdapter["source"] } = {}): ClinicalDataAdapter {
  return {
    source: overrides.source ?? "fhir",
    getPatient: vi.fn(async (id: string) => id === chart.patientId ? overrides.patient ?? patient : null),
    getEncounter: vi.fn(async (id: string) => id === chart.encounterId ? overrides.encounter ?? encounter : null),
  };
}
/** A model approved for live data that answers like the deterministic drafter, and records what it was sent. */
function fakeLiveModel() {
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    name: "fake-live-model",
    async generate(request) {
      requests.push(request);
      const result = await mockProvider.generate({ ...request, dataClassification: undefined });
      return { ...result, provider: "fake-live-model", model: "fake-live-1" };
    },
  };
  return { provider, requests };
}
function liveService(options: { adapter?: ClinicalDataAdapter; provider?: ModelProvider; classification?: "synthetic" | "live" } = {}) {
  const repository = { get: vi.fn(), approve: vi.fn(async (input) => input), create: vi.fn(async (draft: ConsultationDraft) => draft) };
  const model = fakeLiveModel();
  const service = createConsultationService({
    repository, adapter: options.adapter ?? fakeFhirAdapter(), provider: options.provider ?? model.provider,
    safety: clinicalSafetyGuard, dataClassification: options.classification ?? "live", specialties: ["Cardiology"],
  });
  return { service, repository, model };
}
const REQUEST = "Prepare a cardiology consultation about poorly controlled hypertension.";

describe("live consultation drafting through the verified path (fake FHIR adapter, fictional patient)", () => {
  it("drafts from FHIR and OpenEMR facts, keeps their source references and stores a live draft pending review", async () => {
    const { service, repository, model } = liveService();
    const draft = consultationDraftSchema.parse(await service.create({ ...chart, request: REQUEST }, physician));
    expect(draft.status).toBe("pending_approval");
    expect(draft.reviewedBy).toBeUndefined();
    expect(draft.grounding?.provenance).toMatchObject({ dataClassification: "live", provider: "fake-live-model", encounterReference: chart.encounterId });
    expect(draft.grounding?.specialty).toBe("Cardiology");
    expect(draft.clinicalFacts?.map((fact) => fact.source)).toEqual([
      fhir("Condition/fic-htn"), fhir("MedicationRequest/fic-aml"), fhir("ServiceRequest/fic-ecg"), { type: "openemr", reference: "Observation/fic-bp" },
    ]);
    // Grounding and citation checks are unchanged: every statement cites a documented fact.
    expect(draft.grounding?.evidenceIds).toEqual(expect.arrayContaining(["Condition-fic-htn", "MedicationRequest-fic-aml", "Observation-fic-bp"]));
    expect(draft.summary).toContain("[Condition-fic-htn]");
    expect(draft.missingInformation?.map((fact) => fact.id)).toEqual(["Observation-fic-ecg"]);
    expect(draft.grounding?.safetyFlags).toEqual(expect.arrayContaining(["clinician_review_required", "missing_investigations"]));
    expect(repository.create).toHaveBeenCalledTimes(1);
    expect(repository.approve).not.toHaveBeenCalled();

    // The model request is classified live, has no tools, and carries no demographics or chart identifiers.
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0].dataClassification).toBe("live");
    expect(Object.keys(model.requests[0]).sort()).toEqual(["dataClassification", "instructions", "messages", "structuredOutput"]);
    const sent = JSON.stringify(model.requests[0]);
    for (const secret of [patient.displayName, "Layla", patient.birthDate!, chart.patientId, chart.encounterId, physician.clinicianId, TENANT]) {
      expect(sent).not.toContain(secret);
    }
  });

  it("drafts the structured (evidence selection) form with source citations and no synthetic label", async () => {
    const { service } = liveService();
    const draft = await service.create({ ...chart, specialty: "Cardiology", clinicalQuestion: "Is further work-up needed?" }, physician);
    expect(draft.summary.split("\n")[0]).toBe("Consultation draft; physician review required.");
    expect(draft.summary).not.toMatch(/synthetic/i);
    expect(draft.summary).toContain("Condition/fic-htn");
    expect(draft.summary).toContain("Observation/fic-bp");
    expect(draft.grounding?.provenance.dataClassification).toBe("live");
  });

  it("keeps approval a physician decision with its own scope", async () => {
    const { service, repository } = liveService();
    const request = { draftId: "d1", decision: "approve" as const, recipientId: "fictional-cardiology", expectedVersion: 1, idempotencyKey: "k" };
    await expect(service.approve(request, { ...physician, roles: ["clinician"] })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.approve(request, { ...physician, scopes: ["chart:read", "consultation:draft", "consultation:route"] })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.approve(request, { ...physician, expiresAt: Date.now() - 1 })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.approve(request, { ...physician, dataClassification: "synthetic" })).rejects.toMatchObject({ code: "forbidden" });
    expect(repository.approve).not.toHaveBeenCalled();
    await service.approve(request, physician);
    expect(repository.approve).toHaveBeenCalledTimes(1);
  });

  it("never mixes classifications: every mismatch is refused before the model is called", async () => {
    const synFact: ClinicalFact = { ...liveFacts[0], id: "syn-fact", source: { type: "synthetic", reference: "synthetic-case" } };
    const cases: Array<[string, Parameters<typeof liveService>[0], ClinicianContext]> = [
      ["a live session reading the synthetic connector", { adapter: { ...syntheticClinicalAdapter, getPatient: async () => ({ ...patient, source: "synthetic", clinicalFacts: [] }), getEncounter: async () => encounter } }, physician],
      ["a synthetic session reading the FHIR connector", { classification: "synthetic" }, { ...physician, dataClassification: "synthetic" }],
      ["a synthetic session reading the OpenEMR connector", { classification: "synthetic", adapter: fakeFhirAdapter({ source: "openemr" }) }, { ...physician, dataClassification: "synthetic" }],
      ["a live chart labelled synthetic", { adapter: fakeFhirAdapter({ patient: { ...patient, source: "synthetic" } }) }, physician],
      ["a synthetic fact inside a live chart", { adapter: fakeFhirAdapter({ patient: { ...patient, clinicalFacts: [...liveFacts, synFact] } }) }, physician],
      ["a synthetic fact inside a live encounter", { adapter: fakeFhirAdapter({ encounter: { ...encounter, clinicalFacts: [synFact] } }) }, physician],
      ["a synthetic session using a live service", {}, { ...physician, dataClassification: "synthetic" }],
      ["a live session using a synthetic service", { classification: "synthetic", adapter: syntheticClinicalAdapter }, physician],
    ];
    for (const [name, options, actor] of cases) {
      const { service, repository, model } = liveService(options);
      for (const input of [{ ...chart, request: REQUEST }, { ...chart, specialty: "Cardiology", clinicalQuestion: "Fictional question?" }]) {
        await expect(service.create(input, actor), name).rejects.toMatchObject({ code: "forbidden" });
      }
      expect(model.requests, name).toHaveLength(0);
      expect(repository.create, name).not.toHaveBeenCalled();
    }
  });

  it("revises a live draft only in a live session, and never sends a synthetic draft to a live model", async () => {
    const { service, model } = liveService();
    const draft = await service.create({ ...chart, request: REQUEST }, physician);
    const stored = { ...draft, version: 1, lifecycleStatus: "pending_review" as const };
    const lifecycle = {
      get: vi.fn(async () => stored), create: vi.fn(), history: vi.fn(),
      approve: vi.fn(async () => ({ ...stored, version: 2 })), revise: vi.fn(async (_id: string, input) => ({ ...stored, ...input, version: 3 })),
      transition: vi.fn(async () => ({ ...stored, version: 4 })),
    };
    const revision = { instruction: "Make it shorter.", expectedVersion: 1, idempotencyKey: "rev-1" };
    await service.reviseWithModel(draft.id, revision, physician, lifecycle);
    expect(model.requests.at(-1)?.dataClassification).toBe("live");
    // The result returns to physician review through the recorded lifecycle; nothing is approved.
    expect(lifecycle.approve).toHaveBeenCalledWith(expect.objectContaining({ decision: "request_changes" }));
    expect(lifecycle.transition).toHaveBeenCalledWith(draft.id, expect.objectContaining({ action: "submit" }));

    const calls = model.requests.length;
    const synthetic = { ...stored, grounding: { ...stored.grounding!, provenance: { ...stored.grounding!.provenance, dataClassification: "synthetic" as const } } };
    lifecycle.get.mockResolvedValue(synthetic);
    await expect(service.reviseWithModel(draft.id, revision, physician, lifecycle)).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.reviseWithModel(draft.id, revision, { ...physician, dataClassification: "synthetic" }, lifecycle)).rejects.toMatchObject({ code: "forbidden" });
    expect(model.requests).toHaveLength(calls);
  });

  it("fails visibly instead of falling back to the mock model", async () => {
    const { service, repository } = liveService({ provider: mockProvider });
    await expect(service.create({ ...chart, request: REQUEST }, physician)).rejects.toMatchObject({ code: "provider_unavailable" });
    await expect(service.create({ ...chart, specialty: "Cardiology", clinicalQuestion: "Fictional question?" }, physician)).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("does not send live chart content into free-form chat", async () => {
    const generate = vi.fn(mockProvider.generate);
    const live = createChatOrchestrator({ provider: { name: "mock", generate }, safety: clinicalSafetyGuard, dataClassification: "live", loadPatientContext: async () => patient });
    await expect(live.handle({ message: "Summarise", patientId: chart.patientId })).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(generate.mock.calls[0][0].dataClassification).toBe("live");
    // A synthetic session never receives EHR chart data either.
    const mixed = createChatOrchestrator({ provider: { name: "mock", generate }, safety: clinicalSafetyGuard, dataClassification: "synthetic", loadPatientContext: async () => patient });
    await expect(mixed.handle({ message: "Summarise", patientId: chart.patientId })).rejects.toMatchObject({ code: "forbidden" });
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe("model provider and live data", () => {
  // Fictional transport credentials and hypothetical prices; no API call is made.
  const config = { apiKey: "fictional-test-key", model: "fictional-test-model", inputUsdPerMillion: 1, outputUsdPerMillion: 2, maxRetries: 0 };
  const reply = () => Response.json({ status: "completed", model: config.model, usage: { input_tokens: 100, output_tokens: 20 },
    output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: '{"evidenceIds":[]}' }] }] });
  const input = (dataClassification: ModelRequest["dataClassification"]): ModelRequest => ({
    instructions: "i", messages: [{ role: "user", content: '{"facts":[],"eligibleEvidenceIds":[]}' }], dataClassification,
    structuredOutput: { name: "consultation_evidence_selection", schema: { type: "object" } },
  });

  it("refuses live data unless the deployment is approved for it, before any network request", async () => {
    for (const liveDataApproved of [undefined, false]) {
      const request = vi.fn();
      await expect(createOpenAIProvider({ ...config, liveDataApproved }, request).generate(input("live"))).rejects.toMatchObject({
        code: "provider_unavailable", message: expect.stringContaining("MODEL_LIVE_DATA_APPROVED"),
      });
      expect(request).not.toHaveBeenCalled();
    }
  });

  it("sends live data when approved, with response storage off", async () => {
    const request = vi.fn().mockResolvedValue(reply());
    const result = await createOpenAIProvider({ ...config, liveDataApproved: true }, request).generate(input("live"));
    expect(result.provider).toBe("openai");
    expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({ store: false });
    expect(JSON.parse(request.mock.calls[0][1].body)).not.toHaveProperty("tools");
  });

  it("keeps synthetic requests working without approval and still refuses unclassified or free-form requests", async () => {
    const request = vi.fn().mockImplementation(async () => reply());
    await createOpenAIProvider(config, request).generate(input("synthetic"));
    expect(request).toHaveBeenCalledTimes(1);
    const approved = createOpenAIProvider({ ...config, liveDataApproved: true }, request);
    await expect(approved.generate(input(undefined))).rejects.toMatchObject({ code: "forbidden" });
    await expect(approved.generate({ ...input("live"), structuredOutput: undefined })).rejects.toMatchObject({ code: "forbidden" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("never lets the deterministic mock answer for live data", async () => {
    await expect(mockProvider.generate(input("live"))).rejects.toMatchObject({ code: "provider_unavailable" });
    await expect(mockProvider.generate(input("synthetic"))).resolves.toMatchObject({ provider: "mock" });
  });
});

describe("live routing through the physician path (fake provider)", () => {
  const provider = { id: "fictional-cardiology", displayName: "Fictional Cardiology Service", specialties: ["Cardiology"], transport: "partner_api" as const, active: true, synthetic: false };
  const registry = createProviderRegistry([provider, { ...provider, id: "fictional-unlisted" }], new Set([provider.id]));

  async function approvedLiveDraft(): Promise<ConsultationDraft> {
    const draft = await liveService().service.create({ ...chart, request: REQUEST }, physician);
    return { ...draft, status: "approved", lifecycleStatus: "approved", version: 2, tenantId: TENANT,
      reviewedBy: physician.clinicianId, reviewedAt: "2026-03-02T10:00:00.000Z", approvedRecipientId: provider.id };
  }
  /** Minimal stand-in for the durable store; the real state machine is tested against PostgreSQL. */
  function memoryStore(initial: ConsultationDraft) {
    let draft = initial;
    const attempts: DeliveryRecord[] = [];
    const bump = (status: ConsultationDraft["status"]) => (draft = { ...draft, status, lifecycleStatus: status, version: draft.version! + 1 });
    const repository: DeliveryRepository = {
      get: async (id) => id === draft.id ? draft : null,
      async dispatch(_id, input) {
        const requestId = crypto.randomUUID();
        const now = new Date().toISOString();
        attempts.unshift({ requestId, number: 1, providerId: input.providerId, status: "queued", createdAt: now, updatedAt: now, envelope: { ...input.envelope, requestId, attempt: 1 } });
        return bump("queued");
      },
      async recordDispatchResult(requestId, result) {
        const attempt = attempts.find((candidate) => candidate.requestId === requestId)!;
        attempt.status = result.outcome;
        if (result.outcome === "failed") attempt.failureCode = result.failureCode;
        return bump(result.outcome);
      },
      deliveries: async () => attempts.map((attempt) => ({ ...attempt })),
      responses: async () => [],
    };
    return { repository, attempts };
  }
  function liveRouter(draft: ConsultationDraft, transport: ProviderTransport, classification: "synthetic" | "live" = "live") {
    const store = memoryStore(draft);
    const audit = vi.fn();
    const router = createProviderRouter({ repository: store.repository, registry, transport: () => transport, tenantId: TENANT, dataClassification: classification, timeoutMs: 200, audit });
    return { ...store, router, audit };
  }
  const fakeProvider = () => {
    const send = vi.fn(async (envelope: { requestId: string }) => ({ requestId: envelope.requestId, providerReference: "fictional-ref-1" }));
    return { transport: { kind: "partner_api", send } as ProviderTransport, send };
  };
  const command = (providerId = provider.id) => ({ providerId, expectedVersion: 2, idempotencyKey: "send-1" });

  it("sends the approved live consultation, classified live, without demographics or chart identifiers", async () => {
    const draft = await approvedLiveDraft();
    const { transport, send } = fakeProvider();
    const { router, attempts, audit } = liveRouter(draft, transport);
    const view = await router.route(draft.id, command(), physician);
    expect(view.status).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    const envelope = consultationEnvelopeSchema.parse(send.mock.calls[0][0]);
    expect(envelope).toMatchObject({ dataClassification: "live", tenantId: TENANT, providerId: provider.id, requestId: attempts[0].requestId,
      approval: { approvedBy: physician.clinicianId, approvedAt: draft.reviewedAt } });
    expect(envelope.clinicalFacts.map((fact) => fact.source.reference)).toContain("Condition/fic-htn");
    const wire = JSON.stringify(envelope);
    for (const secret of [patient.displayName, "Layla", patient.birthDate!, chart.patientId, chart.encounterId]) expect(wire).not.toContain(secret);
    expect(Object.keys(envelope)).not.toEqual(expect.arrayContaining(["patientId", "encounterId", "displayName", "birthDate", "syntheticOnly"]));
    // The audit record carries identifiers only.
    expect(audit).toHaveBeenCalledWith({ action: "consultation.dispatched", tenantId: TENANT, clinicianId: physician.clinicianId, draftId: draft.id, requestId: attempts[0].requestId, providerId: provider.id });
  });

  it("keeps every routing boundary in live mode", async () => {
    const draft = await approvedLiveDraft();
    const refusals: Array<[string, ClinicianContext, ReturnType<typeof command>, Partial<ConsultationDraft>, string]> = [
      ["a non-physician", { ...physician, roles: ["clinician"] }, command(), {}, "forbidden"],
      ["no route scope", { ...physician, scopes: ["chart:read", "consultation:draft", "consultation:approve"] }, command(), {}, "forbidden"],
      ["another tenant", { ...physician, tenantId: "other-tenant" }, command(), {}, "forbidden"],
      ["an expired session", { ...physician, expiresAt: Date.now() - 1 }, command(), {}, "forbidden"],
      ["a synthetic session", { ...physician, dataClassification: "synthetic" }, command(), {}, "forbidden"],
      ["a provider off the allowlist", physician, command("fictional-unlisted"), { approvedRecipientId: "fictional-unlisted" }, "forbidden"],
      ["a destination the physician did not approve", physician, command(), { approvedRecipientId: "someone-else" }, "forbidden"],
      ["an unapproved draft", physician, command(), { status: "pending_approval", lifecycleStatus: "pending_review" }, "conflict"],
    ];
    for (const [name, actor, request, change, code] of refusals) {
      const { transport, send } = fakeProvider();
      const { router, attempts } = liveRouter({ ...draft, ...change }, transport);
      await expect(router.route(draft.id, request, actor), name).rejects.toMatchObject({ code });
      expect(send, name).not.toHaveBeenCalled();
      expect(attempts, name).toHaveLength(0);
    }
  });

  it("never routes across classifications", async () => {
    const draft = await approvedLiveDraft();
    const synthetic = { ...draft, grounding: { ...draft.grounding!, provenance: { ...draft.grounding!.provenance, dataClassification: "synthetic" as const } } };
    expect(() => buildEnvelope(draft, provider, TENANT, "synthetic")).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(() => buildEnvelope(synthetic, provider, TENANT, "live")).toThrow(expect.objectContaining({ code: "forbidden" }));
    for (const [candidate, classification, actor] of [
      [synthetic, "live", physician], [draft, "synthetic", { ...physician, dataClassification: "synthetic" }],
    ] as const) {
      const { transport, send } = fakeProvider();
      const { router, attempts } = liveRouter(candidate, transport, classification);
      await expect(router.route(draft.id, command(), actor)).rejects.toMatchObject({ code: "forbidden" });
      expect(send).not.toHaveBeenCalled();
      expect(attempts).toHaveLength(0);
    }
  });

  it("never delivers a live request to the simulated specialist", async () => {
    const draft = await approvedLiveDraft();
    const { router, attempts } = liveRouter(draft, createMockSpecialistTransport());
    const view = await router.route(draft.id, command(), physician);
    expect(view.status).toBe("failed");
    expect(attempts[0]).toMatchObject({ status: "failed", failureCode: "transport_error" });
  });

  it("accepts a callback only in the tenant's classification", async () => {
    const draft = await approvedLiveDraft();
    const envelope = { ...buildEnvelope(draft, provider, TENANT, "live"), requestId: "7b1f3c0e-5a55-4a0b-9d0c-2f1f8d7a9c11", attempt: 1 };
    const callback = mockSpecialistCallback(envelope, "accepted", "2026-03-02T10:10:00.000Z");
    expect(callback.dataClassification).toBe("live");
    const record = vi.fn(async () => "applied" as const);
    const live = createProviderResponseService({ sink: { record }, dataClassification: "live" });
    expect(await live.ingest(provider.id, callback)).toEqual({ requestId: envelope.requestId, disposition: "applied" });
    await expect(live.ingest(provider.id, { ...callback, dataClassification: "synthetic" })).rejects.toMatchObject({ code: "forbidden" });
    const synthetic = createProviderResponseService({ sink: { record }, dataClassification: "synthetic" });
    await expect(synthetic.ingest(provider.id, callback)).rejects.toMatchObject({ code: "forbidden" });
    await expect(live.ingest(provider.id, { ...callback, dataClassification: undefined, syntheticOnly: true })).rejects.toMatchObject({ code: "invalid_request" });
    expect(record).toHaveBeenCalledTimes(1);
  });
});
