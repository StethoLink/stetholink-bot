import { createMockConsultationTransport } from "./transport";
import { syntheticEncounters, syntheticPatients } from "@/shared/mocks/synthetic-data";
import type { ClinicalDataAdapter } from "@/core/tools/connector";

const globals = globalThis as typeof globalThis & {
  stetholinkMockTransport?: ReturnType<typeof createMockConsultationTransport>;
};

export const syntheticClinicalAdapter: ClinicalDataAdapter = {
  source: "synthetic",
  consultations: globals.stetholinkMockTransport ??= createMockConsultationTransport(),
  async getPatient(id) {
    return syntheticPatients.find((p) => p.patientId === id) ?? null;
  },
  async getEncounter(id) {
    return syntheticEncounters.find((e) => e.encounterId === id) ?? null;
  },
};
