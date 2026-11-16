import type { ExistingOrder } from "@/core/orders/flags";
import type { OrderCreateRequest, OrderRepository } from "@/core/orders/repository";
import { RouteError } from "@/core/errors";
import type { ClinicalFact, EncounterContext, KnownClinicalFact, OrderDraft, OrderDraftSummary, PatientContext } from "@/shared/contracts";

/** FICTIONAL DATA ONLY. The test catalog (order-catalog.ts), the chart facts it is checked against and an order store for the service tests. */
export { ORDER_CATALOG, orderItem } from "./order-catalog.ts";
export const knownFact = (id: string, category: ClinicalFact["category"], label: string, value: KnownClinicalFact["value"] = true): KnownClinicalFact =>
  ({ id, category, label, status: "known", value, source: { type: "fhir", reference: `R/${id}` }, timestamp: "2026-01-15T10:00:00.000Z" });
export const unknownFact = (id: string, category: ClinicalFact["category"], label: string): ClinicalFact =>
  ({ id, category, label, status: "unknown", reason: "not_recorded", source: { type: "fhir", reference: `R/${id}` }, timestamp: "2026-01-15T10:00:00.000Z" });

/** The chart of the fictional patient the order tests use: a penicillin allergy and an active anticoagulant. */
export const ORDER_FACTS: ClinicalFact[] = [
  knownFact("symptom-1", "symptom", "Chest pain", "two hours, pressing"),
  knownFact("problem-1", "problem", "Essential hypertension"),
  knownFact("allergy-1", "allergy", "Penicillins", "Reaction: urticaria"),
  knownFact("med-1", "medication", "Warfarin 5 mg oral tablet", "5 mg once daily"),
  unknownFact("lab-none", "investigation", "Laboratory results in the last 365 days"),
];

export function orderChart(facts: ClinicalFact[] = ORDER_FACTS, patientId = "fic-pt-1", encounterId = "fic-enc-1") {
  const patient: PatientContext = {
    patientId, displayName: "Faisal Fictional-Example", birthDate: "1967-04-02", sex: "male", allergies: [], activeProblems: [], medications: [], source: "fhir", clinicalFacts: facts,
  };
  const encounter: EncounterContext = { encounterId, patientId, type: "outpatient", status: "in_progress", startedAt: "2026-03-10T07:30:00.000Z", reasonForVisit: "Chest pain on exertion" };
  return { patient, encounter, adapter: { source: "fhir" as const, getPatient: async (id: string) => id === patientId ? patient : null, getEncounter: async (id: string) => id === encounterId ? encounter : null } };
}

/**
 * An order repository with the behaviour of the PostgreSQL one that the service relies on: one draft per key, a key used for another
 * request refused, only pending lines at creation, and every stored value a copy. It is the double of the port, not of the database;
 * the database's own rules are tested in supabase/tests/orders.sql.
 */
export function memoryOrderRepository(existing: ExistingOrder[] = []): OrderRepository & { drafts: OrderDraft[]; keys: Map<string, { request: OrderCreateRequest; id: string }> } {
  const drafts: OrderDraft[] = [];
  const keys = new Map<string, { request: OrderCreateRequest; id: string }>();
  const copy = <T,>(value: T): T => structuredClone(value);
  return {
    drafts, keys,
    async get(id) { const found = drafts.find((draft) => draft.id === id); return found ? copy(found) : null; },
    async list() {
      return drafts.map((draft): OrderDraftSummary => ({
        id: draft.id, mode: draft.mode, request: draft.request, lines: draft.lines.length, version: draft.version, createdAt: draft.createdAt, updatedAt: draft.updatedAt,
        pending: draft.lines.filter((line) => line.status === "pending").length, approved: draft.lines.filter((line) => line.status === "approved").length,
        rejected: draft.lines.filter((line) => line.status === "rejected").length,
      }));
    },
    async existing() {
      return [...existing, ...drafts.flatMap((draft) => draft.lines.filter((line) => line.status !== "rejected").map((line): ExistingOrder => ({ catalogItemId: line.catalogItemId, status: line.status })))];
    },
    async replay(key, request) {
      const stored = keys.get(key);
      if (!stored) return null;
      if (JSON.stringify(stored.request) !== JSON.stringify(request)) throw new RouteError("conflict", "This idempotency key was already used for a different request");
      return copy(drafts.find((draft) => draft.id === stored.id)!);
    },
    async create(draft, retry) {
      const stored = keys.get(retry.key);
      if (stored) {
        if (JSON.stringify(stored.request) !== JSON.stringify(retry.request)) throw new RouteError("conflict", "This idempotency key was already used for a different request");
        return copy(drafts.find((entry) => entry.id === stored.id)!);
      }
      if (draft.lines.some((line) => line.status !== "pending" || line.decidedBy)) throw new RouteError("invalid_request", "A new draft holds pending lines only");
      drafts.push(copy(draft));
      keys.set(retry.key, { request: copy(retry.request), id: draft.id });
      return copy(draft);
    },
  };
}
