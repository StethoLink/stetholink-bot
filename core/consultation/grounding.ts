import type { ClinicalFact, DataClassification, EncounterContext, KnownClinicalFact, MissingInformation, PatientContext } from "@/shared/contracts";
import { classificationOfSource } from "@/shared/schemas";
import { RouteError } from "@/core/errors";
import { z } from "zod";

export const CONTEXT_VERSION = "consultation-grounding@1";
export const MAX_FACTS = 64;
export const MAX_CONTEXT_BYTES = 24_000;

/** The model selects source IDs only. No model-authored clinical prose is trusted. */
export const selectionSchema = z.object({
  evidenceIds: z.array(z.string().min(1).max(128)).max(MAX_FACTS),
}).strict();

export const selectionFormat = {
  name: "consultation_evidence_selection",
  schema: {
    type: "object", additionalProperties: false,
    properties: { evidenceIds: { type: "array", items: { type: "string" } } },
    required: ["evidenceIds"],
  },
};

function assertion(fact: ClinicalFact) {
  return fact.status === "known" ? JSON.stringify([fact.status, fact.value, fact.unit ?? null]) : JSON.stringify([fact.status, fact.reason]);
}

/**
 * Builds the model context from normalized facts. Every fact keeps its own source reference
 * (a synthetic fixture, or a FHIR/OpenEMR record) and must belong to the session's data
 * classification: synthetic and live facts are never combined.
 */
export function groundContext(patient: PatientContext, encounter: EncounterContext | null, classification: DataClassification) {
  const supplied = [...patient.clinicalFacts ?? [], ...encounter?.clinicalFacts ?? []];
  if (supplied.length > MAX_FACTS * 2) throw new RouteError("invalid_request", "Clinical context exceeds the fact limit");
  const byId = new Map<string, ClinicalFact>();
  for (const fact of supplied) {
    if (classificationOfSource(fact.source.type) !== classification) {
      throw new RouteError("forbidden", "A clinical fact does not belong to this session's data classification");
    }
    const previous = byId.get(fact.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(fact)) {
      throw new RouteError("safety_blocked", "Ambiguous clinical fact identifier");
    }
    byId.set(fact.id, fact);
  }
  const facts = [...byId.values()];
  if (facts.length > MAX_FACTS) throw new RouteError("invalid_request", "Clinical context exceeds the fact limit");
  const groups = new Map<string, ClinicalFact[]>();
  for (const fact of facts) {
    const key = `${fact.category}:${fact.label.trim().toLowerCase()}`;
    groups.set(key, [...groups.get(key) ?? [], fact]);
  }
  const conflicts = [...groups.values()].filter((group) => new Set(group.map(assertion)).size > 1).map((group) => group.map((fact) => fact.id));
  const conflictingIds = new Set(conflicts.flat());
  const eligibleFacts = facts.filter((fact): fact is KnownClinicalFact => fact.status === "known" && !conflictingIds.has(fact.id));
  const missing = facts.filter((fact): fact is MissingInformation => fact.status === "unknown");
  const context = { version: CONTEXT_VERSION, facts, eligibleEvidenceIds: eligibleFacts.map((fact) => fact.id), conflicts };
  if (new TextEncoder().encode(JSON.stringify(context)).length > MAX_CONTEXT_BYTES) {
    throw new RouteError("invalid_request", "Clinical context exceeds the byte limit");
  }
  return { context, facts, missing, conflicts, eligibleFacts };
}

export function validateSelection(text: string, eligibleIds: string[]) {
  let parsed: z.infer<typeof selectionSchema>;
  try { parsed = selectionSchema.parse(JSON.parse(text)); }
  catch { throw new RouteError("provider_unavailable", "Model returned an invalid draft selection"); }
  if (new Set(parsed.evidenceIds).size !== parsed.evidenceIds.length || parsed.evidenceIds.some((id) => !eligibleIds.includes(id))) {
    throw new RouteError("safety_blocked", "Model selected unsupported clinical evidence");
  }
  // Without a validated clinical relevance policy, selection may order but must not
  // silently suppress a documented fact. All nonconflicting known facts are retained.
  if (parsed.evidenceIds.length !== eligibleIds.length) throw new RouteError("safety_blocked", "Model omitted documented clinical evidence");
  return parsed.evidenceIds;
}

export function renderFact(fact: ClinicalFact) {
  const citation = `[${fact.id}; ${fact.source.reference}; documented ${fact.timestamp}]`;
  return fact.status === "known"
    ? `${fact.label}: ${String(fact.value)}${fact.unit ? ` ${fact.unit}` : ""} ${citation}`
    : `${fact.label}: unknown (${fact.reason}) ${citation}`;
}
