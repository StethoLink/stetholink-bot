import { syntheticEncounters, syntheticPatients } from "@/shared/mocks/synthetic-data";
import type { ClinicalDataAdapter } from "./adapter";

export const syntheticClinicalAdapter: ClinicalDataAdapter = {
  source: "synthetic",
  async getPatient(id) {
    return syntheticPatients.find((p) => p.patientId === id) ?? null;
  },
  async getEncounter(id) {
    return syntheticEncounters.find((e) => e.encounterId === id) ?? null;
  },
};
