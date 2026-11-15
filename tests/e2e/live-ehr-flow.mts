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
const cardiologist = { subject: "fic-sub-cardiologist", fhirUser: "Practitioner/fic-card-1", specialistId: "77777777-7777-4777-8777-777777777771", providerId: "fictional-cardiology-service", displayName: "Dr Fictional Cardiologist" };
const radiologist = { subject: "fic-sub-radiologist", fhirUser: "Practitioner/fic-rad-1", specialistId: "77777777-7777-4777-8777-777777777772", providerId: "fictional-radiology-service", displayName: "Dr Fictional Radiologist" };
const nurse = { subject: "fic-sub-nurse", fhirUser: "Practitioner/fic-rn-1", clinicianId: "66666666-6666-4666-8666-666666666662" };
const scope = "launch openid fhirUser patient/Patient.rs patient/Encounter.rs patient/Condition.rs patient/MedicationRequest.rs patient/AllergyIntolerance.rs patient/Observation.rs patient/DocumentReference.c patient/AllergyIntolerance.c patient/Condition.c";
process.env.SMART_SCOPE = scope;

const ehr = await startFakeEhr({
  port: ehrPort, tls, clientId, redirectUri: `${base}/api/smart/callback`, modelKey,
  users: { [physician.subject]: { fhirUser: physician.fhirUser }, [nurse.subject]: { fhirUser: nurse.fhirUser }, "fic-sub-unmapped": { fhirUser: "Practitioner/fic-unknown" },
    [cardiologist.subject]: { fhirUser: cardiologist.fhirUser }, [radiologist.subject]: { fhirUser: radiologist.fhirUser } },
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
  EHR_WRITE_ENABLED: "true", SESSION_ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
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
  assert.deepEqual([sent.status, sent.provider.transport, sent.canSimulate], ["sent", "portal", false]);
  // The same command again reports the same single request.
  assert.equal((await call(`${drafts}/${draft.id}/delivery`, 200, { cookie: doctor, body: send(approved.version, "live-send-" + run) })).json.attempts.length, 1);
  await call(`${drafts}/${draft.id}/delivery/simulate`, 501, { cookie: doctor, body: {} });

  // The specialist opens the inbox from the EHR, outside any chart. The session is not a chart session.
  const consultant = (await smartLaunch(cardiologist.subject, 303, {}));
  assert.equal(consultant.response.headers.get("location"), "/inbox");
  const inboxCookie = consultant.cookie!;
  await call("/api/auth/session", 401, { cookie: inboxCookie });
  await call("/api/patients/fic-pt-1/context", 401, { cookie: inboxCookie });
  await call(drafts, 401, { cookie: inboxCookie });
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

  console.log("live-ehr-flow: passed (fake SMART issuer, fake FHIR server with conditional create, fake transcription, fake model, PostgreSQL): launch, facts, cited draft, approval, scribe consent, note, physician-approved chart writes, specialist inbox and reply, reply written to the chart");
} finally {
  await stop();
  proxy.close();
  await ehr.close();
}
process.exit(0);
