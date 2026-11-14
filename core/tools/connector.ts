import type { EncounterContext, PatientContext } from "../../shared/contracts/index.ts";

export interface ClinicalDataAdapter {
  readonly source: "synthetic" | "fhir" | "openemr";
  getPatient(patientId: string): Promise<PatientContext | null>;
  /**
   * Returns null when the encounter does not exist or is not the launched one. Throws
   * `ChartUnavailableError` when it exists but cannot be used, so the clinician is told why.
   */
  getEncounter(encounterId: string): Promise<EncounterContext | null>;
}

export type ChartUnavailableCode = "unsupported_encounter";

/**
 * The chart exists but StethoLink cannot work with it. The message is written for the clinician
 * and contains EHR vocabulary only (a status or type code), never patient data or identifiers.
 */
export class ChartUnavailableError extends Error {
  readonly code: ChartUnavailableCode;
  constructor(code: ChartUnavailableCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ChartUnavailableError";
  }
}
