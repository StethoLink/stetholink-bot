import { RouteError } from "@/core/errors";
import type { ModelProvider } from "@/core/agent/providers/types";

interface AuthoringInput {
  physicianRequest: string;
  clarifications?: { question: string; answer: string }[];
  availableSpecialties: string[];
  chart: { facts: { id: string; category: string; label: string; status: string; value?: string | number | boolean; unit?: string | null }[]; citableFactIds: string[] };
  revision?: { instruction: string; specialty: string; clinicalQuestion: string };
}

const SECTION: Record<string, string> = {
  problem: "relevantHistory", history: "relevantHistory", symptom: "presentingSymptoms", vital_sign: "examinationFindings",
  investigation: "investigations", medication: "currentMedications", allergy: "clinicalContext",
};

// Words that only name the task; a request made of nothing else asks the specialist nothing.
const BOILERPLATE = /\b(?:please|prepare|write|draft|make|create|send|a|an|the|this|that|for|to|of|my|our|patient|patients|consultation|consult|referral|refer|request|urgent|specialty|team|service)\b/giu;

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
  const answers = (input.clarifications ?? []).map((entry) => entry.answer.trim());
  const remainder = input.physicianRequest.toLowerCase().replace(BOILERPLATE, " ").replace(specialty.toLowerCase(), " ")
    .replace(/[^a-z]+/gu, " ").trim();
  // The only challenge the mock can make without inference: the request names a specialty and nothing to ask it.
  const unclear = !input.revision && !!specialty && !answers.length && remainder.split(" ").filter((word) => word.length > 2).length < 2;
  return {
    specialty,
    clinicalQuestion: input.revision?.clinicalQuestion ?? [input.physicianRequest.trim(), ...answers].join(" "),
    sections,
    missingInformation: input.chart.facts.filter((fact) => fact.status === "unknown").map((fact) => ({ evidenceId: fact.id })),
    suggestedAdditionalInformation: [],
    requestReview: unclear
      ? { verdict: "clarify", concerns: [{ kind: "unclear_question", concern: `The request names ${specialty} but not what the specialist should answer.`,
          question: `What do you want ${specialty} to answer about this patient?`, evidenceIds: [] }] }
      : { verdict: "proceed", concerns: [] },
  };
}

interface ScribeInput { transcript: { segments: { id: string; text: string }[] }; chart: { facts: { id: string; category: string; label: string }[] } }
/**
 * Deterministic stand-in for the scribe model. It does not understand the visit: it lists each
 * sentence as a subjective statement in its own words, and proposes a chart item only where a
 * sentence mentions an allergy or a medicine being taken next to a term in Latin letters.
 * The interface labels its output as a demo fallback, never as AI.
 */
function mockScribeNote(input: ScribeInput) {
  const proposedUpdates: Record<string, string>[] = [];
  const latin = (text: string) => /\b[A-Za-z][A-Za-z0-9-]{3,}\b/.exec(text)?.[0];
  for (const segment of input.transcript.segments) {
    const term = latin(segment.text);
    if (!term) continue;
    const kind = segment.text.includes("حساسي") ? "allergy" : /(?:^|\s)(?:آخذ|اخذ|تاخذ|تأخذ)\s/.test(segment.text) ? "medication" : undefined;
    if (!kind || proposedUpdates.some((update) => update.name.toLowerCase() === term.toLowerCase())) continue;
    const match = input.chart.facts.find((fact) => fact.category === kind && fact.label.toLowerCase().includes(term.toLowerCase()));
    proposedUpdates.push({ kind, name: term[0].toUpperCase() + term.slice(1), detail: "", relation: match ? "already_in_chart" : "new", chartFactId: match?.id ?? "", explanation: "", segmentId: segment.id, quote: segment.text });
  }
  return {
    subjective: input.transcript.segments.slice(0, 40).map((segment) => ({ text: segment.text.replace(/[\[\]{}<>\\]/g, " "), sources: [{ id: segment.id, quote: segment.text }] })),
    objective: [], assessment: [], plan: [], clinicianSegments: [], patientSegments: [], proposedUpdates,
  };
}

/**
 * Deterministic provider for development, tests and demos. Makes no network calls.
 * It is not a model and never stands in for one on live clinical data.
 */
export const mockProvider: ModelProvider = {
  name: "mock",
  async generate({ messages, structuredOutput, dataClassification }) {
    if (dataClassification === "live") throw new RouteError("provider_unavailable", "The deterministic mock cannot draft from live clinical data");
    const last = messages.findLast((m) => m.role === "user")?.content ?? "";
    if (structuredOutput?.name === "consultation_evidence_selection") {
      const context = JSON.parse(last) as { eligibleEvidenceIds: string[] };
      return { text: JSON.stringify({ evidenceIds: context.eligibleEvidenceIds }), provider: "mock", model: "mock-1" };
    }
    if (structuredOutput?.name === "consultation_referral") {
      return { text: JSON.stringify(mockReferral(JSON.parse(last) as AuthoringInput)), provider: "mock", model: "mock-1" };
    }
    if (structuredOutput?.name === "scribe_soap_note") {
      return { text: JSON.stringify(mockScribeNote(JSON.parse(last) as ScribeInput)), provider: "mock", model: "mock-1" };
    }
    return { text: `[mock] Received: ${last}`, provider: "mock", model: "mock-1" };
  },
};
