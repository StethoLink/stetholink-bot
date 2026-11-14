import { describe, expect, it } from "vitest";
import { createFhirConnector } from "@/integrations/fhir/connector";
import { FACT_BUDGET, FACT_BYTE_BUDGET } from "@/integrations/fhir/facts";
import { ChartUnavailableError } from "@/core/tools/connector";
import { groundContext } from "@/core/consultation/grounding";
import { patientContextSchema, encounterContextSchema } from "@/shared/schemas";
import { FICTIONAL_ENCOUNTER_ID, FICTIONAL_PATIENT_ID, fictionalChart, fictionalFhirResponse } from "../fixtures/fhir-chart";
import type { ClinicalFact } from "@/shared/contracts";

/** Every patient, record and identifier here is fictional (Synthea-shaped FHIR R4). */
const BASE = "https://ehr.example.test/fhir";
const TOKEN = "fictional-ehr-token";
const NOW = new Date("2026-06-01T10:00:00.000Z");
const grant = { baseUrl: BASE, accessToken: TOKEN, patientId: FICTIONAL_PATIENT_ID, encounterId: FICTIONAL_ENCOUNTER_ID };

type Handler = (path: string, query: URLSearchParams, url: URL) => unknown;
function server(override?: Handler) {
  const calls: URL[] = [];
  const request = (async (target: URL | string | Request, init?: RequestInit) => {
    const url = new URL(String(target));
    calls.push(url);
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${TOKEN}`) return new Response(null, { status: 401 });
    if (!url.href.startsWith(BASE + "/")) return new Response(null, { status: 404 });
    const path = url.pathname.slice("/fhir".length);
    const body = override?.(path, url.searchParams, url) ?? fictionalFhirResponse(path, url.searchParams, NOW);
    if (body instanceof Response) return body;
    return body === undefined ? new Response(null, { status: 404 }) : Response.json(body);
  }) as typeof fetch;
  return { request, calls };
}
const connect = (override?: Handler, options = {}) => {
  const fake = server(override);
  return { ...fake, connector: createFhirConnector(grant, fake.request, { now: () => NOW, ...options }) };
};
const fact = (facts: ClinicalFact[] | undefined, reference: string) => facts?.find((entry) => entry.source.reference === reference);
const bundle = (resources: unknown[], next?: string) => ({ resourceType: "Bundle", entry: resources.map((resource) => ({ resource })), ...(next ? { link: [{ relation: "next", url: next }] } : {}) });

describe("FHIR chart to clinical facts", () => {
  it("normalizes conditions, medication orders, allergies and observations with their sources and dates", async () => {
    const { connector } = connect();
    const patient = patientContextSchema.parse(await connector.getPatient(FICTIONAL_PATIENT_ID));
    const facts = patient.clinicalFacts!;
    expect(patient).toMatchObject({ displayName: "Faisal Fictional-Example", sex: "male", birthDate: "1970-01-01", source: "fhir" });

    expect(fact(facts, "Condition/cond-htn")).toMatchObject({ category: "problem", label: "Essential hypertension", status: "known", value: true, source: { type: "fhir" } });
    // The onset is used when no recorded date exists; a provisional diagnosis keeps its uncertainty.
    expect(fact(facts, "Condition/cond-dm")?.timestamp).toBe(new Date(NOW.getTime() - 1500 * 86_400_000).toISOString());
    expect(fact(facts, "Condition/cond-angina")).toMatchObject({ value: "Recorded as provisional" });
    for (const excluded of ["cond-asthma", "cond-error", "cond-pneumonia"]) expect(fact(facts, `Condition/${excluded}`)).toBeUndefined();

    expect(fact(facts, "MedicationRequest/rx-metformin")).toMatchObject({ category: "medication", label: "Metformin 500 mg oral tablet", value: "500 mg by mouth twice daily with meals" });
    // Named through the included Medication resource; no dose is invented.
    expect(fact(facts, "MedicationRequest/rx-amlodipine")).toMatchObject({ label: "Amlodipine 5 mg oral tablet", value: "Dose not recorded in the order" });
    expect(fact(facts, "MedicationRequest/rx-stopped")).toBeUndefined();

    expect(fact(facts, "AllergyIntolerance/alg-penicillin")).toMatchObject({ category: "allergy", label: "Penicillin", value: "Reaction: Urticaria (severe); criticality: high" });
    expect(fact(facts, "AllergyIntolerance/alg-latex")).toBeUndefined();

    expect(fact(facts, "Observation/obs-bp")).toMatchObject({ category: "vital_sign", label: "Blood pressure panel", value: "Systolic blood pressure 152 mmHg; Diastolic blood pressure 94 mmHg" });
    expect(fact(facts, "Observation/obs-hr")).toMatchObject({ value: 88, unit: "/min" });
    expect(fact(facts, "Observation/obs-hr-old")).toBeUndefined();
    expect(fact(facts, "Observation/obs-temp-prelim")).toBeUndefined();
    // Interpretation and reference range are copied as recorded, not interpreted.
    expect(fact(facts, "Observation/lab-troponin")).toMatchObject({ category: "investigation", value: "0.02 ng/mL (interpretation recorded: Normal; reference range: up to 0.04 ng/mL)" });
    expect(fact(facts, "Observation/lab-hba1c")).toMatchObject({ value: 8.1, unit: "%" });
    expect(fact(facts, "Observation/lab-culture")).toMatchObject({ value: "No growth after 48 hours" });
    expect(fact(facts, "Observation/lab-covid")).toMatchObject({ value: "Not detected" });
    expect(fact(facts, "Observation/lab-creatinine-old")).toBeUndefined();

    expect(patient.allergies).toEqual(["Penicillin"]);
    expect(patient.activeProblems).toEqual(expect.arrayContaining(["Essential hypertension", "Type 2 diabetes mellitus"]));
    expect(patient.chartNotes?.join(" ")).toContain("latest value of each laboratory test from the last 365 days");
    // Core accepts the result as live facts and can cite every known one.
    const grounded = groundContext(patient, null, "live");
    expect(grounded.eligibleFacts.length).toBe(facts.filter((entry) => entry.status === "known").length);
  });

  it("gives every fact a stable id that does not contain the EHR identifier", async () => {
    const first = (await connect().connector.getPatient(FICTIONAL_PATIENT_ID))!.clinicalFacts!;
    const second = (await connect().connector.getPatient(FICTIONAL_PATIENT_ID))!.clinicalFacts!;
    expect(first.map((entry) => entry.id)).toEqual(second.map((entry) => entry.id));
    expect(new Set(first.map((entry) => entry.id)).size).toBe(first.length);
    for (const entry of first) {
      expect(entry.id).toMatch(/^(allergy|problem|medication|vital|lab)-[0-9a-f]{16}$/);
      expect(entry.id).not.toContain(entry.source.reference.split("/")[1]);
    }
    const keyed = (await connect(undefined, { factIdKey: "another-server-side-key" }).connector.getPatient(FICTIONAL_PATIENT_ID))!.clinicalFacts!;
    expect(keyed[0].id).not.toBe(first[0].id);
  });

  it("reports an empty allergy list as not recorded, and a no-known-allergy record in its own words", async () => {
    const empty = connect((path) => path === "/AllergyIntolerance" ? bundle([]) : undefined);
    const patient = (await empty.connector.getPatient(FICTIONAL_PATIENT_ID))!;
    expect(patient.clinicalFacts!.filter((entry) => entry.category === "allergy")).toEqual([
      expect.objectContaining({ status: "unknown", reason: "not_recorded", label: "Allergies" }),
    ]);
    expect(patient.allergies).toEqual([]);
    expect(JSON.stringify(patient)).not.toMatch(/no (known )?allerg/i);

    const none = connect((path) => path === "/AllergyIntolerance" ? bundle([{
      resourceType: "AllergyIntolerance", id: "alg-nka", patient: { reference: `Patient/${FICTIONAL_PATIENT_ID}` }, recordedDate: "2026-01-05",
      code: { coding: [{ system: "http://snomed.info/sct", code: "716186003", display: "No known allergy" }] },
    }]) : undefined);
    expect((await none.connector.getPatient(FICTIONAL_PATIENT_ID))!.clinicalFacts!.filter((entry) => entry.category === "allergy")).toEqual([
      expect.objectContaining({ status: "known", label: "No known allergy", value: true, source: { type: "fhir", reference: "AllergyIntolerance/alg-nka" } }),
    ]);
  });

  it("follows next links only inside the FHIR base and never sends the token elsewhere", async () => {
    const chart = fictionalChart(NOW);
    const { connector, calls } = connect((path, query, url) => {
      if (path !== "/Condition") return undefined;
      if (query.get("page") === "2") return bundle([chart.conditions[1]], "https://attacker.example.test/fhir/Condition?page=3");
      expect(query.get("_count")).toBe("100");
      return bundle([chart.conditions[0]], `${url.origin}/fhir/Condition?patient=${FICTIONAL_PATIENT_ID}&page=2`);
    });
    const patient = (await connector.getPatient(FICTIONAL_PATIENT_ID))!;
    expect(patient.activeProblems).toEqual(["Essential hypertension", "Type 2 diabetes mellitus"]);
    expect(calls.every((url) => url.origin === "https://ehr.example.test" && url.pathname.startsWith("/fhir/"))).toBe(true);
    expect(patient.chartNotes?.join(" ")).toContain("holds more problem records");
  });

  it("stops at the page limit, keeps what it loaded and tells the physician", async () => {
    const subject = { reference: `Patient/${FICTIONAL_PATIENT_ID}` };
    const { connector, calls } = connect((path, query, url) => {
      if (path !== "/Condition") return undefined;
      const page = Number(query.get("page") ?? 1);
      return bundle([{ resourceType: "Condition", id: `c${page}`, subject, code: { text: `Fictional problem ${page}` }, recordedDate: "2026-01-01",
        clinicalStatus: { coding: [{ code: "active" }] } }], `${url.origin}/fhir/Condition?patient=${FICTIONAL_PATIENT_ID}&page=${page + 1}`);
    }, { maxPages: 3 });
    const patient = (await connector.getPatient(FICTIONAL_PATIENT_ID))!;
    expect(calls.filter((url) => url.pathname === "/fhir/Condition")).toHaveLength(3);
    expect(patient.activeProblems).toHaveLength(3);
    expect(patient.chartNotes?.some((note) => note.includes("holds more problem records"))).toBe(true);
  });

  it("does not fail the chart when one search is refused: the category is an explicit unknown", async () => {
    const { connector } = connect((path, query) => path === "/Observation" && query.get("category") === "laboratory" ? new Response(null, { status: 403 }) : undefined);
    const patient = patientContextSchema.parse(await connector.getPatient(FICTIONAL_PATIENT_ID));
    expect(patient.clinicalFacts!.filter((entry) => entry.category === "investigation")).toEqual([
      expect.objectContaining({ status: "unknown", reason: "not_provided", label: "Laboratory results (could not be loaded from the EHR)" }),
    ]);
    expect(patient.chartNotes).toContain("Laboratory results could not be loaded from the EHR. Check them in the chart.");
    expect(patient.activeProblems.length).toBeGreaterThan(0);
  });

  it("keeps a chart larger than the Core limits inside them, deterministically, and says what was left out", async () => {
    const subject = { reference: `Patient/${FICTIONAL_PATIENT_ID}` };
    const many = (count: number, make: (index: number) => Record<string, unknown>) => Array.from({ length: count }, (_, index) => make(index));
    const day = (index: number) => new Date(NOW.getTime() - (index + 1) * 3_600_000).toISOString();
    const big: Handler = (path, query) => {
      if (path === "/Condition") return bundle(many(40, (i) => ({ resourceType: "Condition", id: `c${i}`, subject, code: { text: `Fictional problem number ${i} ${"x".repeat(120)}` }, recordedDate: day(i), clinicalStatus: { coding: [{ code: "active" }] } })));
      if (path === "/MedicationRequest") return bundle(many(40, (i) => ({ resourceType: "MedicationRequest", id: `m${i}`, status: "active", subject, authoredOn: day(i), medicationCodeableConcept: { text: `Fictional medicine ${i}` }, dosageInstruction: [{ text: `Take as directed ${"y".repeat(150)}` }] })));
      if (path === "/Observation" && query.get("category") === "laboratory") return bundle(many(90, (i) => ({ resourceType: "Observation", id: `l${i}`, status: "final", subject, effectiveDateTime: day(i), code: { coding: [{ system: "http://loinc.org", code: `fic-${i}` }], text: `Fictional test ${i}` }, valueQuantity: { value: i, unit: "mg/dL" } })));
      return undefined;
    };
    const first = patientContextSchema.parse(await connect(big).connector.getPatient(FICTIONAL_PATIENT_ID));
    const second = patientContextSchema.parse(await connect(big).connector.getPatient(FICTIONAL_PATIENT_ID));
    const facts = first.clinicalFacts!;
    expect(facts.length).toBeLessThanOrEqual(FACT_BUDGET);
    expect(new TextEncoder().encode(JSON.stringify(facts)).length).toBeLessThanOrEqual(FACT_BYTE_BUDGET);
    expect(second.clinicalFacts).toEqual(facts);
    // Allergies and vital signs are kept whole; the newest of each larger category is kept first.
    expect(fact(facts, "AllergyIntolerance/alg-penicillin")).toBeDefined();
    expect(fact(facts, "Observation/obs-bp")).toBeDefined();
    expect(fact(facts, "Condition/c0")).toBeDefined();
    expect(fact(facts, "Observation/l0")).toBeDefined();
    expect(fact(facts, "Observation/l89")).toBeUndefined();
    const notes = first.chartNotes!.join("\n");
    expect(notes).toMatch(/Only the \d+ most recent laboratory results are included here; \d+ more are in the chart\./);
    expect(notes).toMatch(/Only the \d+ most recent active problems are included here/);
    // Core takes the reduced chart without refusing it.
    expect(() => groundContext(first, null, "live")).not.toThrow();
  });
});

describe("FHIR encounter", () => {
  const encounter = (change: Record<string, unknown>): Handler => (path) => path === `/Encounter/${FICTIONAL_ENCOUNTER_ID}`
    ? { ...fictionalChart(NOW).encounter, ...change } : undefined;

  it("reads the visit reason and accepts emergency visits that have only arrived or been triaged", async () => {
    expect(encounterContextSchema.parse(await connect().connector.getEncounter(FICTIONAL_ENCOUNTER_ID))).toMatchObject({ type: "outpatient", status: "in_progress", reasonForVisit: "Chest pain on exertion" });
    for (const [status, mapped] of [["arrived", "arrived"], ["triaged", "triaged"], ["onleave", "on_leave"], ["finished", "finished"]] as const) {
      const result = await connect(encounter({ status, class: { code: "EMER" } })).connector.getEncounter(FICTIONAL_ENCOUNTER_ID);
      expect(encounterContextSchema.parse(result)).toMatchObject({ type: "emergency", status: mapped });
    }
    for (const [code, type] of [["IMP", "inpatient"], ["ACUTE", "inpatient"], ["OBSENC", "inpatient"], ["HH", "outpatient"], ["VR", "virtual"]] as const) {
      expect(await connect(encounter({ class: { code } })).connector.getEncounter(FICTIONAL_ENCOUNTER_ID)).toMatchObject({ type });
    }
  });

  it("accepts the R5 shapes of class, status, period and reason", async () => {
    const r5 = encounter({
      status: "discharged", class: [{ coding: [{ code: "IMP" }] }], period: undefined, actualPeriod: { start: "2026-05-30T08:00:00Z" }, reasonCode: undefined,
      reason: [{ value: [{ concept: { text: "Shortness of breath" } }] }],
    });
    expect(await connect(r5).connector.getEncounter(FICTIONAL_ENCOUNTER_ID)).toMatchObject({ type: "inpatient", status: "finished", startedAt: "2026-05-30T08:00:00.000Z", reasonForVisit: "Shortness of breath" });
  });

  it("says why a visit cannot be opened instead of returning nothing", async () => {
    await expect(connect(encounter({ status: "entered-in-error" })).connector.getEncounter(FICTIONAL_ENCOUNTER_ID))
      .rejects.toMatchObject({ code: "unsupported_encounter", message: expect.stringContaining("entered-in-error") });
    const unknownClass = connect(encounter({ class: { code: "XYZ" } })).connector.getEncounter(FICTIONAL_ENCOUNTER_ID);
    await expect(unknownClass).rejects.toBeInstanceOf(ChartUnavailableError);
    await expect(unknownClass).rejects.toMatchObject({ message: expect.stringContaining("XYZ") });
    // Another patient's visit, or one that is not the launched visit, still does not exist for this session.
    expect(await connect(encounter({ subject: { reference: "Patient/someone-else" } })).connector.getEncounter(FICTIONAL_ENCOUNTER_ID)).toBeNull();
    expect(await connect().connector.getEncounter("another-encounter")).toBeNull();
  });
});
