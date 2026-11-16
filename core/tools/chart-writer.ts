/**
 * Write port to the EHR, separate from the read port. It can only create: there is no update
 * or delete operation to call. Every item carries the key under which the physician's approval
 * was recorded; the same key never creates a second resource.
 * Only the physician approval path constructs these items. No model output reaches this port
 * without a physician having selected that exact item.
 */
export type ChartDocumentType = "soap_note" | "consultation_request" | "specialist_report";
export type ChartWriteItem =
  | { kind: "document"; itemKey: string; documentType: ChartDocumentType; title: string; text: string; language: string }
  | { kind: "allergy"; itemKey: string; substance: string; reaction?: string; intolerance: boolean; confirmedByPhysician: boolean }
  | { kind: "condition"; itemKey: string; name: string; detail?: string }
  | { kind: "medication"; itemKey: string; name: string; dosageText?: string }
  | { kind: "service_request"; itemKey: string; orderKind: "lab" | "imaging" | "nursing"; display: string; code?: OrderCode; physicianNote?: string }
  | { kind: "medication_request"; itemKey: string; display: string; code?: OrderCode; medication: OrderedMedication; physicianNote?: string };

/** The hospital's own code for an order and the medication of a catalog entry, copied unchanged from the catalog the physician approved from. */
export interface OrderCode { system: string; code: string; display?: string }
export interface OrderedMedication { product: string; dose: string; route: string; frequency: string; duration?: string }

export type ChartResourceType = "DocumentReference" | "AllergyIntolerance" | "Condition" | "MedicationStatement" | "ServiceRequest" | "MedicationRequest";
export const RESOURCE_OF: Record<ChartWriteItem["kind"], ChartResourceType> = {
  document: "DocumentReference", allergy: "AllergyIntolerance", condition: "Condition", medication: "MedicationStatement",
  service_request: "ServiceRequest", medication_request: "MedicationRequest",
};

export interface ChartWriteOutcome {
  status: "created" | "existing" | "failed" | "unsupported";
  resourceType: ChartResourceType;
  /** Identifier the EHR assigned. */
  resourceId?: string;
  /** Why nothing was written, for the physician. No patient data. */
  failure?: string;
}

export interface ClinicalWriteAdapter {
  readonly source: "fhir" | "openemr";
  /** Creates the item unless a resource with the same key already exists. Never updates or deletes. */
  create(item: ChartWriteItem): Promise<ChartWriteOutcome>;
}
