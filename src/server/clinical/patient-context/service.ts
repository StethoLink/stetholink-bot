import type { PatientContext } from "@/shared/contracts";
import type { ClinicalDataAdapter } from "@/server/integrations/fhir/adapter";

/** Applies minimum-necessary rules to adapter output before it reaches the UI or the AI. */
export function createPatientContextService(adapter: ClinicalDataAdapter) {
  return {
    async getContext(patientId: string): Promise<PatientContext | null> {
      return adapter.getPatient(patientId);
    },
  };
}
