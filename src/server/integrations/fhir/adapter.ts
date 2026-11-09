import type { EncounterContext, PatientContext } from "@/shared/contracts";

/** Clinical data source. Implementations: synthetic (now), SMART on FHIR R4 (Codex task). */
export interface ClinicalDataAdapter {
  readonly source: "synthetic" | "fhir";
  getPatient(patientId: string): Promise<PatientContext | null>;
  getEncounter(encounterId: string): Promise<EncounterContext | null>;
}
