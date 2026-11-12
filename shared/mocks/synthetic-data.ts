/**
 * SYNTHETIC DATA ONLY. These people do not exist. Never add real patient information to this repository.
 */
import type { ClinicalFact, ConsultationDraft, ConsultationRequest, EncounterContext, MissingInformation, PatientContext } from "@/shared/contracts";

const ahmedSource = { type: "synthetic", reference: "synthetic-case-ahmed-v1" } as const;
// Timestamp of the fictional documentation, not the time an unperformed test was taken.
const ahmedTimestamp = "2026-01-15T10:00:00.000Z";

export const ahmedMissingInformation: MissingInformation[] = ([
  { id: "ahmed-allergies", category: "allergy", label: "Allergy history" },
  { id: "ahmed-blood-pressure", category: "vital_sign", label: "Current blood pressure" },
  { id: "ahmed-ecg", category: "investigation", label: "ECG" },
  { id: "ahmed-troponin", category: "investigation", label: "Troponin" },
  { id: "ahmed-hba1c", category: "investigation", label: "HbA1c" },
  { id: "ahmed-renal-function", category: "investigation", label: "Renal function" },
  { id: "ahmed-lipid-profile", category: "investigation", label: "Lipid profile" },
] satisfies Pick<MissingInformation, "id" | "category" | "label">[]).map((item) => ({
  ...item,
  source: ahmedSource,
  timestamp: ahmedTimestamp,
  status: "unknown",
  // Not provided does not imply the investigation was never performed.
  reason: "not_provided",
}));

export const ahmedClinicalFacts: ClinicalFact[] = [
  { id: "ahmed-hypertension", category: "problem", label: "Essential hypertension", status: "known", value: true, source: ahmedSource, timestamp: ahmedTimestamp },
  { id: "ahmed-diabetes", category: "problem", label: "Type 2 diabetes mellitus", status: "known", value: true, source: ahmedSource, timestamp: ahmedTimestamp },
  // Medication names are documented; no undocumented dose or schedule is invented.
  { id: "ahmed-metformin", category: "medication", label: "Metformin", status: "known", value: "Metformin (dose and schedule not provided)", source: ahmedSource, timestamp: ahmedTimestamp },
  { id: "ahmed-amlodipine", category: "medication", label: "Amlodipine", status: "known", value: "Amlodipine (dose and schedule not provided)", source: ahmedSource, timestamp: ahmedTimestamp },
  ...ahmedMissingInformation,
];

export const ahmedPatient: PatientContext = {
  patientId: "syn-pt-ahmed",
  displayName: "Ahmed (fictional cardiology case)",
  sex: "male",
  allergies: [],
  activeProblems: ["Essential hypertension", "Type 2 diabetes mellitus"],
  medications: ["Metformin (dose and schedule not provided)", "Amlodipine (dose and schedule not provided)"],
  source: "synthetic",
  clinicalFacts: ahmedClinicalFacts,
};

export const ahmedEncounter: EncounterContext = {
  encounterId: "syn-enc-ahmed",
  patientId: ahmedPatient.patientId,
  type: "outpatient",
  status: "in_progress",
  startedAt: ahmedTimestamp,
  location: "Synthetic Cardiology Clinic",
  reasonForVisit: "Cardiology review with known hypertension and diabetes; investigations not provided",
  clinicalFacts: ahmedMissingInformation.filter((fact) => fact.category !== "allergy"),
};

export const ahmedConsultationRequest: ConsultationRequest = {
  patientId: ahmedPatient.patientId,
  encounterId: ahmedEncounter.encounterId,
  specialty: "Cardiology",
  clinicalQuestion: "Review the documented hypertension and diabetes and identify information required for cardiology assessment; investigation results are not provided.",
};

