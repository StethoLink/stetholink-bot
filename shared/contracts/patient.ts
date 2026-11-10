import type { ADMINISTRATIVE_SEXES, DATA_SOURCES } from "@/shared/constants";
import type { IsoDate } from "@/shared/types";

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
  /** Where this data came from. Development must use "synthetic". */
  source: DataSource;
}
