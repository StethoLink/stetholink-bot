import type { PatientContextService } from "@/shared/contracts";

/** Placeholder until the FHIR integration (src/server/integrations/fhir) lands. */
export const patientContextService: PatientContextService = {
  async getContext() {
    return null;
  },
};
