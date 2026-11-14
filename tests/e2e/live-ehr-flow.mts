import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout } from "node:timers/promises";
import { startFakeEhr } from "./fakes/ehr.mts";
import { ensureTrustedLocalhost, startTlsProxy } from "./fakes/tls.mts";

// LIVE code path, black box, with FAKE servers and FICTIONAL data:
//   production build in CLINICAL_DATA_MODE=live  +  fake SMART/OIDC issuer (real signed ID tokens)
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
const nurse = { subject: "fic-sub-nurse", fhirUser: "Practitioner/fic-rn-1", clinicianId: "66666666-6666-4666-8666-666666666662" };
const scope = "launch openid fhirUser patient/Patient.rs patient/Encounter.rs patient/Condition.rs patient/MedicationRequest.rs patient/AllergyIntolerance.rs patient/Observation.rs";
process.env.SMART_SCOPE = scope;

const ehr = await startFakeEhr({
  port: ehrPort, tls, clientId, redirectUri: `${base}/api/smart/callback`, modelKey,
  users: { [physician.subject]: { fhirUser: physician.fhirUser }, [nurse.subject]: { fhirUser: nurse.fhirUser }, "fic-sub-unmapped": { fhirUser: "Practitioner/fic-unknown" } },
});
const proxy = await startTlsProxy(tls, httpsPort, appPort);
let app: ChildProcess | undefined;

const liveEnv: Record<string, string> = {
  NODE_ENV: "production", TENANT_ID: "ci-live-hospital", CLINICAL_DATA_MODE: "live", AUTH_MODE: "smart", CLINICAL_DATA_SOURCE: "fhir",
  FHIR_BASE_URL: ehr.fhirBase, SMART_CLIENT_ID: clientId, SMART_AUTHORIZATION_URL: `${ehr.oidcIssuer}/authorize`, SMART_TOKEN_URL: `${ehr.oidcIssuer}/token`,
  SMART_REDIRECT_URI: `${base}/api/smart/callback`, SMART_OIDC_ISSUER: ehr.oidcIssuer, SMART_JWKS_URL: `${ehr.oidcIssuer}/jwks`, SMART_SCOPE: scope,
  SMART_CLINICIAN_MAP: JSON.stringify([{ ...physician, role: "physician" }, { ...nurse, role: "clinician" }]),
  AI_PROVIDER: "openai", OPENAI_API_KEY: modelKey, OPENAI_BASE_URL: ehr.modelBase, OPENAI_MODEL: "fictional-model-1",
  OPENAI_INPUT_USD_PER_MILLION: "1", OPENAI_OUTPUT_USD_PER_MILLION: "1", MODEL_LIVE_DATA_APPROVED: "true",
  MOCK_RECIPIENT_IDS: "fictional-cardiology-service",
};

async function start(extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, ...liveEnv, ...extra };
  // Synthetic launch paths do not exist in live mode; the server refuses to start with them configured.
  for (const key of ["STAGING_LAUNCH_SECRET", "VERCEL_ENV", "VERCEL_TARGET_ENV", "STAGING_SESSION_SECONDS", "MOCK_PROVIDER_SECRET"]) delete env[key];
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
async function smartLaunch(subject: string, expectedCallback = 303) {
  ehr.state.currentUser = subject;
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
  // --- Live mode refuses an incomplete configuration --------------------------------------
  assert.equal(await start({ MODEL_LIVE_DATA_APPROVED: "false" }), false, "Live mode must not start without model approval for live data");
  await stop();
  assert.equal(await start(), true);

  // --- No session without the EHR launch; no synthetic launch in live mode -----------------
  await call("/api/auth/session", 401);
  await call("/api/staging/launch", 404, { body: { profile: "physician" } });
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

  // --- Only reads reached the EHR, all for the launched patient ----------------------------
  assert.ok(ehr.state.fhirRequests.length > 0);
  assert.ok(ehr.state.fhirRequests.every((entry) => entry.method === "GET"));

  // --- A visit the product cannot use is refused with its reason ---------------------------
  ehr.state.fhirOverride = (path) => path.startsWith("/Encounter/") ? { resourceType: "Encounter", id: "fic-enc-1", status: "entered-in-error", subject: { reference: "Patient/fic-pt-1" }, class: { code: "AMB" }, period: { start: new Date().toISOString() } } : undefined;
  const refused = await smartLaunch(physician.subject, 422);
  assert.equal(refused.body.error.code, "unsupported_encounter");
  assert.match(refused.body.error.message, /entered-in-error/);
  ehr.state.fhirOverride = (path) => path.startsWith("/Encounter/") ? { resourceType: "Encounter", id: "fic-enc-1", status: "triaged", subject: { reference: "Patient/fic-pt-1" }, class: { code: "EMER" }, period: { start: new Date().toISOString() } } : undefined;
  const emergency = (await smartLaunch(physician.subject)).cookie!;
  assert.equal((await call("/api/encounters/fic-enc-1", 200, { cookie: emergency })).json.status, "triaged");
  ehr.state.fhirOverride = undefined;

  console.log("live-ehr-flow: passed (fake SMART issuer, fake FHIR server, fake model, PostgreSQL)");
} finally {
  await stop();
  proxy.close();
  await ehr.close();
}
process.exit(0);
