/**
 * FICTIONAL DATA ONLY. A Synthea-shaped FHIR R4 chart for one invented patient, used by the
 * unit tests and by the fake FHIR server of the end-to-end tests. Nobody here exists.
 * Dates are relative to `now` so the chart always falls inside the connector's time windows.
 */
export const FICTIONAL_PATIENT_ID = "fic-pt-1";
export const FICTIONAL_ENCOUNTER_ID = "fic-enc-1";

type Resource = Record<string, unknown> & { resourceType: string; id: string };

const snomed = (code: string, display: string) => ({ coding: [{ system: "http://snomed.info/sct", code, display }], text: display });
const loinc = (code: string, display: string) => ({ coding: [{ system: "http://loinc.org", code, display }], text: display });
const status = (system: string, code: string) => ({ coding: [{ system: `http://terminology.hl7.org/CodeSystem/${system}`, code }] });
const category = (code: string) => [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code }] }];

export function fictionalChart(now: Date = new Date()) {
  const subject = { reference: `Patient/${FICTIONAL_PATIENT_ID}` };
  const encounter = { reference: `Encounter/${FICTIONAL_ENCOUNTER_ID}` };
  const ago = (days: number, hours = 0) => new Date(now.getTime() - days * 86_400_000 - hours * 3_600_000).toISOString();

  const patient: Resource = {
    resourceType: "Patient", id: FICTIONAL_PATIENT_ID, gender: "male", birthDate: "1970-01-01",
    name: [{ use: "official", family: "Fictional-Example", given: ["Faisal"] }],
  };
  const visit: Resource = {
    resourceType: "Encounter", id: FICTIONAL_ENCOUNTER_ID, status: "in-progress", subject,
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    period: { start: ago(0, 1) }, reasonCode: [snomed("29857009", "Chest pain on exertion")],
  };
  const conditions: Resource[] = [
    { resourceType: "Condition", id: "cond-htn", subject, encounter, code: snomed("59621000", "Essential hypertension"),
      clinicalStatus: status("condition-clinical", "active"), verificationStatus: status("condition-ver-status", "confirmed"), recordedDate: ago(900) },
    { resourceType: "Condition", id: "cond-dm", subject, code: snomed("44054006", "Type 2 diabetes mellitus"),
      clinicalStatus: status("condition-clinical", "active"), verificationStatus: status("condition-ver-status", "confirmed"), onsetDateTime: ago(1500) },
    { resourceType: "Condition", id: "cond-angina", subject, code: snomed("194828000", "Angina pectoris"),
      clinicalStatus: status("condition-clinical", "active"), verificationStatus: status("condition-ver-status", "provisional"), recordedDate: ago(2) },
    // Excluded: refuted, entered in error and resolved records.
    { resourceType: "Condition", id: "cond-asthma", subject, code: snomed("195967001", "Asthma"),
      clinicalStatus: status("condition-clinical", "active"), verificationStatus: status("condition-ver-status", "refuted"), recordedDate: ago(400) },
    { resourceType: "Condition", id: "cond-error", subject, code: snomed("22298006", "Myocardial infarction"),
      clinicalStatus: status("condition-clinical", "active"), verificationStatus: status("condition-ver-status", "entered-in-error"), recordedDate: ago(30) },
    { resourceType: "Condition", id: "cond-pneumonia", subject, code: snomed("233604007", "Pneumonia"),
      clinicalStatus: status("condition-clinical", "resolved"), verificationStatus: status("condition-ver-status", "confirmed"), recordedDate: ago(700) },
  ];
  const medication: Resource = { resourceType: "Medication", id: "med-amlodipine", code: { text: "Amlodipine 5 mg oral tablet" } };
  const medications: Resource[] = [
    { resourceType: "MedicationRequest", id: "rx-metformin", status: "active", intent: "order", subject, authoredOn: ago(200),
      medicationCodeableConcept: { text: "Metformin 500 mg oral tablet" }, dosageInstruction: [{ text: "500 mg by mouth twice daily with meals" }] },
    // Medication by reference and no dosage: the dose must be reported as not recorded.
    { resourceType: "MedicationRequest", id: "rx-amlodipine", status: "active", intent: "order", subject, authoredOn: ago(300),
      medicationReference: { reference: "Medication/med-amlodipine" } },
    { resourceType: "MedicationRequest", id: "rx-stopped", status: "stopped", intent: "order", subject, authoredOn: ago(500),
      medicationCodeableConcept: { text: "Lisinopril 10 mg oral tablet" }, dosageInstruction: [{ text: "10 mg daily" }] },
  ];
  const allergies: Resource[] = [
    { resourceType: "AllergyIntolerance", id: "alg-penicillin", patient: subject, code: snomed("764146007", "Penicillin"), criticality: "high", recordedDate: ago(1200),
      clinicalStatus: status("allergyintolerance-clinical", "active"), verificationStatus: status("allergyintolerance-verification", "confirmed"),
      reaction: [{ manifestation: [snomed("126485001", "Urticaria")], severity: "severe" }] },
    { resourceType: "AllergyIntolerance", id: "alg-latex", patient: subject, code: snomed("1003755004", "Latex"), recordedDate: ago(1000),
      clinicalStatus: status("allergyintolerance-clinical", "active"), verificationStatus: status("allergyintolerance-verification", "refuted") },
  ];
  const vitals: Resource[] = [
    { resourceType: "Observation", id: "obs-bp", status: "final", category: category("vital-signs"), subject, encounter, code: loinc("85354-9", "Blood pressure panel"), effectiveDateTime: ago(0, 1),
      component: [
        { code: loinc("8480-6", "Systolic blood pressure"), valueQuantity: { value: 152, unit: "mmHg" } },
        { code: loinc("8462-4", "Diastolic blood pressure"), valueQuantity: { value: 94, unit: "mmHg" } },
      ] },
    { resourceType: "Observation", id: "obs-hr", status: "final", category: category("vital-signs"), subject, encounter, code: loinc("8867-4", "Heart rate"), effectiveDateTime: ago(0, 1),
      valueQuantity: { value: 88, unit: "/min" } },
    // Superseded by the newer heart rate above.
    { resourceType: "Observation", id: "obs-hr-old", status: "final", category: category("vital-signs"), subject, code: loinc("8867-4", "Heart rate"), effectiveDateTime: ago(5),
      valueQuantity: { value: 71, unit: "/min" } },
    // Excluded: not a final result.
    { resourceType: "Observation", id: "obs-temp-prelim", status: "preliminary", category: category("vital-signs"), subject, code: loinc("8310-5", "Body temperature"), effectiveDateTime: ago(0, 1),
      valueQuantity: { value: 39.4, unit: "Cel" } },
  ];
  const laboratory: Resource[] = [
    { resourceType: "Observation", id: "lab-troponin", status: "final", category: category("laboratory"), subject, code: loinc("10839-9", "Troponin I"), effectiveDateTime: ago(0, 2),
      valueQuantity: { value: 0.02, unit: "ng/mL" }, interpretation: [{ text: "Normal" }], referenceRange: [{ high: { value: 0.04, unit: "ng/mL" } }] },
    { resourceType: "Observation", id: "lab-hba1c", status: "amended", category: category("laboratory"), subject, code: loinc("4548-4", "Hemoglobin A1c"), effectiveDateTime: ago(40),
      valueQuantity: { value: 8.1, unit: "%" } },
    { resourceType: "Observation", id: "lab-culture", status: "final", category: category("laboratory"), subject, code: loinc("630-4", "Urine culture"), effectiveDateTime: ago(20),
      valueString: "No growth after 48 hours" },
    { resourceType: "Observation", id: "lab-covid", status: "final", category: category("laboratory"), subject, code: loinc("94500-6", "SARS-CoV-2 RNA"), effectiveDateTime: ago(60),
      valueCodeableConcept: snomed("260415000", "Not detected") },
    // Outside the laboratory window.
    { resourceType: "Observation", id: "lab-creatinine-old", status: "final", category: category("laboratory"), subject, code: loinc("2160-0", "Creatinine"), effectiveDateTime: ago(800),
      valueQuantity: { value: 1.1, unit: "mg/dL" } },
  ];
  return { patient, encounter: visit, conditions, medications, medication, allergies, vitals, laboratory };
}

const bundle = (resources: Resource[]) => ({ resourceType: "Bundle", type: "searchset", entry: resources.map((resource) => ({ resource })) });

/**
 * Answers one FHIR read or search for the fictional chart, or undefined for an unknown path.
 * `pathname` is relative to the FHIR base, e.g. "/Patient/fic-pt-1".
 */
export function fictionalFhirResponse(pathname: string, query: URLSearchParams, now: Date = new Date()): unknown {
  const chart = fictionalChart(now);
  if (pathname === `/Patient/${FICTIONAL_PATIENT_ID}`) return chart.patient;
  if (pathname === `/Encounter/${FICTIONAL_ENCOUNTER_ID}`) return chart.encounter;
  if (query.get("patient") !== FICTIONAL_PATIENT_ID) return pathname.split("/").length === 2 ? bundle([]) : undefined;
  if (pathname === "/Condition") return bundle(chart.conditions);
  if (pathname === "/MedicationRequest") return bundle([...chart.medications, chart.medication]);
  if (pathname === "/AllergyIntolerance") return bundle(chart.allergies);
  if (pathname === "/Observation") return bundle(query.get("category") === "vital-signs" ? chart.vitals : query.get("category") === "laboratory" ? chart.laboratory : []);
  return undefined;
}
