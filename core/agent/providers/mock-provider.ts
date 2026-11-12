import type { ModelProvider } from "./types";

interface AuthoringInput {
  physicianRequest: string;
  availableSpecialties: string[];
  chart: { facts: { id: string; category: string; label: string; status: string; value?: string | number | boolean; unit?: string | null }[]; citableFactIds: string[] };
  revision?: { instruction: string; specialty: string; clinicalQuestion: string };
}

const SECTION: Record<string, string> = {
  problem: "relevantHistory", history: "relevantHistory", symptom: "presentingSymptoms", vital_sign: "examinationFindings",
  investigation: "investigations", medication: "currentMedications", allergy: "clinicalContext",
};

/**
 * Deterministic stand-in for the consultation model: it copies each citable fact into its
 * section verbatim. It performs no inference and does not interpret revision instructions.
 * The interface labels its output as a demo fallback, never as AI-generated reasoning.
 */
function mockReferral(input: AuthoringInput) {
  const request = input.physicianRequest.toLowerCase();
  const specialty = input.revision?.specialty ??
    input.availableSpecialties.find((name) => request.includes(name.toLowerCase())) ??
    /\b(cardiology|radiology|neurology|nephrology|endocrinology|pulmonology|gastroenterology|dermatology|oncology|hematology|psychiatry|orthopedics|urology)\b/.exec(request)?.[1].replace(/^./, (c) => c.toUpperCase()) ?? "";
  const sections: Record<string, { text: string; evidenceIds: string[] }[]> = {
    relevantHistory: [], presentingSymptoms: [], examinationFindings: [], investigations: [], currentMedications: [], clinicalContext: [],
  };
  const citable = new Set(input.chart.citableFactIds);
  for (const fact of input.chart.facts) {
    if (fact.status !== "known" || !citable.has(fact.id)) continue;
    const value = typeof fact.value === "boolean" ? "" : `: ${String(fact.value)}${fact.unit ? ` ${fact.unit}` : ""}`;
    sections[SECTION[fact.category] ?? "clinicalContext"].push({ text: `${fact.label}${value}`, evidenceIds: [fact.id] });
  }
  return {
    specialty,
    clinicalQuestion: input.revision?.clinicalQuestion ?? input.physicianRequest.trim(),
    sections,
    missingInformation: input.chart.facts.filter((fact) => fact.status === "unknown").map((fact) => ({ evidenceId: fact.id })),
    suggestedAdditionalInformation: [],
  };
}

/** Deterministic provider for development and tests. Makes no network calls. */
export const mockProvider: ModelProvider = {
  name: "mock",
  async generate({ messages, structuredOutput }) {
    const last = messages.findLast((m) => m.role === "user")?.content ?? "";
    if (structuredOutput?.name === "consultation_evidence_selection") {
      const context = JSON.parse(last) as { eligibleEvidenceIds: string[] };
      return { text: JSON.stringify({ evidenceIds: context.eligibleEvidenceIds }), provider: "mock", model: "mock-1" };
    }
    if (structuredOutput?.name === "consultation_referral") {
      return { text: JSON.stringify(mockReferral(JSON.parse(last) as AuthoringInput)), provider: "mock", model: "mock-1" };
    }
    return { text: `[mock] Received: ${last}`, provider: "mock", model: "mock-1" };
  },
};
