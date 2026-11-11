import type { DataSource, PatientContext } from "./patient";
import type { EncounterContext } from "./encounter";
import type { IsoDateTime } from "@/shared/types";

export interface ClinicalSource {
  type: DataSource;
  /** Opaque source record/fixture identifier; never credentials or an authenticated URL. */
  reference: string;
}

export type ClinicalFactCategory = "problem" | "medication" | "allergy" | "symptom" | "vital_sign" | "investigation" | "history";
export type MissingInformationReason = "not_recorded" | "not_provided" | "not_performed" | "pending";

interface ClinicalFactBase {
  id: string;
  category: ClinicalFactCategory;
  label: string;
  source: ClinicalSource;
  /** When this assertion (including an assertion of absence) was documented. */
  timestamp: IsoDateTime;
}

export interface KnownClinicalFact extends ClinicalFactBase {
  status: "known";
  value: string | number | boolean;
  unit?: string;
}

/** Unknown is not a negative/normal finding and must never carry a result or unit. */
export interface MissingInformation extends ClinicalFactBase {
  status: "unknown";
  reason: MissingInformationReason;
  value?: never;
  unit?: never;
}

export type ClinicalFact = KnownClinicalFact | MissingInformation;

/** Normalized read port. Implementations preserve provenance and explicit unknowns.
 * Structurally compatible with Core's existing ClinicalDataAdapter; no vendor types,
 * authentication tokens, approval operation or transport are part of this contract.
 * Missing records return null; an unavailable adapter rejects (never a fabricated record).
 */
export interface ClinicalDataAdapter {
  readonly source: DataSource;
  getPatient(patientId: string): Promise<PatientContext | null>;
  getEncounter(encounterId: string): Promise<EncounterContext | null>;
}
