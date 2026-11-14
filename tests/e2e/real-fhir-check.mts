import assert from "node:assert/strict";
import { createFhirConnector } from "../../integrations/fhir/connector.ts";
import { fictionalChart, FICTIONAL_ENCOUNTER_ID, FICTIONAL_PATIENT_ID } from "../fixtures/fhir-chart.ts";
import { ensureTrustedLocalhost, startTlsProxy } from "./fakes/tls.mts";

// OPT-IN check against a REAL FHIR server implementation (HAPI FHIR JPA server in Docker), not a fake.
// It loads the fictional chart into the server over FHIR, then reads it back through the product's
// connector with a small page size, so searching, `_include`, sorting and the server's own paging
// links are the real thing. HAPI does not implement SMART authorization; the launch is covered by
// live-ehr-flow.mts. See docs/sandbox.md.
//
//   docker run -d --name stetholink-hapi -p 127.0.0.1:8090:8080 \
//     -e hapi.fhir.server_address=https://localhost:8091/fhir hapiproject/hapi:latest
//   HAPI_URL=http://127.0.0.1:8090/fhir node tests/e2e/real-fhir-check.mts
const hapi = new URL(process.env.HAPI_URL ?? "http://127.0.0.1:8090/fhir");
assert.ok(["localhost", "127.0.0.1"].includes(hapi.hostname), "Use a disposable local FHIR server");
const tls = await ensureTrustedLocalhost();
const proxyPort = Number(hapi.port) + 1;
const proxy = await startTlsProxy(tls, proxyPort, Number(hapi.port));
const base = `https://localhost:${proxyPort}${hapi.pathname.replace(/\/$/, "")}`;

try {
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    ready = await fetch(`${base}/metadata`).then((r) => r.ok).catch(() => false);
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  assert.ok(ready, "The FHIR server did not become ready");
  const capability = await (await fetch(`${base}/metadata`)).json() as { software?: { name?: string; version?: string }; fhirVersion?: string };
  console.log(`Real FHIR server: ${capability.software?.name} ${capability.software?.version}, FHIR ${capability.fhirVersion}`);

  // Load the fictional chart with client-assigned ids (idempotent: PUT replaces the same records).
  const chart = fictionalChart();
  const resources = [chart.patient, chart.encounter, chart.medication, ...chart.conditions, ...chart.medications, ...chart.allergies, ...chart.vitals, ...chart.laboratory];
  const loaded = await fetch(base, {
    method: "POST", headers: { "content-type": "application/fhir+json" },
    body: JSON.stringify({ resourceType: "Bundle", type: "transaction", entry: resources.map((resource) => ({ resource, request: { method: "PUT", url: `${resource.resourceType}/${resource.id}` } })) }),
  });
  assert.equal(loaded.status, 200, await loaded.text());

  const requests: string[] = [];
  const counting: typeof fetch = (target, init) => { requests.push(String(target)); return fetch(target, init); };
  // Page size 2 forces the server to hand out its own next links for every list.
  const connector = createFhirConnector({ baseUrl: base, accessToken: "not-checked-by-hapi", patientId: FICTIONAL_PATIENT_ID, encounterId: FICTIONAL_ENCOUNTER_ID }, counting, { pageSize: 2, maxPages: 10 });
  const patient = await connector.getPatient(FICTIONAL_PATIENT_ID);
  assert.ok(patient);
  const facts = patient.clinicalFacts ?? [];
  const byReference = new Map(facts.map((fact) => [fact.source.reference, fact]));
  const expectKnown = (reference: string, expected: Record<string, unknown>) => {
    const fact = byReference.get(reference);
    assert.ok(fact, `${reference} is a fact`);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual((fact as unknown as Record<string, unknown>)[key], value, `${reference}.${key}`);
  };
  expectKnown("Condition/cond-htn", { label: "Essential hypertension", value: true });
  expectKnown("Condition/cond-angina", { value: "Recorded as provisional" });
  expectKnown("MedicationRequest/rx-metformin", { value: "500 mg by mouth twice daily with meals" });
  expectKnown("MedicationRequest/rx-amlodipine", { label: "Amlodipine 5 mg oral tablet", value: "Dose not recorded in the order" });
  expectKnown("AllergyIntolerance/alg-penicillin", { value: "Reaction: Urticaria (severe); criticality: high" });
  expectKnown("Observation/obs-bp", { value: "Systolic blood pressure 152 mmHg; Diastolic blood pressure 94 mmHg" });
  expectKnown("Observation/obs-hr", { value: 88, unit: "/min" });
  expectKnown("Observation/lab-troponin", { value: "0.02 ng/mL (interpretation recorded: Normal; reference range: up to 0.04 ng/mL)" });
  expectKnown("Observation/lab-hba1c", { value: 8.1, unit: "%" });
  for (const excluded of ["Condition/cond-asthma", "Condition/cond-error", "Condition/cond-pneumonia", "MedicationRequest/rx-stopped", "AllergyIntolerance/alg-latex",
    "Observation/obs-hr-old", "Observation/obs-temp-prelim", "Observation/lab-creatinine-old"]) {
    assert.equal(byReference.has(excluded), false, `${excluded} is excluded`);
  }
  const paged = requests.filter((url) => url.includes("_getpages"));
  assert.ok(paged.length > 0, "The server's own paging links were followed");
  assert.ok(requests.every((url) => url.startsWith(base)), "Every request stayed on the FHIR base");
  assert.equal((patient.chartNotes ?? []).some((note) => note.includes("holds more")), false, "Nothing was cut off by paging");

  const encounter = await connector.getEncounter(FICTIONAL_ENCOUNTER_ID);
  assert.deepEqual({ type: encounter?.type, status: encounter?.status, reason: encounter?.reasonForVisit }, { type: "outpatient", status: "in_progress", reason: "Chest pain on exertion" });
  console.log(`real-fhir-check: passed against a real HAPI FHIR server (${facts.length} facts, ${requests.length} requests, ${paged.length} paging links followed)`);
} finally {
  proxy.close();
}
process.exit(0);
