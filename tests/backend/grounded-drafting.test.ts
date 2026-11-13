import { describe, expect, it, vi } from "vitest";
import type { ClinicianContext } from "@/core/auth/clinician";
import type { ClinicalFact, PatientContext } from "@/shared/contracts";
import type { ClinicalDataAdapter } from "@/core/tools/connector";
import type { ModelProvider } from "@/core/agent/providers/types";
import { createConsultationService } from "@/core/consultation/service";
import { MAX_CONTEXT_BYTES, MAX_FACTS } from "@/core/consultation/grounding";
import { mockProvider } from "@/core/agent/providers/mock-provider";
import { syntheticSafetyGuard } from "@/core/agent/safety/guard";
import { syntheticClinicalAdapter } from "@/integrations/mock/connector";
import { ahmedClinicalFacts, ahmedConsultationRequest, ahmedPatient } from "@/shared/mocks/synthetic-data";
import { consultationDraftSchema } from "@/shared/schemas";
import { PROMPT_VERSION, SYSTEM_INSTRUCTIONS } from "@/core/agent/prompts/system";

const input = { patientId: ahmedPatient.patientId, encounterId: "syn-enc-ahmed" };
const actor: ClinicianContext = {
  clinicianId: "verified-clinician", tenantId: "synthetic", roles: ["physician"],
  scopes: ["consultation:draft", "consultation:approve"], ...input,
  expiresAt: Date.now() + 600_000, authorization: "active",
};
function setup(provider: ModelProvider = mockProvider, adapter: ClinicalDataAdapter = syntheticClinicalAdapter) {
  const repository = { get: vi.fn(), approve: vi.fn(), create: vi.fn(async (draft) => draft) };
  const deps = { repository, provider, adapter, safety: syntheticSafetyGuard };
  return { deps, repository, service: createConsultationService(deps) };
}
function patientAdapter(patient: PatientContext): ClinicalDataAdapter {
  return { source: "synthetic", getPatient: async () => patient, getEncounter: async () => null };
}
function output(text: string, name = "untrusted"): ModelProvider {
  return { name, generate: vi.fn(async () => ({ text, model: "synthetic-test-model", provider: name })) };
}

