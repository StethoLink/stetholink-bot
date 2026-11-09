/**
 * SYNTHETIC DATA ONLY. These people do not exist. Never add real patient information to this repository.
 */
import type { ConsultationDraft, EncounterContext, PatientContext } from "@/shared/contracts";

export const syntheticPatients: PatientContext[] = [
  {
    patientId: "syn-pt-001",
    displayName: "Test Patient Alpha",
    birthDate: "1968-04-12",
    sex: "male",
    allergies: ["Penicillin"],
    activeProblems: ["Type 2 diabetes mellitus", "Essential hypertension"],
    medications: ["Metformin 500 mg BID", "Lisinopril 10 mg daily"],
    source: "synthetic",
  },
  {
    patientId: "syn-pt-002",
    displayName: "Test Patient Beta",
    birthDate: "1991-09-30",
    sex: "female",
    allergies: [],
    activeProblems: ["Asthma, mild persistent"],
    medications: ["Budesonide inhaler 200 mcg BID"],
    source: "synthetic",
  },
];

export const syntheticEncounters: EncounterContext[] = [
  {
    encounterId: "syn-enc-001",
    patientId: "syn-pt-001",
    type: "outpatient",
    status: "in_progress",
    startedAt: "2026-01-15T09:00:00.000Z",
    location: "Internal Medicine Clinic",
    reasonForVisit: "Follow-up of glycemic control",
  },
];

export const syntheticDrafts: ConsultationDraft[] = [
  {
    id: "syn-draft-001",
    patientId: "syn-pt-001",
    encounterId: "syn-enc-001",
    status: "pending_approval",
    summary: "Synthetic follow-up summary for UI development.",
    assessment: "Synthetic assessment text.",
    plan: ["Synthetic plan item 1", "Synthetic plan item 2"],
    generatedBy: "ai",
    createdAt: "2026-01-15T09:30:00.000Z",
    updatedAt: "2026-01-15T09:30:00.000Z",
  },
];
