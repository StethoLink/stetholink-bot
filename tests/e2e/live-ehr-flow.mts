import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { ORDER_CATALOG } from "../fixtures/order-catalog.ts";
import { startFakeEhr } from "./fakes/ehr.mts";
import { ensureTrustedLocalhost, startTlsProxy } from "./fakes/tls.mts";

// The product's only code path, black box, with FAKE servers and FICTIONAL data (the fakes live here, under tests/):
//   production build  +  fake SMART/OIDC issuer (real signed ID tokens)
//   +  fake FHIR R4 server (one invented patient)  +  fake model endpoint  +  disposable PostgreSQL.
// SMART launch -> chart facts shown -> draft cites FHIR facts -> physician approves.
// It verifies the protocol and the boundaries. It does not verify a real EHR or a real model.
assert.ok(["localhost", "127.0.0.1"].includes(new URL(process.env.STETHOLINK_DATABASE_URL ?? "").hostname), "Use a disposable loopback database");
const tls = await ensureTrustedLocalhost();
const appPort = Number(process.env.LIVE_TEST_APP_PORT ?? 3081);
const httpsPort = appPort + 1;
const ehrPort = appPort + 2;
const base = `https://localhost:${httpsPort}`;
const clientId = "fictional-smart-client";
const modelKey = "fictional-model-key";
const physician = { subject: "fic-sub-physician", fhirUser: "Practitioner/fic-dr-1", clinicianId: "66666666-6666-4666-8666-666666666661" };
const cardiologist = { subject: "fic-sub-cardiologist", fhirUser: "Practitioner/fic-card-1", specialistId: "77777777-7777-4777-8777-777777777771", providerId: "fictional-cardiology-service", displayName: "Dr Fictional Cardiologist" };
const radiologist = { subject: "fic-sub-radiologist", fhirUser: "Practitioner/fic-rad-1", specialistId: "77777777-7777-4777-8777-777777777772", providerId: "fictional-radiology-service", displayName: "Dr Fictional Radiologist" };
const nurse = { subject: "fic-sub-nurse", fhirUser: "Practitioner/fic-rn-1", clinicianId: "66666666-6666-4666-8666-666666666662" };
const scope = "launch openid fhirUser patient/Patient.rs patient/Encounter.rs patient/Condition.rs patient/MedicationRequest.rs patient/AllergyIntolerance.rs patient/Observation.rs patient/DocumentReference.c patient/AllergyIntolerance.c patient/Condition.c patient/ServiceRequest.c patient/MedicationRequest.c";
process.env.SMART_SCOPE = scope;

const ehr = await startFakeEhr({
  port: ehrPort, tls, clientId, redirectUri: `${base}/api/smart/callback`, modelKey,
  users: { [physician.subject]: { fhirUser: physician.fhirUser }, [nurse.subject]: { fhirUser: nurse.fhirUser }, "fic-sub-unmapped": { fhirUser: "Practitioner/fic-unknown" },
    [cardiologist.subject]: { fhirUser: cardiologist.fhirUser }, [radiologist.subject]: { fhirUser: radiologist.fhirUser } },
});
const proxy = await startTlsProxy(tls, httpsPort, appPort);
let app: ChildProcess | undefined;
// The hospital's own order catalog is a file it owns; here the fictional test catalog is written out as one.
const orderDirectory = mkdtempSync(join(tmpdir(), "stetholink-e2e-orders-"));
const orderCatalogFile = join(orderDirectory, "orders.json");
writeFileSync(orderCatalogFile, JSON.stringify(ORDER_CATALOG));
const malformedCatalogFile = join(orderDirectory, "malformed.json");
writeFileSync(malformedCatalogFile, JSON.stringify({ ...ORDER_CATALOG, items: [{ ...ORDER_CATALOG.items[0], medication: { product: "x", dose: "1", route: "o", frequency: "d" } }] }));

const liveEnv: Record<string, string> = {
  NODE_ENV: "production", TENANT_ID: "ci-live-hospital", AUTH_MODE: "smart", CLINICAL_DATA_SOURCE: "fhir",
  FHIR_BASE_URL: ehr.fhirBase, SMART_CLIENT_ID: clientId, SMART_AUTHORIZATION_URL: `${ehr.oidcIssuer}/authorize`, SMART_TOKEN_URL: `${ehr.oidcIssuer}/token`,
  SMART_REDIRECT_URI: `${base}/api/smart/callback`, SMART_OIDC_ISSUER: ehr.oidcIssuer, SMART_JWKS_URL: `${ehr.oidcIssuer}/jwks`, SMART_SCOPE: scope,
  SMART_CLINICIAN_MAP: JSON.stringify([{ ...physician, role: "physician" }, { ...nurse, role: "clinician" }]),
  AI_PROVIDER: "openai", OPENAI_API_KEY: modelKey, OPENAI_BASE_URL: ehr.modelBase, OPENAI_MODEL: "fictional-model-1",
  OPENAI_INPUT_USD_PER_MILLION: "1", OPENAI_OUTPUT_USD_PER_MILLION: "1", MODEL_LIVE_DATA_APPROVED: "true",
  // The tenant's own receiving services (inbox inside the plugin) and who may open each inbox.
  PROVIDER_DIRECTORY: JSON.stringify([
    { id: "fictional-cardiology-service", displayName: "Fictional Cardiology Service", specialties: ["Cardiology"], transport: "portal" },
    { id: "fictional-radiology-service", displayName: "Fictional Radiology Service", specialties: ["Radiology"], transport: "portal" },
    { id: "fictional-neurology-service", displayName: "Fictional Neurology Service (not allowlisted)", specialties: ["Cardiology"], transport: "portal" },
  ]),
  PROVIDER_ALLOWLIST: "fictional-cardiology-service,fictional-radiology-service",
  SPECIALIST_MAP: JSON.stringify([cardiologist, radiologist]),
  // Scribe and EHR write-back, against the fake transcription endpoint and the fake FHIR server.
  SCRIBE_ENABLED: "true", TRANSCRIPTION_PROVIDER: "openai", TRANSCRIPTION_MODEL: "fictional-transcribe-1", TRANSCRIPTION_USD_PER_MINUTE: "0.0045",
  TRANSCRIPTION_LIVE_DATA_APPROVED: "true", SCRIBE_NOTE_MODEL: "fictional-model-1", SCRIBE_NOTE_INPUT_USD_PER_MILLION: "0.25", SCRIBE_NOTE_OUTPUT_USD_PER_MILLION: "2",
  // Order drafting, from the hospital's catalog file.
  ORDER_CATALOG_FILE: orderCatalogFile,
  EHR_WRITE_ENABLED: "true", SESSION_ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
};