describe("grounded synthetic consultation drafting", () => {
  it("produces a typed Ahmed consultation with source evidence, explicit unknowns and no approval", async () => {
    const { service, repository } = setup();
    const result = consultationDraftSchema.parse(await service.preview(input, ahmedConsultationRequest));
    expect(result.grounding).toMatchObject({
      question: ahmedConsultationRequest.clinicalQuestion, specialty: "Cardiology",
      reason: expect.stringContaining("investigations not provided"),
      evidenceIds: ["ahmed-hypertension", "ahmed-diabetes", "ahmed-metformin", "ahmed-amlodipine"],
      provenance: { provider: "mock", model: "mock-1", promptVersion: PROMPT_VERSION, dataClassification: "synthetic", encounterReference: "syn-enc-ahmed" },
    });
    expect(result.clinicalFacts).toEqual(ahmedClinicalFacts);
    expect(result.missingInformation?.filter((fact) => fact.category === "investigation")).toHaveLength(5);
    for (const fact of result.missingInformation!) {
      expect(fact).not.toHaveProperty("value");
      expect(result.plan.join("\n")).toContain(`${fact.label}: unknown (not_provided)`);
    }
    expect(result.summary).toContain("synthetic-case-ahmed-v1");
    expect(result.grounding?.safetyFlags).toContain("missing_investigations");
    expect(result.status).toBe("pending_approval");
    expect(result.reviewedBy).toBeUndefined();
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.approve).not.toHaveBeenCalled();
  });

  it("keeps the M0.5 safety check on rendered source text", async () => {
    const { service, repository } = setup(mockProvider, patientAdapter({
      ...ahmedPatient,
      clinicalFacts: [{ ...ahmedClinicalFacts[0], label: "<script>unsafe synthetic source</script>" }],
    }));
    await expect(service.create({ patientId: actor.patientId }, { ...actor, encounterId: undefined }))
      .rejects.toMatchObject({ code: "safety_blocked" });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("sends bounded source facts only with the unchanged versioned instructions", async () => {
    const provider = { ...mockProvider, generate: vi.fn(mockProvider.generate) };
    const { service } = setup(provider);
    await service.preview(input, ahmedConsultationRequest);
    const request = provider.generate.mock.calls[0][0];
    expect(request.instructions).toBe(SYSTEM_INSTRUCTIONS);
    expect(request.dataClassification).toBe("synthetic");
    expect(request.structuredOutput?.schema).toMatchObject({ additionalProperties: false });
    expect(request.messages[0].content).not.toContain(ahmedPatient.displayName);
    expect(request.messages[0].content).not.toContain(ahmedConsultationRequest.clinicalQuestion);
    expect(new TextEncoder().encode(request.messages[0].content).length).toBeLessThan(MAX_CONTEXT_BYTES);
  });

  it.each(["", "not JSON", "null", "{}", '{"evidenceIds":42}', '{"evidenceIds":[],"summary":"Troponin normal"}', '{"evidenceIds":[],"status":"approved"}'])("rejects malformed model output through either provider (%s)", async (text) => {
    // A provider calling itself mock gets exactly the same validation.
    const { service, repository } = setup(output(text, "mock"));
    await expect(service.create(input, actor)).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it.each([
    ["ahmed-troponin"], ["invented-normal-ecg"], ["ahmed-hypertension", "ahmed-hypertension"], [],
  ])("blocks unknown, fabricated, duplicate or omitted evidence (%j)", async (...ids) => {
    const { service, repository } = setup(output(JSON.stringify({ evidenceIds: ids })));
    await expect(service.create(input, actor)).rejects.toMatchObject({ code: "safety_blocked" });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("preserves zero and false values, and source timestamps", async () => {
    const base = ahmedClinicalFacts[0];
    const facts: ClinicalFact[] = [
      { ...base, id: "zero", label: "Synthetic value", status: "known", value: 0 },
      { ...base, id: "false", label: "Synthetic negative assertion", status: "known", value: false },
    ];
    const { service } = setup(mockProvider, patientAdapter({ ...ahmedPatient, clinicalFacts: facts }));
    const draft = await service.preview({ patientId: ahmedPatient.patientId });
    expect(draft.summary).toContain("Synthetic value: 0");
    expect(draft.summary).toContain("Synthetic negative assertion: false");
    expect(draft.clinicalFacts).toEqual(facts);
  });

  it("retains conflicting assertions for review and never resolves them as evidence", async () => {
    const original = ahmedClinicalFacts[0];
    const facts: ClinicalFact[] = [original, { ...original, id: "contradiction", status: "known", value: false }];
    const { service } = setup(mockProvider, patientAdapter({ ...ahmedPatient, clinicalFacts: facts }));
    const draft = await service.preview({ patientId: ahmedPatient.patientId });
    expect(draft.grounding?.conflicts).toEqual([[original.id, "contradiction"]]);
    expect(draft.grounding?.evidenceIds).toEqual([]);
    expect(draft.grounding?.safetyFlags).toContain("conflicting_facts");
    expect(draft.clinicalFacts).toEqual(facts);
    expect(draft.summary).not.toContain("Essential hypertension: true");
    const { service: unsafe } = setup(output(JSON.stringify({ evidenceIds: [original.id] })), patientAdapter({ ...ahmedPatient, clinicalFacts: facts }));
    await expect(unsafe.preview({ patientId: ahmedPatient.patientId })).rejects.toMatchObject({ code: "safety_blocked" });
  });

  it("rejects reused fact IDs with differing content before model access", async () => {
    const provider = { ...mockProvider, generate: vi.fn(mockProvider.generate) };
    const facts = [ahmedClinicalFacts[0], { ...ahmedClinicalFacts[0], label: "Different assertion" }];
    const { service } = setup(provider, patientAdapter({ ...ahmedPatient, clinicalFacts: facts }));
    await expect(service.preview({ patientId: ahmedPatient.patientId })).rejects.toMatchObject({ code: "safety_blocked" });
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it.each([undefined, []])("marks empty normalized data, absent investigations and incomplete intent (%j)", async (clinicalFacts) => {
    const { service } = setup(mockProvider, patientAdapter({ ...ahmedPatient, clinicalFacts, activeProblems: [], allergies: [], medications: [] }));
    const draft = await service.preview({ patientId: ahmedPatient.patientId });
    expect(draft.grounding).toMatchObject({ reason: null, question: null, specialty: null, evidenceIds: [] });
    expect(draft.grounding?.safetyFlags).toEqual(expect.arrayContaining(["insufficient_clinical_data", "incomplete_referral", "missing_investigations"]));
    expect(draft.plan.join(" ")).toContain("Investigation results are unknown");
    expect(draft.summary).not.toContain("No allergies");
  });

  it("returns the saved snapshot on idempotent creates, without mixing in fresh model metadata", async () => {
    const { deps, repository, service } = setup();
    const saved = await service.preview(input);
    saved.grounding!.gaps.push("Previously persisted synthetic gap");
    repository.create.mockImplementation(async () => saved);
    const result = await createConsultationService(deps).create({ ...input, idempotencyKey: "synthetic-create" }, actor);
    expect(result).toEqual(saved);
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ grounding: expect.any(Object) }), "verified-clinician",
      { provider: "mock", model: "mock-1", promptVersion: PROMPT_VERSION },
      { key: "synthetic-create", request: input });
  });

  it.each(["adapter", "patient", "fact"])("rejects nonsynthetic %s before model access", async (kind) => {
    const provider = { ...mockProvider, generate: vi.fn(mockProvider.generate) };
    const adapter = patientAdapter(structuredClone(ahmedPatient));
    if (kind === "adapter") Object.assign(adapter, { source: "fhir" });
    if (kind === "patient") adapter.getPatient = async () => ({ ...ahmedPatient, source: "fhir" });
    if (kind === "fact") adapter.getPatient = async () => ({ ...ahmedPatient, clinicalFacts: [{ ...ahmedClinicalFacts[0], source: { type: "fhir", reference: "synthetic-test-nonsynthetic-source" } }] });
    const { service } = setup(provider, adapter);
    await expect(service.preview({ patientId: ahmedPatient.patientId })).rejects.toMatchObject({ code: "forbidden" });
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("rejects oversized facts and context without silently truncating", async () => {
    const provider = { ...mockProvider, generate: vi.fn(mockProvider.generate) };
    for (const facts of [
      Array.from({ length: MAX_FACTS + 1 }, (_, index) => ({ ...ahmedClinicalFacts[0], id: `fact-${index}` })),
      Array.from({ length: 8 }, (_, index) => ({ ...ahmedClinicalFacts[0], id: `large-${index}`, label: "x".repeat(4000) })),
    ]) {
      await expect(setup(provider, patientAdapter({ ...ahmedPatient, clinicalFacts: facts })).service.preview({ patientId: ahmedPatient.patientId })).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("rejects a wrong patient, encounter and intent, and adapter failures", async () => {
    const { service } = setup();
    await expect(service.preview({ ...input, encounterId: "syn-enc-001" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(service.preview(input, { ...ahmedConsultationRequest, patientId: "other" })).rejects.toMatchObject({ code: "invalid_request" });
    const provider = { ...mockProvider, generate: vi.fn(mockProvider.generate) };
    await expect(setup(provider, patientAdapter({ ...ahmedPatient, patientId: "other" })).service.preview(input)).rejects.toMatchObject({ code: "safety_blocked" });
    const adapter = patientAdapter(ahmedPatient);
    adapter.getPatient = vi.fn().mockRejectedValue(new Error("Synthetic adapter unavailable"));
    await expect(setup(provider, adapter).service.preview(input)).rejects.toThrow("Synthetic adapter unavailable");
    expect(provider.generate).not.toHaveBeenCalled();
  });
});
