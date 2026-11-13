import type { ADMINISTRATIVE_SEXES, DATA_SOURCES } from "@/shared/constants";
import type { IsoDate } from "@/shared/types";
import type { ClinicalFact } from "./clinical-data";

export type AdministrativeSex = (typeof ADMINISTRATIVE_SEXES)[number];
export type DataSource = (typeof DATA_SOURCES)[number];

/** Minimum-necessary patient summary shown to the clinician and given to the AI. */
export interface PatientContext {
  patientId: string;
  displayName: string;
  birthDate?: IsoDate;
  sex: AdministrativeSex;
  allergies: string[];
  activeProblems: string[];
  medications: string[];
  /** Where this data came from. Development and automated tests use "synthetic". */
  source: DataSource;
  /** Optional for M0 compatibility. Omission/empty lists do not establish normal findings. */
  clinicalFacts?: ClinicalFact[];
}