async function start(extra: Record<string, string> = {}) {
  const inherited: Record<string, string | undefined> = { ...process.env };
  // Settings of the removed synthetic modes must not leak in from the caller's shell: the server refuses to start with them.
  for (const key of ["STAGING_LAUNCH_SECRET", "VERCEL_ENV", "VERCEL_TARGET_ENV", "STAGING_SESSION_SECONDS", "STAGING_LIVE_MODEL", "MOCK_PROVIDER_SECRET", "MOCK_RECIPIENT_IDS", "LOCAL_SYNTHETIC_CHART", "CLINICAL_DATA_MODE", "NEXT_PUBLIC_API_MODE"]) delete inherited[key];
  const env: Record<string, string | undefined> = { ...inherited, ...liveEnv, ...extra };
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "apps/embedded-app", "--hostname", "127.0.0.1", "--port", String(appPort)],
    { env, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 150; i++) {
    if (app.exitCode !== null) return false;
    if (await fetch(base + "/api/health").then((r) => r.ok).catch(() => false)) return true;
    await setTimeout(100);
  }
  throw new Error("Server startup timed out");
}
async function stop() {
  if (!app || app.exitCode !== null) return;
  const exited = once(app, "exit");
  app.kill("SIGTERM");
  await exited;
  app = undefined;
}
const cookieOf = (response: Response, name: string) => response.headers.getSetCookie().find((h) => h.startsWith(name + "="))?.split(";")[0];
async function call(path: string, expected: number, opts: { cookie?: string; body?: object; method?: string } = {}) {
  const response = await fetch(base + path, { method: opts.method ?? (opts.body ? "POST" : "GET"), redirect: "manual",
    headers: { "content-type": "application/json", ...(opts.cookie ? { cookie: opts.cookie } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await response.text();
  assert.equal(response.status, expected, `${path} -> ${response.status} ${text.slice(0, 300)}`);
  return { response, json: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : null };
}
/** The whole EHR launch, as a browser would walk it: launch -> EHR authorization -> callback -> session cookie. */
async function smartLaunch(subject: string, expectedCallback = 303, context: { patient?: string; encounter?: string } = { patient: "fic-pt-1", encounter: "fic-enc-1" }) {
  ehr.state.currentUser = subject;
  ehr.state.context = { patient: context.patient, encounter: context.encounter };
  const begin = await call("/api/smart/launch?" + new URLSearchParams({ iss: ehr.fhirBase, launch: "fictional-launch-context" }), 307);
  const launchCookie = cookieOf(begin.response, "stetholink-smart-launch");
  assert.ok(launchCookie, "The pending launch is bound to a browser cookie");
  const authorize = await fetch(begin.response.headers.get("location")!, { redirect: "manual" });
  assert.equal(authorize.status, 302);
  const callback = new URL(authorize.headers.get("location")!);
  const done = await call(callback.pathname + callback.search, expectedCallback, { cookie: launchCookie });
  return { cookie: cookieOf(done.response, "stetholink-session"), body: done.json, response: done.response };
}

const drafts = "/api/consultations/drafts";
const chart = { patientId: "fic-pt-1", encounterId: "fic-enc-1" };
const run = crypto.randomUUID();

try {
  // --- The server refuses an incomplete configuration, and every removed stand-in, at startup ---
  for (const [why, change] of [
    ["without model approval for patient data", { MODEL_LIVE_DATA_APPROVED: "false" }],
    ["without a model key", { OPENAI_API_KEY: "" }],
    ["without an EHR data source", { CLINICAL_DATA_SOURCE: "" }],
    ["without the SMART registration", { SMART_CLIENT_ID: "" }],
    ["with the stand-in model", { AI_PROVIDER: "mock" }],
    ["with built-in fictional charts", { CLINICAL_DATA_SOURCE: "synthetic" }],
    ["with synthetic mode", { CLINICAL_DATA_MODE: "synthetic" }],
    ["with the development sign-in", { AUTH_MODE: "dev" }],
    ["with the staging sign-in", { AUTH_MODE: "staging", STAGING_LAUNCH_SECRET: "x".repeat(64) }],
    ["with the stand-in transcription", { TRANSCRIPTION_PROVIDER: "mock" }],
    ["with simulated specialists", { MOCK_RECIPIENT_IDS: "synthetic-cardiology" }],
    ["with an order catalog that is not valid", { ORDER_CATALOG_FILE: malformedCatalogFile }],
    ["with an order catalog that cannot be read", { ORDER_CATALOG_FILE: join(orderDirectory, "missing.json") }],
  ] as const) {
    assert.equal(await start(change), false, `The server must not start ${why}`);
    await stop();
  }
  assert.equal(await start(), true);

  // --- No session without the EHR launch; the removed launches, demo and simulator are gone ---
  await call("/api/auth/session", 401);
  await call("/api/staging/launch", 404, { body: { profile: "physician" } });
  await call("/staging", 404);
  await call("/api/consultations/demo", 404, { method: "POST" });
  await call("/api/smart/launch?" + new URLSearchParams({ iss: "https://untrusted.example.test/fhir", launch: "x" }), 403);
  const unmapped = await smartLaunch("fic-sub-unmapped", 403);
  assert.equal(unmapped.cookie, undefined);

  // --- Signed launch: identity, role and permissions come from the server mapping ----------
  const doctor = (await smartLaunch(physician.subject)).cookie!;
  assert.ok(doctor);
  const session = (await call("/api/auth/session", 200, { cookie: doctor })).json;
  assert.deepEqual({ clinicianId: session.clinicianId, roles: session.roles, patientId: session.patientId, encounterId: session.encounterId, dataClassification: session.dataClassification },
    { clinicianId: physician.clinicianId, roles: ["physician"], ...chart, dataClassification: "live" });
  assert.equal(JSON.stringify(session).includes("fictional-"), false, "The EHR token never reaches the browser");

  // --- The chart is shown as normalized facts with their sources ---------------------------
  const patient = (await call("/api/patients/fic-pt-1/context", 200, { cookie: doctor })).json;
  assert.equal(patient.source, "fhir");
  const references = patient.clinicalFacts.map((fact: { source: { reference: string } }) => fact.source.reference);
  for (const expected of ["Condition/cond-htn", "MedicationRequest/rx-metformin", "AllergyIntolerance/alg-penicillin", "Observation/obs-bp", "Observation/lab-troponin"]) {
    assert.ok(references.includes(expected), `${expected} is a chart fact`);
  }
  for (const excluded of ["Condition/cond-asthma", "MedicationRequest/rx-stopped", "AllergyIntolerance/alg-latex", "Observation/obs-temp-prelim"]) {
    assert.equal(references.includes(excluded), false, `${excluded} is excluded`);
  }
  assert.ok(patient.chartNotes.some((note: string) => note.includes("Older results are not included")));
  const encounter = (await call("/api/encounters/fic-enc-1", 200, { cookie: doctor })).json;
  assert.equal(encounter.reasonForVisit, "Chest pain on exertion");
  await call("/api/patients/another-patient/context", 404, { cookie: doctor });
  // Free-text chat stays off for real patient data.
  await call("/api/chat", 501, { cookie: doctor, body: { message: "Summarise this chart" } });

  // --- Draft: every statement cites a FHIR fact; the model saw no identifiers --------------
  const request = "Prepare a cardiology consultation about exertional chest pain: is further cardiac work-up needed?";
  await call(drafts, 403, { cookie: doctor, body: { patientId: "another-patient", request } });
  const draft = (await call(drafts, 201, { cookie: doctor, body: { ...chart, request, idempotencyKey: "live-" + run } })).json;
  assert.equal(draft.status, "pending_approval");
  assert.equal(draft.grounding.provenance.dataClassification, "live");
  assert.equal(draft.grounding.provenance.model, "fictional-model-1");
  assert.equal(draft.grounding.authoring.liveInference, true);
  assert.equal(draft.grounding.specialty, "Cardiology");
  assert.equal(draft.grounding.safetyFlags.includes("insufficient_clinical_data"), false);
  const factById = new Map<string, { source: { type: string; reference: string } }>(draft.clinicalFacts.map((fact: { id: string }) => [fact.id, fact]));
  const cited = [...draft.summary.matchAll(/\[([^\[\]]+)\]/g)].map((match: RegExpMatchArray) => match[1]);
  assert.ok(cited.length >= 8, "The draft cites chart facts");
  const citedTypes = new Set(cited.map((id: string) => {
    const fact = factById.get(id);
    assert.ok(fact && fact.source.type === "fhir", `Citation ${id} resolves to a FHIR fact`);
    return fact.source.reference.split("/")[0];
  }));
  assert.deepEqual([...citedTypes].sort(), ["AllergyIntolerance", "Condition", "MedicationRequest", "Observation"]);
  assert.ok(draft.summary.includes("Dose not recorded in the order"), "A missing dose is stated, not invented");
  assert.ok(draft.summary.includes("Age: ") && draft.summary.includes("Sex: Male"));
  const modelCalls = ehr.state.modelRequests.filter((entry) => entry.task === "consultation_referral");
  assert.equal(modelCalls.length, 1);
  for (const secret of ["Faisal", "Fictional-Example", "1970-01-01", "fic-pt-1", "fic-enc-1", "cond-htn", "rx-metformin", "alg-penicillin", "obs-bp", "Practitioner"]) {
    assert.equal(modelCalls[0].body.includes(secret), false, `The model request must not contain ${secret}`);
  }
  // Same key, same request: the stored draft is returned, the model is not charged again for a new one.
  const replay = (await call(drafts, 201, { cookie: doctor, body: { ...chart, request, idempotencyKey: "live-" + run } })).json;
  assert.equal(replay.id, draft.id);

  // --- A non-physician can draft but cannot approve ----------------------------------------
  const observer = (await smartLaunch(nurse.subject)).cookie!;
  assert.deepEqual((await call("/api/auth/session", 200, { cookie: observer })).json.roles, ["clinician"]);
  const nurseDraft = (await call(drafts, 201, { cookie: observer, body: { ...chart, request, idempotencyKey: "live-nurse-" + run } })).json;
  const approval = (id: string, version: number, key: string) => ({ draftId: id, decision: "approve", recipientId: "fictional-cardiology-service", expectedVersion: version, idempotencyKey: key });
  await call(`${drafts}/${nurseDraft.id}/approval`, 403, { cookie: observer, body: approval(nurseDraft.id, nurseDraft.version, "live-nurse-approve-" + run) });
  // Another clinician's draft is not visible to the physician session (RLS).
  await call(`${drafts}/${nurseDraft.id}`, 404, { cookie: doctor });

  // --- The physician approves; the destination must be on the tenant allowlist -------------
  await call(`${drafts}/${draft.id}/approval`, 403, { cookie: doctor, body: { ...approval(draft.id, draft.version, "live-bad-" + run), recipientId: "not-allowlisted" } });
  const approved = (await call(`${drafts}/${draft.id}/approval`, 200, { cookie: doctor, body: approval(draft.id, draft.version, "live-approve-" + run) })).json;
  assert.equal(approved.lifecycleStatus, "approved");
  assert.equal(approved.reviewedBy, physician.clinicianId);
  assert.equal(approved.approvedRecipientId, "fictional-cardiology-service");
  const history = (await call(`${drafts}/${draft.id}/history`, 200, { cookie: doctor })).json;
  assert.ok(history.events.some((event: { toStatus: string }) => event.toStatus === "approved"));

  // === Orders: drafted from the hospital's catalog, grounded in the chart, none approved by drafting ===
  const ordersApi = "/api/orders/drafts";
  await call(ordersApi, 401, { body: { request: "Prepare a CBC", idempotencyKey: "orders-anon-" + run } });
  await call(ordersApi, 400, { cookie: doctor, body: { request: "x".repeat(2001), idempotencyKey: "orders-long-" + run } });
  await call(ordersApi, 400, { cookie: doctor, body: { request: "Prepare a CBC" } });
  await call(ordersApi, 400, { cookie: doctor, body: { request: "Prepare a CBC", idempotencyKey: "orders-extra-" + run, patientId: "another-patient" } });
  const orderRequest = "Prepare a CBC and amoxicillin for this patient";
  const orderKey = "orders-1-" + run;
  const orders = (await call(ordersApi, 201, { cookie: doctor, body: { request: orderRequest, idempotencyKey: orderKey } })).json;
  assert.deepEqual([orders.mode, orders.catalogVersion, orders.patientId, orders.encounterId], ["specific", "test-1", "fic-pt-1", "fic-enc-1"]);
  assert.deepEqual(orders.lines.map((line: { catalogItemId: string; basis: string; status: string }) => [line.catalogItemId, line.basis, line.status]), [["lab-cbc", "requested", "pending"], ["med-amox", "requested", "pending"]]);
  assert.ok(orders.lines.every((line: { decidedBy?: string; decidedAt?: string }) => !line.decidedBy && !line.decidedAt), "Drafting approves nothing");
  // The code and the dose are the catalog's own.
  assert.deepEqual(orders.lines[0].code, { system: "urn:test", code: "CBC-1" });
  assert.deepEqual(orders.lines[1].medication, { product: "Amoxicillin", dose: "500 mg", route: "oral", frequency: "every 8 hours", duration: "7 days" });
  // The chart's documented penicillin allergy flags the amoxicillin, citing the EHR's own record; the CBC has no flag.
  const allergyFlag = orders.lines[1].flags.find((flag: { kind: string }) => flag.kind === "allergy");
  assert.ok(allergyFlag, "The amoxicillin is flagged for the documented penicillin allergy");
  assert.deepEqual(orders.lines[0].flags, []);
  const citedFact = orders.clinicalFacts.find((fact: { id: string }) => fact.id === allergyFlag.evidenceIds[0]);
  assert.deepEqual([citedFact.category, citedFact.source.type, citedFact.source.reference], ["allergy", "fhir", "AllergyIntolerance/alg-penicillin"]);
  // The model chose among the catalog's names and saw no identifier, code or dose.
  const orderModel = ehr.state.modelRequests.filter((entry) => entry.task === "order_drafting");
  assert.equal(orderModel.length, 1);
  for (const secret of ["Faisal", "Fictional-Example", "1970-01-01", "fic-pt-1", "fic-enc-1", "alg-penicillin", "Practitioner", "CBC-1", "urn:test", "every 8 hours", "allergyTerms"]) {
    assert.equal(orderModel[0].body.includes(secret), false, `The order model request must not contain ${secret}`);
  }
  assert.ok(JSON.parse(orderModel[0].body).instructions.includes("stand-ins"), "The request went through the de-identification layer");
  // Of each catalog order the model is shown its id, kind, name and synonyms: no code, product, dose, route, frequency, allergy words or groups.
  const orderInput = JSON.parse(JSON.parse(orderModel[0].body).input[0].content) as { request: string; catalog: { items: object[] } };
  assert.equal(orderInput.request, orderRequest);
  assert.ok(orderInput.catalog.items.every((item) => JSON.stringify(Object.keys(item)) === JSON.stringify(["id", "kind", "display", "synonyms"])));
  // The same key and request returns the stored draft and does not ask the model again; the key for another request is refused.
  assert.equal((await call(ordersApi, 201, { cookie: doctor, body: { request: orderRequest, idempotencyKey: orderKey } })).json.id, orders.id);
  await call(ordersApi, 409, { cookie: doctor, body: { request: "Prepare a lipid panel", idempotencyKey: orderKey } });
  assert.equal(ehr.state.modelRequests.filter((entry) => entry.task === "order_drafting").length, 1);
  // The same order again in this visit is a duplicate.
  const again = (await call(ordersApi, 201, { cookie: doctor, body: { request: "Prepare a CBC", idempotencyKey: "orders-2-" + run } })).json;
  assert.deepEqual(again.lines.map((line: { flags: { kind: string }[] }) => line.flags.map((flag) => flag.kind)), [["duplicate_order"]]);
  // For the case: only the orders of the set the request names, each with the chart facts that support it; the invented one is dropped.
  const proposed = (await call(ordersApi, 201, { cookie: doctor, body: { request: "Prepare the basic orders for this case", idempotencyKey: "orders-3-" + run } })).json;
  assert.equal(proposed.mode, "case_based");
  assert.deepEqual(proposed.lines.map((line: { catalogItemId: string }) => line.catalogItemId), ["lab-cbc", "img-cxr", "lab-trop", "nur-obs"]);
  assert.ok(proposed.lines.every((line: { basis: string; evidenceIds: string[] }) => line.basis === "proposed" && line.evidenceIds.length > 0));
  const storedFacts = new Set(proposed.clinicalFacts.map((fact: { id: string }) => fact.id));
  assert.ok(proposed.lines.every((line: { evidenceIds: string[] }) => line.evidenceIds.every((id) => storedFacts.has(id))), "Every citation resolves to a fact stored with the draft");
  assert.equal(proposed.provenance.rejectedLines, 1, "The order that is not in the catalog was dropped");
  // A request the catalog cannot serve stores nothing.
  const listed = (await call(ordersApi, 200, { cookie: doctor })).json;
  assert.equal(listed.length, 3);
  const noMatch = (await call(ordersApi, 200, { cookie: doctor, body: { request: "an MRI of the knee", idempotencyKey: "orders-4-" + run } })).json;
  assert.deepEqual([noMatch.outcome, noMatch.unmatched], ["no_match", ["an MRI of the knee"]]);
  assert.equal((await call(ordersApi, 200, { cookie: doctor })).json.length, 3);
  // A non-physician can draft; their drafts are theirs alone (row-level security), and the physician's are not theirs.
  const nurseOrders = (await call(ordersApi, 201, { cookie: observer, body: { request: "Prepare a CBC", idempotencyKey: "orders-nurse-" + run } })).json;
  assert.deepEqual(nurseOrders.lines.map((line: { flags: { kind: string }[] }) => line.flags.map((flag) => flag.kind)), [["duplicate_order"]], "A colleague's orders in the same visit are seen by the duplicate check");
  await call(`${ordersApi}/${nurseOrders.id}`, 404, { cookie: doctor });
  await call(`${ordersApi}/${orders.id}`, 404, { cookie: observer });
  assert.equal((await call(ordersApi, 200, { cookie: observer })).json.length, 1);
  await call(`${ordersApi}/not-a-draft`, 400, { cookie: doctor });
  await call(`${ordersApi}/${crypto.randomUUID()}`, 404, { cookie: doctor });
  assert.deepEqual((await call(`${ordersApi}/${orders.id}`, 200, { cookie: doctor })).json, orders);

  console.log("live-ehr-flow: orders drafted from the catalog, grounded, flagged, idempotent, isolated per clinician");
  // --- The physician decides, line by line; a non-physician cannot --------------------------
  const decisionsApi = (id: string) => `${ordersApi}/${id}/decisions`;
  const decisionBody = (draft: { id: string; version: number }, decisions: object[], key: string, version = draft.version) => ({ draftId: draft.id, expectedVersion: version, idempotencyKey: key, decisions });
  const [cbcLine, amoxicillinLine] = orders.lines;
  const overrideReason = "Fictional: tolerated before; the benefit outweighs the risk.";
  // The clinician who is not a physician has no approving permission, even for their own draft.
  await call(decisionsApi(nurseOrders.id), 403, { cookie: observer, body: decisionBody(nurseOrders, [{ lineId: nurseOrders.lines[0].id, decision: "approve" }], "dec-nurse-" + run) });
  await call(decisionsApi(orders.id), 403, { cookie: observer, body: decisionBody(orders, [{ lineId: cbcLine.id, decision: "approve" }], "dec-nurse-2-" + run) });
  // The command must be the draft's own, well formed, at its version; the allergy needs the flag acknowledged and a reason.
  await call(decisionsApi(orders.id), 400, { cookie: doctor, body: decisionBody(nurseOrders, [{ lineId: cbcLine.id, decision: "approve" }], "dec-path-" + run) });
  await call(decisionsApi(orders.id), 400, { cookie: doctor, body: { ...decisionBody(orders, [{ lineId: cbcLine.id, decision: "approve" }], "dec-extra-" + run), dose: "5 g" } });
  await call(decisionsApi(orders.id), 400, { cookie: doctor, body: decisionBody(orders, [{ lineId: amoxicillinLine.id, decision: "approve" }], "dec-1-" + run) });
  await call(decisionsApi(orders.id), 400, { cookie: doctor, body: decisionBody(orders, [{ lineId: amoxicillinLine.id, decision: "approve", acknowledged: ["allergy"], overrideReason: "ok" }], "dec-2-" + run) });
  await call(decisionsApi(orders.id), 409, { cookie: doctor, body: decisionBody(orders, [{ lineId: cbcLine.id, decision: "approve" }], "dec-stale-" + run, 9) });
  await call(decisionsApi(orders.id), 404, { cookie: doctor, body: decisionBody(orders, [{ lineId: crypto.randomUUID(), decision: "approve" }], "dec-unknown-" + run) });
  assert.ok((await call(`${ordersApi}/${orders.id}`, 200, { cookie: doctor })).json.lines.every((line: { status: string }) => line.status === "pending"), "Refused commands decide nothing");
  const approveBoth = decisionBody(orders, [{ lineId: cbcLine.id, decision: "approve" },
    { lineId: amoxicillinLine.id, decision: "approve", acknowledged: ["allergy"], overrideReason }], "dec-3-" + run);
  const decidedOrders = (await call(decisionsApi(orders.id), 200, { cookie: doctor, body: approveBoth })).json;
  assert.equal(decidedOrders.version, orders.version + 1);
  assert.deepEqual(decidedOrders.lines.map((line: { status: string; decidedBy: string }) => [line.status, line.decidedBy]), [["approved", physician.clinicianId], ["approved", physician.clinicianId]]);
  assert.deepEqual([decidedOrders.lines[1].acknowledged, decidedOrders.lines[1].overrideReason], [["allergy"], overrideReason]);
  assert.equal(decidedOrders.lines[0].acknowledged, undefined);
  // A retry of the same command returns the same draft; a decided order is not decided again; the key is not for another decision.
  assert.deepEqual((await call(decisionsApi(orders.id), 200, { cookie: doctor, body: approveBoth })).json, decidedOrders);
  await call(decisionsApi(orders.id), 409, { cookie: doctor, body: decisionBody(decidedOrders, [{ lineId: cbcLine.id, decision: "reject" }], "dec-4-" + run) });
  await call(decisionsApi(orders.id), 409, { cookie: doctor, body: { ...approveBoth, decisions: [{ lineId: cbcLine.id, decision: "reject" }] } });
  // The proposals of the case are rejected: nothing about them can be written.
  const rejectedAll = (await call(decisionsApi(proposed.id), 200, { cookie: doctor, body: decisionBody(proposed, proposed.lines.map((line: { id: string }) => ({ lineId: line.id, decision: "reject" })), "dec-5-" + run) })).json;
  assert.ok(rejectedAll.lines.every((line: { status: string }) => line.status === "rejected"));
  // The duplicate is approved without an override: only an allergy or a major interaction needs one.
  const duplicate = (await call(decisionsApi(again.id), 200, { cookie: doctor, body: decisionBody(again, [{ lineId: again.lines[0].id, decision: "approve" }], "dec-6-" + run) })).json;
  assert.equal(duplicate.lines[0].status, "approved");
  assert.equal((await call(ordersApi, 200, { cookie: doctor })).json.find((entry: { id: string }) => entry.id === orders.id).approved, 2);
  // The EHR has seen no order: deciding writes nothing.
  assert.equal(ehr.state.fhirRequests.filter((entry) => entry.method !== "GET").length, 0);

  console.log("live-ehr-flow: order decisions: physician only, allergy acknowledged with a reason, retries and final decisions");
  // --- Only reads reached the EHR, all for the launched patient ----------------------------
  assert.ok(ehr.state.fhirRequests.length > 0);
  assert.ok(ehr.state.fhirRequests.every((entry) => entry.method === "GET"));

  // === Scribe: consent -> parts -> sourced note -> physician approval -> FHIR creates ===========
  const scribe = "/api/scribe/sessions";
  const capabilities = (await call("/api/scribe", 200, { cookie: doctor })).json;
  assert.deepEqual({ enabled: capabilities.enabled, live: capabilities.liveTranscription, canApprove: capabilities.canApprove }, { enabled: true, live: true, canApprove: true });
  assert.equal((await call("/api/scribe", 200, { cookie: observer })).json.canApprove, false);
  const visit = crypto.randomUUID();
  // No recording without the clinician's statement that the patient agreed.
  await call(scribe, 400, { cookie: doctor, body: { idempotencyKey: visit } });
  await call(scribe, 400, { cookie: doctor, body: { patientConsentConfirmed: false, idempotencyKey: visit } });
  await call(`${scribe}/${visit}`, 404, { cookie: doctor });
  const started = (await call(scribe, 201, { cookie: doctor, body: { patientConsentConfirmed: true, idempotencyKey: visit } })).json;
  assert.equal(started.status, "recording");
  assert.ok(Date.parse(started.consentConfirmedAt) > Date.now() - 60_000);
  const part = (index: number, bytes = 6000, type = "audio/webm;codecs=opus") => fetch(`${base}${scribe}/${visit}/chunks?index=${index}&durationMs=25000`,
    { method: "POST", headers: { cookie: doctor, "content-type": type }, body: new Uint8Array(bytes) });
  for (const index of [0, 1, 2, 3]) assert.deepEqual(await (await part(index)).json(), { index, added: true, sentences: index === 0 || index === 3 ? 2 : 2 }, `part ${index}`);
  // A repeated part is acknowledged and not transcribed twice into the transcript.
  assert.equal((await (await part(2)).json()).added, false);
  assert.equal((await part(4, 2_100_000)).status, 400, "An oversize part is refused");
  assert.equal((await part(4, 6000, "application/json")).status, 400, "Only audio is accepted");
  assert.equal((await fetch(`${base}${scribe}/${visit}/chunks?index=4&durationMs=25000`, { method: "POST", headers: { "content-type": "audio/webm" }, body: new Uint8Array(6000) })).status, 401);
  // The speech provider received audio, the language and chart terms as hints, never who the patient is.
  assert.ok(ehr.state.transcriptionRequests.length >= 4);
  const heard = ehr.state.transcriptionRequests[0];
  assert.deepEqual({ model: heard.model, language: heard.language, bytes: heard.bytes }, { model: "fictional-transcribe-1", language: "ar", bytes: 6000 });
  assert.ok(heard.prompt.includes("Metformin") && heard.prompt.includes("Penicillin"));
  for (const secret of ["Faisal", "Fictional-Example", "fic-pt-1", "1970"]) assert.equal(heard.prompt.includes(secret), false);

  // Another clinician cannot see or approve this visit.
  await call(`${scribe}/${visit}`, 404, { cookie: observer });
  const drafted = (await call(`${scribe}/${visit}/note`, 200, { cookie: doctor, method: "POST", body: {} })).json;
  assert.equal(drafted.status, "note_ready");
  assert.equal(drafted.segments.length, 8);
  assert.equal(drafted.note.provenance.dataClassification, "live");
  assert.ok(drafted.note.sections.subjective.every((statement: { sources: { kind: string; quote: string }[] }) => statement.sources[0].kind === "transcript" && statement.sources[0].quote));
  const proposals = Object.fromEntries(drafted.note.proposedUpdates.map((update: { name: string; relation: string; id: string }) => [update.name, update]));
  assert.equal(proposals.Sulfa.relation, "new");
  // Metformin is already an order in the chart: it is recognised as documented and cannot be written again.
  assert.equal(proposals.Metformin.relation, "already_in_chart");
  const scribeModel = ehr.state.modelRequests.filter((entry) => entry.task === "scribe_soap_note");
  assert.equal(scribeModel.length, 1, "One model call per visit");
  for (const secret of ["Faisal", "Fictional-Example", "1970-01-01", "fic-pt-1", "fic-enc-1", "alg-penicillin", "Practitioner"]) assert.equal(scribeModel[0].body.includes(secret), false, `The note model must not see ${secret}`);
  // What was said aloud is de-identified before the note model (brief T4): the patient's spoken name, another doctor's name and a spoken phone number.
  const sentToNoteModel = JSON.parse(JSON.parse(scribeModel[0].body).input[0].content).transcript.segments.map((segment: { text: string }) => segment.text).join("\n");
  for (const spoken of ["فيصل", "سلمان", "الحربي", "0550007788"]) assert.equal(sentToNoteModel.includes(spoken), false, `The note model must not see ${spoken}`);
  assert.ok(sentToNoteModel.includes("PHONE-A") && sentToNoteModel.includes("sulfa") && sentToNoteModel.includes("خمسمية ملي مرتين في اليوم"), "Identifiers are replaced, clinical content is not");
  assert.ok(JSON.parse(scribeModel[0].body).instructions.includes("stand-ins"));
  // The physician reads the real words again, in the transcript and in the note drafted from the model's answer.
  const noteText = JSON.stringify(drafted.note.sections);
  for (const spoken of ["فيصل", "سلمان الحربي", "0550007788"]) assert.ok(noteText.includes(spoken) && JSON.stringify(drafted.segments).includes(spoken), `The physician sees ${spoken}`);
  assert.equal(drafted.note.rejectedStatements, 0, "Every statement still matches the words of the visit after mapping back");
  assert.equal(ehr.state.created.length, 0, "Nothing is written before the physician approves");

  // Approval: refused for an item that is already in the chart; nothing recorded, nothing written.
  const approve = (selection: object, cookie = doctor, version = drafted.noteVersion) => fetch(`${base}${scribe}/${visit}/approval`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: version, selection }) });
  assert.equal((await approve({ note: true, updates: [proposals.Metformin.id] })).status, 403);
  assert.equal((await approve({ note: true, updates: [proposals.Sulfa.id] }, doctor, drafted.noteVersion + 1)).status, 409);
  assert.equal(ehr.state.created.length, 0);
  const approvedVisit = await (await approve({ note: true, updates: [proposals.Sulfa.id], confirmedAllergies: [] })).json();
  assert.equal(approvedVisit.status, "written");
  assert.deepEqual(approvedVisit.writes.map((write: { resourceType: string; status: string }) => [write.resourceType, write.status]), [["DocumentReference", "created"], ["AllergyIntolerance", "created"]]);
  // The note is in the chart, so the transcript is gone. The audio was never stored.
  assert.equal(approvedVisit.transcriptDeleted, true);
  assert.equal(approvedVisit.segments.length, 0);

  // What reached the EHR: exactly two conditional creates, for the launched patient and visit, by the clinician.
  assert.equal(ehr.state.created.length, 2);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [document, allergy] = ehr.state.created as Array<Record<string, any>>;
  assert.equal(document.resourceType, "DocumentReference");
  assert.equal(document.docStatus, "preliminary");
  assert.deepEqual([document.subject.reference, document.context.encounter[0].reference, document.author[0].reference], ["Patient/fic-pt-1", "Encounter/fic-enc-1", physician.fhirUser]);
  assert.ok(Buffer.from(document.content[0].attachment.data, "base64").toString("utf8").startsWith("Subjective:"));
  assert.equal(allergy.resourceType, "AllergyIntolerance");
  assert.deepEqual([allergy.code.text, allergy.patient.reference, allergy.verificationStatus.coding[0].code], ["Sulfa", "Patient/fic-pt-1", "unconfirmed"]);
  const writes = ehr.state.fhirRequests.filter((entry) => entry.method !== "GET");
  assert.equal(writes.length, 2);
  assert.ok(writes.every((entry) => entry.method === "POST" && entry.ifNoneExist?.startsWith("identifier=")), "Create only, always conditional");
  // Approving again resumes and creates nothing more; a different selection is refused.
  assert.equal((await approve({ note: true, updates: [proposals.Sulfa.id], confirmedAllergies: [] })).status, 200);
  assert.equal((await approve({ note: false, updates: [proposals.Sulfa.id] })).status, 409);
  assert.equal(ehr.state.created.length, 2);
  assert.equal(ehr.state.fhirRequests.filter((entry) => !["GET", "POST"].includes(entry.method)).length, 0, "No update or delete was ever issued");

  // === A real specialist on the other side: send -> inbox -> reply -> physician -> chart ========
  // Destinations come from the tenant's directory and allowlist; the simulated specialist does not exist here.
  const freshDraft = (await call(drafts, 201, { cookie: doctor, body: { ...chart, request, idempotencyKey: "live-route-" + run } })).json;
  const offered = (await call(`${drafts}/${freshDraft.id}/providers`, 200, { cookie: doctor })).json;
  assert.deepEqual(offered.map((provider: { id: string; transport: string; synthetic: boolean }) => [provider.id, provider.transport, provider.synthetic]), [["fictional-cardiology-service", "portal", false]]);
  await call(`${drafts}/${freshDraft.id}/approval`, 403, { cookie: doctor, body: { ...approval(freshDraft.id, freshDraft.version, "live-neuro-" + run), recipientId: "fictional-neurology-service" } });
  // Nothing can be sent before approval, or by a non-physician.
  const send = (version: number, key: string) => ({ providerId: "fictional-cardiology-service", expectedVersion: version, idempotencyKey: key });
  await call(`${drafts}/${freshDraft.id}/delivery`, 409, { cookie: doctor, body: send(freshDraft.version, "live-early-" + run) });
  const sent = (await call(`${drafts}/${draft.id}/delivery`, 200, { cookie: doctor, body: send(approved.version, "live-send-" + run) })).json;
  assert.deepEqual([sent.status, sent.provider.transport, "canSimulate" in sent], ["sent", "portal", false]);
  // The same command again reports the same single request.
  assert.equal((await call(`${drafts}/${draft.id}/delivery`, 200, { cookie: doctor, body: send(approved.version, "live-send-" + run) })).json.attempts.length, 1);
  await call(`${drafts}/${draft.id}/delivery/simulate`, 404, { cookie: doctor, body: {} });

  // The specialist opens the inbox from the EHR, outside any chart. The session is not a chart session.
  const consultant = (await smartLaunch(cardiologist.subject, 303, {}));
  assert.equal(consultant.response.headers.get("location"), "/inbox");
  const inboxCookie = consultant.cookie!;
  await call("/api/auth/session", 401, { cookie: inboxCookie });
  await call("/api/patients/fic-pt-1/context", 401, { cookie: inboxCookie });
  await call(drafts, 401, { cookie: inboxCookie });
  await call(ordersApi, 401, { cookie: inboxCookie });
  await call("/api/specialist/requests", 401, { cookie: doctor });
  assert.equal((await call("/api/specialist/session", 200, { cookie: inboxCookie })).json.service, "Fictional Cardiology Service");
  const inbox = (await call("/api/specialist/requests", 200, { cookie: inboxCookie })).json;
  assert.equal(inbox.length, 1);
  const requestId = inbox[0].requestId;
  assert.equal(requestId, sent.attempts[0].requestId);
  const received = await call(`/api/specialist/requests/${requestId}`, 200, { cookie: inboxCookie });
  assert.ok(received.json.summary.includes("Age: ") && received.json.summary.includes("Penicillin"));
  // What the specialist can see holds no name, birth date, chart identifier or EHR record reference.
  const visible = JSON.stringify([inbox, received.json]);
  for (const secret of ["Faisal", "Fictional-Example", "1970-01-01", "fic-pt-1", "fic-enc-1", "Condition/", "Observation/", "MedicationRequest/", "AllergyIntolerance/", "cond-htn", physician.clinicianId]) {
    assert.equal(visible.includes(secret), false, `The specialist must not see ${secret}`);
  }
  // Another service's specialist sees nothing of it, and an unregistered EHR user gets no inbox.
  const otherInbox = (await smartLaunch(radiologist.subject, 303, {})).cookie!;
  assert.deepEqual((await call("/api/specialist/requests", 200, { cookie: otherInbox })).json, []);
  await call(`/api/specialist/requests/${requestId}`, 404, { cookie: otherInbox });
  const reply = (body: object, cookie = inboxCookie) => fetch(`${base}/api/specialist/requests/${requestId}/response`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await reply({ kind: "accepted", idempotencyKey: crypto.randomUUID() }, otherInbox)).status, 404);
  assert.equal((await smartLaunch("fic-sub-unmapped", 403, {})).cookie, undefined);

  // Accept, then report, through the same callback contract and state machine as any provider.
  assert.equal((await reply({ kind: "rejected", idempotencyKey: crypto.randomUUID() })).status, 400, "A decline needs a reason");
  const acceptKey = crypto.randomUUID();
  const accepted = await (await reply({ kind: "accepted", idempotencyKey: acceptKey })).json();
  assert.deepEqual([accepted.status, accepted.canReport, accepted.canAccept], ["accepted", true, false]);
  assert.equal((await reply({ kind: "accepted", idempotencyKey: acceptKey })).status, 200, "A repeated reply is recorded once");
  assert.equal((await call(`${drafts}/${draft.id}/delivery`, 200, { cookie: doctor })).json.status, "accepted");
  const reported = await (await reply({ kind: "report", summary: "Fictional reply: exertional chest pain with risk factors. Stress testing is reasonable.", recommendations: ["Fictional recommendation: exercise ECG"], idempotencyKey: crypto.randomUUID() })).json();
  assert.deepEqual([reported.status, reported.canReport, reported.canDecline], ["responded", false, false]);
  assert.equal(reported.responses.at(-1).report.responder, cardiologist.displayName);
  assert.equal((await reply({ kind: "report", summary: "A second, different reply.", recommendations: [], idempotencyKey: crypto.randomUUID() })).status, 409, "A sent reply cannot be replaced");

  // The physician sees the reply and writes the request and the reply to the chart.
  const delivered = (await call(`${drafts}/${draft.id}/delivery`, 200, { cookie: doctor })).json;
  assert.equal(delivered.status, "responded");
  assert.deepEqual([delivered.report.report.responder, delivered.report.report.recommendations], [cardiologist.displayName, ["Fictional recommendation: exercise ECG"]]);
  const beforeChart = ehr.state.created.length;
  // Another clinician cannot reach this consultation at all.
  await call(`${drafts}/${draft.id}/chart`, 404, { cookie: observer, body: { items: ["consultation"] } });
  const charted = (await call(`${drafts}/${draft.id}/chart`, 200, { cookie: doctor, body: { items: ["consultation", "report"] } })).json;
  assert.deepEqual(charted.map((entry: { item: string; status: string }) => [entry.item, entry.status]), [["consultation", "created"], ["report", "created"]]);
  assert.equal(ehr.state.created.length, beforeChart + 2);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [requestNote, replyNote] = ehr.state.created.slice(-2) as Array<Record<string, any>>;
  assert.deepEqual([requestNote.resourceType, requestNote.type.coding[0].code, replyNote.type.coding[0].code], ["DocumentReference", "57133-1", "11488-4"]);
  assert.ok(Buffer.from(replyNote.content[0].attachment.data, "base64").toString("utf8").includes("Reply from Dr Fictional Cardiologist"));
  assert.equal(Buffer.from(requestNote.content[0].attachment.data, "base64").toString("utf8").includes("["), false, "Citation markers are not written to the chart");
  // Again: nothing more is created.
  await call(`${drafts}/${draft.id}/chart`, 200, { cookie: doctor, body: { items: ["consultation", "report"] } });
  assert.equal(ehr.state.created.length, beforeChart + 2);
  // The reply of a request that was never answered cannot be written.
  assert.deepEqual((await call(`${drafts}/${freshDraft.id}/chart`, 200, { cookie: doctor })).json, []);

  // === Approved orders written to the chart: only what the physician approved, once each ===========
  const chartApi = (id: string) => `${ordersApi}/${id}/chart`;
  const orderResources = () => ehr.state.created.filter((entry) => ["ServiceRequest", "MedicationRequest"].includes(entry.resourceType));
  assert.equal(orderResources().length, 0, "Nothing was written before the physician asked");
  const waiting = (await call(chartApi(orders.id), 200, { cookie: doctor })).json;
  assert.deepEqual(waiting.map((entry: { resourceType: string; status: string }) => [entry.resourceType, entry.status]), [["ServiceRequest", "pending"], ["MedicationRequest", "pending"]]);
  assert.ok(waiting.every((entry: { copyText?: string }) => entry.copyText), "The text to enter is offered");
  assert.equal(orderResources().length, 0, "Reading the list writes nothing");
  // Writing is the physician's; a clinician who is not one cannot, and cannot reach the physician's draft either.
  await call(chartApi(orders.id), 403, { cookie: observer, method: "POST" });
  await call(chartApi(orders.id), 404, { cookie: observer });
  // An EHR that takes neither (as OpenEMR 7.0.3): the orders come back as text, and nothing is sent.
  ehr.state.noCreate = new Set(["ServiceRequest", "MedicationRequest"]);
  const unsupported = (await call(chartApi(orders.id), 200, { cookie: doctor, method: "POST" })).json;
  assert.deepEqual(unsupported.map((entry: { status: string }) => entry.status), ["unsupported", "unsupported"]);
  assert.ok(unsupported.every((entry: { failure: string; copyText: string }) => entry.failure.includes("does not accept") && entry.copyText));
  assert.match(unsupported[1].copyText, /^Medication: Amoxicillin, 500 mg, oral, every 8 hours, 7 days/);
  assert.equal(orderResources().length, 0);
  assert.equal(ehr.state.fhirRequests.filter((entry) => entry.method === "POST" && /ServiceRequest|MedicationRequest/.test(entry.path)).length, 0, "No order was sent to an EHR that does not take it");
  // An EHR that takes them: each approved order is created once, as a draft for the physician to sign there.
  ehr.state.noCreate = new Set();
  const written = (await call(chartApi(orders.id), 200, { cookie: doctor, method: "POST" })).json;
  assert.deepEqual(written.map((entry: { resourceType: string; status: string }) => [entry.resourceType, entry.status]), [["ServiceRequest", "created"], ["MedicationRequest", "created"]]);
  assert.ok(written.every((entry: { copyText?: string; resourceId: string }) => entry.copyText === undefined && entry.resourceId.startsWith("fic-created-")));
  assert.equal(orderResources().length, 2);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [serviceRequest, medicationRequest] = orderResources() as Array<Record<string, any>>;
  assert.deepEqual([serviceRequest.status, serviceRequest.intent, serviceRequest.category[0].text, serviceRequest.code.coding[0], serviceRequest.code.text],
    ["draft", "order", "lab", { system: "urn:test", code: "CBC-1" }, "Complete blood count"]);
  assert.deepEqual([serviceRequest.subject.reference, serviceRequest.encounter.reference, serviceRequest.requester.reference], ["Patient/fic-pt-1", "Encounter/fic-enc-1", physician.fhirUser]);
  assert.deepEqual([medicationRequest.status, medicationRequest.intent, medicationRequest.medicationCodeableConcept.text, medicationRequest.dosageInstruction[0].text],
    ["draft", "order", "Amoxicillin", "500 mg, oral, every 8 hours, 7 days"]);
  assert.match(medicationRequest.note[0].text, new RegExp(`Acknowledged: allergy\\. Reason: ${overrideReason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.equal(serviceRequest.identifier[0].value, written[0].itemKey);
  const orderWrites = ehr.state.fhirRequests.filter((entry) => entry.method === "POST" && /ServiceRequest|MedicationRequest/.test(entry.path));
  assert.ok(orderWrites.length === 2 && orderWrites.every((entry) => entry.ifNoneExist?.startsWith("identifier=")), "Create only, always conditional");
  // Again: nothing more is created. The rejected proposals and the order nobody asked to write are never written.
  assert.deepEqual((await call(chartApi(orders.id), 200, { cookie: doctor, method: "POST" })).json.map((entry: { status: string }) => entry.status), ["created", "created"]);
  assert.equal(orderResources().length, 2);
  assert.deepEqual((await call(chartApi(proposed.id), 200, { cookie: doctor, method: "POST" })).json, []);
  assert.equal(orderResources().length, 2);
  assert.equal((await call(chartApi(again.id), 200, { cookie: doctor })).json[0].status, "pending", "Approved is not written until the physician writes");
  assert.equal(orderResources().length, 2);
  await call(chartApi("not-a-draft"), 400, { cookie: doctor });
  assert.equal(ehr.state.fhirRequests.filter((entry) => !["GET", "POST"].includes(entry.method)).length, 0, "No update or delete was ever issued");

  console.log("live-ehr-flow: approved orders written once as draft ServiceRequest and MedicationRequest; offered as text where the EHR takes no write");
  // --- The simulator route is gone; sessions and stored work survive a new server process ---
  await call(`${drafts}/${draft.id}/delivery/simulate`, 404, { cookie: doctor, body: {} });
  const beforeRestart = { draft: (await call(`${drafts}/${draft.id}`, 200, { cookie: doctor })).json, delivery: (await call(`${drafts}/${draft.id}/delivery`, 200, { cookie: doctor })).json };
  assert.equal("canSimulate" in beforeRestart.delivery, false);
  await stop();
  assert.equal(await start(), true);
  assert.equal((await call("/api/auth/session", 200, { cookie: doctor })).json.clinicianId, physician.clinicianId);
  assert.deepEqual((await call(`${drafts}/${draft.id}`, 200, { cookie: doctor })).json, beforeRestart.draft);
  assert.deepEqual((await call(`${drafts}/${draft.id}/delivery`, 200, { cookie: doctor })).json, beforeRestart.delivery);
  await call(`${drafts}/${draft.id}`, 404, { cookie: observer });
  assert.deepEqual((await call(`${ordersApi}/${orders.id}`, 200, { cookie: doctor })).json, decidedOrders, "Order drafts and the decisions on them survive a new server process");
  assert.deepEqual((await call(chartApi(orders.id), 200, { cookie: doctor })).json.map((entry: { status: string }) => entry.status), ["created", "created"], "So does what was written");
  // Without the hospital's catalog order drafting is not offered, and nothing else changes.
  await stop();
  assert.equal(await start({ ORDER_CATALOG_FILE: "" }), true);
  await call(ordersApi, 501, { cookie: doctor });
  await call(ordersApi, 501, { cookie: doctor, body: { request: "Prepare a CBC", idempotencyKey: "orders-off-" + run } });
  await call(`${ordersApi}/${orders.id}`, 501, { cookie: doctor });
  assert.equal((await call("/api/auth/session", 200, { cookie: doctor })).json.clinicianId, physician.clinicianId);
  await stop();
  assert.equal(await start(), true);

  // --- Optional: the same sessions in a real browser (LIVE_E2E_BROWSER=1; needs Playwright with Chromium) ---
  if (process.env.LIVE_E2E_BROWSER === "1") {
    const { createRequire } = await import("node:module");
    const { chromium } = createRequire(import.meta.url)("playwright") as typeof import("playwright");
    const browser = await chromium.launch();
    try {
      const open = async (cookie: string, path: string) => {
        const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 420, height: 900 } });
        const [name, value] = cookie.split("=");
        await context.addCookies([{ name, value, domain: "localhost", path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
        const page = await context.newPage();
        await page.goto(base + path);
        return page;
      };
      const shots = process.env.BROWSER_SCREENSHOT_DIR;
      const inboxPage = await open(inboxCookie, "/inbox");
      await inboxPage.getByRole("heading", { name: "Consultation inbox" }).waitFor();
      await inboxPage.getByText("Fictional Cardiology Service").first().waitFor();
      if (shots) await inboxPage.screenshot({ path: `${shots}/inbox-list.png`, fullPage: true });
      await inboxPage.getByRole("button", { name: /Cardiology.*Replied/s }).click();
      await inboxPage.getByRole("heading", { name: "Cardiology consultation request" }).waitFor();
      await inboxPage.getByRole("region", { name: "Your reply" }).getByText("Stress testing is reasonable").waitFor();
      assert.equal(await inboxPage.getByText("Faisal").count(), 0, "No patient name in the inbox");
      if (shots) await inboxPage.screenshot({ path: `${shots}/inbox-request.png`, fullPage: true });
      const chartPage = await open(doctor, "/embed");
      await chartPage.getByRole("heading", { name: "Faisal Fictional-Example" }).waitFor();
      await chartPage.getByText("Real patient data").first().waitFor();
      await chartPage.getByRole("tab", { name: "History" }).click();
      await chartPage.getByRole("region", { name: "Recorded visits" }).getByText("In the chart").waitFor();
      await chartPage.getByRole("button", { name: /Cardiology.*Specialist responded/s }).click();
      await chartPage.getByRole("article", { name: "Specialist response" }).getByText("Dr Fictional Cardiologist").waitFor();
      await chartPage.getByRole("group", { name: "Patient chart" }).getByText("In the chart").first().waitFor();
      assert.equal(await chartPage.getByRole("button", { name: /Simulate/ }).count(), 0, "No simulation controls with real patient data");
      if (shots) await chartPage.screenshot({ path: `${shots}/live-consultation.png`, fullPage: true });
      // A clinician's chart session does not open the inbox.
      const refused = await open(doctor, "/inbox");
      await refused.getByText("Open the inbox from your EHR").waitFor();
      console.log("live-ehr-flow: browser step passed (specialist inbox, live workspace, history, chart status)");
    } finally { await browser.close(); }
  }

  // --- A visit the product cannot use is refused with its reason ---------------------------
  ehr.state.fhirOverride = (path) => path.startsWith("/Encounter/") ? { resourceType: "Encounter", id: "fic-enc-1", status: "entered-in-error", subject: { reference: "Patient/fic-pt-1" }, class: { code: "AMB" }, period: { start: new Date().toISOString() } } : undefined;
  const refused = await smartLaunch(physician.subject, 422);
  assert.equal(refused.body.error.code, "unsupported_encounter");
  assert.match(refused.body.error.message, /entered-in-error/);
  ehr.state.fhirOverride = (path) => path.startsWith("/Encounter/") ? { resourceType: "Encounter", id: "fic-enc-1", status: "triaged", subject: { reference: "Patient/fic-pt-1" }, class: { code: "EMER" }, period: { start: new Date().toISOString() } } : undefined;
  const emergency = (await smartLaunch(physician.subject)).cookie!;
  assert.equal((await call("/api/encounters/fic-enc-1", 200, { cookie: emergency })).json.status, "triaged");
  ehr.state.fhirOverride = undefined;

  console.log("live-ehr-flow: passed (fake SMART issuer, fake FHIR server with conditional create, fake transcription, fake model, PostgreSQL): launch, facts, cited draft, approval, scribe consent, note, physician-approved chart writes, specialist inbox and reply, reply written to the chart, orders drafted, decided and written");
} finally {
  await stop();
  proxy.close();
  await ehr.close();
}
process.exit(0);
