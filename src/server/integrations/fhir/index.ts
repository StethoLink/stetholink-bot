import "server-only";
import { getEnv } from "@/server/config/env";
import type { ClinicalDataAdapter } from "./adapter";
import { syntheticClinicalAdapter } from "./synthetic-adapter";

export type { ClinicalDataAdapter } from "./adapter";

export function getClinicalDataAdapter(): ClinicalDataAdapter {
  if (getEnv().CLINICAL_DATA_SOURCE === "fhir") {
    throw new Error("The FHIR adapter is not implemented yet");
  }
  return syntheticClinicalAdapter;
}
