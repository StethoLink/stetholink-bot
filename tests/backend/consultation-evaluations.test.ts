import { describe, expect, it } from "vitest";
import { createOpenAIProvider } from "@/core/agent/providers/openai-provider";
import { deidentified } from "../helpers/privacy";
import { mockProvider } from "@/tests/fixtures/mock-provider";
import type { ModelProvider } from "@/core/agent/providers/types";
import { clinicalSafetyGuard } from "@/core/agent/safety/guard";
import { groundContext } from "@/core/consultation/grounding";
import { createConsultationService } from "@/core/consultation/service";
import type { ClinicianContext } from "@/core/auth/clinician";
import { createFhirConnector } from "@/integrations/fhir/connector";
import { encounterContextSchema, patientContextSchema } from "@/shared/schemas";
import { citedEvidenceIds } from "@/shared/utils/referral-text";
import { evaluationCases, evaluationFhir } from "../helpers/evaluation-cases";

// As in the product: the provider is reached only through the de-identification layer.
const liveProvider = (...args: Parameters<typeof createOpenAIProvider>) => deidentified(createOpenAIProvider(...args));

// Twelve fictional charts in FHIR shape (core/agent/evaluations/consultation/cases.json).
// Always on: each chart goes through the real connector and the drafting service with a stand-in
// model, checking what does not depend on a model. Opt in to the real model:
//   RUN_CONSULTATION_LIVE_EVAL=1 OPENAI_API_KEY=... OPENAI_MODEL=... OPENAI_INPUT_USD_PER_MILLION=... OPENAI_OUTPUT_USD_PER_MILLION=... \
//   npx vitest run tests/backend/consultation-evaluations.test.ts
const BASE = "https://ehr.example.test/fhir";
const actor: ClinicianContext = { clinicianId: "55555555-5555-4555-8555-555555555555", tenantId: "fictional", roles: ["physician"], scopes: ["chart:read", "consultation:draft"],
  patientId: "fic-pt-1", encounterId: "fic-enc-1", expiresAt: Date.now() + 600_000, authorization: "active", dataClassification: "live" };
const connector = (evaluation: (typeof evaluationCases)[number]) => createFhirConnector({ baseUrl: BASE, accessToken: "fictional-token", patientId: "fic-pt-1", encounterId: "fic-enc-1" }, evaluationFhir(evaluation, BASE));
const service = (evaluation: (typeof evaluationCases)[number], provider: ModelProvider) => createConsultationService({
  adapter: connector(evaluation), provider, safety: clinicalSafetyGuard, dataClassification: "live", specialties: evaluation.expected.specialty ? [evaluation.expected.specialty] : [],
  repository: { async get() { return null; }, async create(draft) { return draft; }, async approve() { throw new Error("not in an evaluation"); } },
});
// The stand-in copies facts; it stands for "a model that follows the rules", so the chart-side properties can be checked.
const standIn: ModelProvider = { name: "stand-in", async generate(request) { return { ...await mockProvider.generate({ ...request, dataClassification: undefined }), provider: "stand-in", model: "stand-in-1" }; } };

describe("consultation evaluation charts through the connector (stand-in model)", () => {
  it.each(evaluationCases.map((evaluation) => [evaluation.id, evaluation] as const))("%s", async (_id, evaluation) => {
    const patient = patientContextSchema.parse(await connector(evaluation).getPatient("fic-pt-1"));
    const encounter = encounterContextSchema.parse(await connector(evaluation).getEncounter("fic-enc-1"));
    const grounded = groundContext(patient, encounter, "live");
    const text = JSON.stringify(patient.clinicalFacts);
    for (const label of evaluation.expected.missingInformation ?? []) expect(grounded.missing.some((fact) => fact.label.startsWith(label)), `${label} is an explicit unknown`).toBe(true);
    for (const note of evaluation.expected.notes ?? []) expect((patient.chartNotes ?? []).join(" ")).toContain(note);
    // Records that must never reach a draft are already absent from the facts.
    for (const term of (evaluation.expected.mustNotMention ?? []).filter((term) => evaluation.resources.some((resource) => JSON.stringify(resource).includes(term)))) expect(text).not.toContain(term);
    if (evaluation.expected.outcome === "draft") {
      const result = await service(evaluation, standIn).create({ patientId: "fic-pt-1", encounterId: "fic-enc-1", request: evaluation.request }, actor);
      if ("outcome" in result) throw new Error("expected a draft");
      const whole = [result.summary, result.assessment].join("\n");
      for (const term of evaluation.expected.mustMention ?? []) expect(whole, `mentions ${term}`).toContain(term);
      const facts = new Map(result.clinicalFacts!.map((fact) => [fact.id, fact]));
      expect(citedEvidenceIds(result.summary).every((id) => facts.get(id)?.source.type === "fhir")).toBe(true);
      // Nothing that identifies the chart is in text that can be sent.
      expect(whole).not.toMatch(/Patient\/|Observation\/|Condition\/|MedicationRequest\/|AllergyIntolerance\/|Fictional-Example/);
    }
  });
});

const live = process.env.RUN_CONSULTATION_LIVE_EVAL === "1" && Boolean(process.env.OPENAI_API_KEY);
describe.skipIf(!live)("consultation evaluation charts (live model)", () => {
  const provider = () => liveProvider({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL ?? "gpt-5", timeoutMs: 28_000, maxRetries: 0, maxInputTokens: 32_000, maxOutputTokens: 8000, maxCostUsd: 0.5,
    reasoningEffort: (process.env.OPENAI_REASONING_EFFORT as "low" | undefined) ?? "low", inputUsdPerMillion: Number(process.env.OPENAI_INPUT_USD_PER_MILLION ?? 1.25), outputUsdPerMillion: Number(process.env.OPENAI_OUTPUT_USD_PER_MILLION ?? 10), liveDataApproved: true });
  it.each(evaluationCases.map((evaluation) => [evaluation.id, evaluation] as const))("%s", async (_id, evaluation) => {
    const result = await service(evaluation, provider()).create({ patientId: "fic-pt-1", encounterId: "fic-enc-1", request: evaluation.request }, actor);
    const expected = evaluation.expected;
    if ("outcome" in result) {
      console.info(`EVAL ${evaluation.id}: clarification ${result.concerns.map((entry) => entry.kind).join(", ")}`);
      expect(expected.outcome, "the assistant questioned a request that should be drafted").not.toBe("draft");
      if (expected.concernKinds) expect(result.concerns.some((entry) => expected.concernKinds!.includes(entry.kind))).toBe(true);
      return;
    }
    expect(expected.outcome, "the assistant drafted a request it should question").not.toBe("clarification");
    const whole = [result.summary, result.assessment, ...result.plan].join("\n");
    console.info(`EVAL ${evaluation.id}: draft, removed ${result.grounding?.authoring?.rejectedStatements}, $${result.grounding?.authoring?.usage?.estimatedCostUsd}`);
    for (const term of expected.mustMention ?? []) expect(whole, `mentions ${term}`).toContain(term);
    for (const term of expected.mustNotMention ?? []) expect(whole.toLowerCase(), `does not mention ${term}`).not.toContain(term.toLowerCase());
  }, 60_000);
});