// Fictional emergency chest-pain presentation for the consultation assistant demonstration.
// Every value is invented test data. Nothing here is a reference range or clinical guidance.
const omarSource = { type: "synthetic", reference: "synthetic-case-omar-v1" } as const;
const omarTimestamp = "2026-02-03T08:40:00.000Z";
const omarKnown = (id: string, category: ClinicalFact["category"], label: string, value: string | number | boolean, unit?: string): ClinicalFact =>
  ({ id: `omar-${id}`, category, label, status: "known", value, ...(unit ? { unit } : {}), source: omarSource, timestamp: omarTimestamp });
const omarUnknown = (id: string, category: MissingInformation["category"], label: string, reason: MissingInformation["reason"]): MissingInformation =>
  ({ id: `omar-${id}`, category, label, status: "unknown", reason, source: omarSource, timestamp: omarTimestamp });

export const omarMissingInformation: MissingInformation[] = [
  omarUnknown("troponin-repeat", "investigation", "Repeat high-sensitivity troponin I", "pending"),
  omarUnknown("echo", "investigation", "Echocardiogram", "not_performed"),
  omarUnknown("lipids", "investigation", "Lipid profile", "not_provided"),
  omarUnknown("renal", "investigation", "Renal function", "pending"),
  omarUnknown("family-history", "history", "Family history of premature coronary disease", "not_recorded"),
];

export const omarClinicalFacts: ClinicalFact[] = [
  omarKnown("chest-pain", "symptom", "Chest pain", "Central chest pressure for 2 hours, radiating to the left arm"),
  omarKnown("diaphoresis", "symptom", "Sweating", "Sweating with the chest pain"),
  omarKnown("dyspnea", "symptom", "Shortness of breath", "Shortness of breath on walking since this morning"),
  omarKnown("htn", "problem", "Essential hypertension", true),
  omarKnown("t2dm", "problem", "Type 2 diabetes mellitus", true),
  omarKnown("smoking", "history", "Tobacco use", "Current smoker, 20 pack-years"),
  omarKnown("bp", "vital_sign", "Blood pressure", "148/92", "mmHg"),
  omarKnown("hr", "vital_sign", "Heart rate", 96, "beats/min"),
  omarKnown("spo2", "vital_sign", "Oxygen saturation on room air", 97, "%"),
  omarKnown("ecg", "investigation", "12-lead ECG", "Sinus rhythm, rate 94; ST depression of 1 mm in leads V4 to V6; no ST elevation recorded"),
  omarKnown("troponin", "investigation", "High-sensitivity troponin I at presentation", 34, "ng/L"),
  omarKnown("aspirin", "medication", "Aspirin", "Aspirin 81 mg once daily"),
  omarKnown("atorvastatin", "medication", "Atorvastatin", "Atorvastatin 20 mg at night"),
  omarKnown("metformin", "medication", "Metformin", "Metformin 500 mg twice daily"),
  omarKnown("amlodipine", "medication", "Amlodipine", "Amlodipine 5 mg once daily"),
  omarKnown("allergy", "allergy", "Drug allergies", "No known drug allergies recorded"),
  ...omarMissingInformation,
];

export const omarPatient: PatientContext = {
  patientId: "syn-pt-omar",
  displayName: "Omar (fictional chest-pain case)",
  birthDate: "1964-07-21",
  sex: "male",
  allergies: [],
  activeProblems: ["Essential hypertension", "Type 2 diabetes mellitus"],
  medications: ["Aspirin 81 mg once daily", "Atorvastatin 20 mg at night", "Metformin 500 mg twice daily", "Amlodipine 5 mg once daily"],
  source: "synthetic",
  clinicalFacts: omarClinicalFacts,
};

export const omarEncounter: EncounterContext = {
  encounterId: "syn-enc-omar",
  patientId: omarPatient.patientId,
  type: "emergency",
  status: "in_progress",
  startedAt: omarTimestamp,
  location: "Synthetic Emergency Department",
  reasonForVisit: "Chest pain",
};

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
  ahmedPatient,
  omarPatient,
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
  ahmedEncounter,
  omarEncounter,
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
