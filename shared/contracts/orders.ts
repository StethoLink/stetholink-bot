import type { IsoDateTime } from "@/shared/types";
import type { ClinicalFact, MissingInformation } from "./clinical-data";
import type { DataClassification } from "./classification";

/** What kind of order a catalog entry is. Medication orders carry a fixed product and dose from the catalog. */
export type OrderKind = "lab" | "imaging" | "medication" | "nursing";
export type OrderMode = "specific" | "case_based";

/**
 * One order the hospital has approved for drafting. The catalog is the only source of orders:
 * the model picks entries by id and can write nothing else into an order, no code, product or dose.
 */
export interface OrderCatalogItem {
  id: string;
  kind: OrderKind;
  /** How the order is named to the physician. */
  display: string;
  /** Other names the physician may use for it ("CBC", "complete blood count", the Arabic name). */
  synonyms: string[];
  /** The EHR's own code for the order, copied unchanged into the written order. */
  code?: { system: string; code: string; display?: string };
  /** Medication only: exactly what may be ordered. Nothing else is accepted from anyone. */
  medication?: { product: string; dose: string; route: string; frequency: string; duration?: string };
  /** Words that name the same thing in a chart's active medications (generic name, brand, class). */
  matchTerms: string[];
  /** Groups the hospital's interaction rules refer to, for example "anticoagulant". */
  groups: string[];
  /** Chart allergy words that make this order unsafe (for amoxicillin: "penicillin"). Empty when an allergy does not matter. */
  allergyTerms: string[];
}
export interface OrderSet { id: string; name: string; synonyms: string[]; itemIds: string[] }
export interface InteractionRule { groups: [string, string]; severity: "major" | "moderate" | "minor"; text: string }
export interface OrderCatalog { version: string; items: OrderCatalogItem[]; sets: OrderSet[]; interactions: InteractionRule[] }

/**
 * What the check found about one order. The physician decides; a flag is never a refusal or an approval.
 * `allergies_unchecked` and `interactions_unchecked` mean the chart did not give StethoLink what the check needs.
 */
export type OrderFlagKind = "allergy" | "allergies_unchecked" | "duplicate_active" | "duplicate_order" | "interaction" | "interactions_unchecked";
export interface OrderFlag {
  kind: OrderFlagKind;
  /** Set for interactions only. */
  severity?: InteractionRule["severity"];
  text: string;
  /** The chart facts the flag rests on. Empty when it rests on the draft itself or on what is missing. */
  evidenceIds: string[];
}

export type OrderLineStatus = "pending" | "approved" | "rejected";
export interface OrderLine {
  id: string;
  catalogItemId: string;
  kind: OrderKind;
  display: string;
  code?: OrderCatalogItem["code"];
  medication?: OrderCatalogItem["medication"];
  /** The physician's own words that name the order; set when the physician asked for it by name. */
  basis: "requested" | "proposed";
  requestedText?: string;
  /** Why the order, in one sentence written from the cited facts. */
  reason: string;
  /** The chart facts that justify it. A proposed order always has at least one. */
  evidenceIds: string[];
  flags: OrderFlag[];
  status: OrderLineStatus;
  decidedBy?: string;
  decidedAt?: IsoDateTime;
  /** The physician's acknowledgement of each flag kind at approval, and the reason for going ahead where one is required. */
  acknowledged?: OrderFlagKind[];
  overrideReason?: string;
}

export interface OrderDraft {
  id: string;
  patientId: string;
  encounterId?: string;
  mode: OrderMode;
  /** The physician's request, as written. */
  request: string;
  catalogVersion: string;
  lines: OrderLine[];
  /** The request phrases the catalog could not match, shown to the physician; nothing is drafted for them. */
  unmatched: string[];
  /** Chart facts the lines cite, and what the chart did not give. */
  clinicalFacts: ClinicalFact[];
  missingInformation: MissingInformation[];
  notes: string[];
  provenance: { provider: string; model: string; promptVersion: string; dataClassification: DataClassification; rejectedLines: number };
  version: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** The physician's decision on one line. */
export interface OrderLineDecision {
  lineId: string;
  decision: "approve" | "reject";
  acknowledged?: OrderFlagKind[];
  overrideReason?: string;
}
export interface OrderDecisionRequest {
  draftId: string;
  expectedVersion: number;
  idempotencyKey: string;
  decisions: OrderLineDecision[];
}
