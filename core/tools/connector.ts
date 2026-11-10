import type { ConsultationDraft, EncounterContext, PatientContext } from "@/shared/contracts";

export interface ConsultationDelivery {
  draftId: string;
  recipientId: string;
  status: "submitted" | "responded";
  response?: string;
}

export interface ConsultationTransport {
  send(draft: ConsultationDraft, recipientId: string): Promise<ConsultationDelivery>;
  status(draftId: string): Promise<ConsultationDelivery | null>;
}

export interface ClinicalDataAdapter {
  readonly source: "synthetic" | "fhir";
  readonly consultations?: ConsultationTransport;
  getPatient(patientId: string): Promise<PatientContext | null>;
  getEncounter(encounterId: string): Promise<EncounterContext | null>;
}
