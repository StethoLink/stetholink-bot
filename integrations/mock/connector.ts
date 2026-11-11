import { syntheticEncounters, syntheticPatients } from "@/shared/mocks/synthetic-data";
import type { ClinicalDataAdapter as CoreClinicalDataAdapter } from "@/core/tools/connector";
import type { ClinicalDataAdapter } from "@/shared/contracts";
import { encounterContextSchema, patientContextSchema } from "@/shared/schemas";

export const syntheticClinicalAdapter = {
  source: "synthetic",
  async getPatient(id: string) {
    const patient = syntheticPatients.find((p) => p.patientId === id);
    // Parsing validates and returns a fresh copy, isolating fixtures from callers.
    return patient ? patientContextSchema.parse(patient) : null;
  },
  async getEncounter(id: string) {
    const encounter = syntheticEncounters.find((e) => e.encounterId === id);
    return encounter ? encounterContextSchema.parse(encounter) : null;
  },
} satisfies ClinicalDataAdapter & CoreClinicalDataAdapter;
