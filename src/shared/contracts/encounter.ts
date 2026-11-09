import type { ENCOUNTER_STATUSES, ENCOUNTER_TYPES } from "@/shared/constants";
import type { IsoDateTime } from "@/shared/types";

export type EncounterType = (typeof ENCOUNTER_TYPES)[number];
export type EncounterStatus = (typeof ENCOUNTER_STATUSES)[number];

export interface EncounterContext {
  encounterId: string;
  patientId: string;
  type: EncounterType;
  status: EncounterStatus;
  startedAt: IsoDateTime;
  location?: string;
  reasonForVisit?: string;
}
