import type { EncounterContext, PatientContext } from "@/shared/contracts";

export interface ClinicalDataAdapter {
  readonly source: "synthetic" | "fhir" | "openemr";
  getPatient(patientId: string): Promise<PatientContext | null>;
  getEncounter(encounterId: string): Promise<EncounterContext | null>;
}
