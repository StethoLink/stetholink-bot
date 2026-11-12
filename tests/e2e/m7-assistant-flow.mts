import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout } from "node:timers/promises";

// Consultation assistant over HTTP with durable storage: natural-language request -> authored
// draft -> natural-language revision through the lifecycle -> approval -> routing, across a restart.
// Runs with the deterministic mock (AI_PROVIDER=mock): it verifies the workflow and its
// boundaries, not model quality. Owns only a loopback app and synthetic rows in a disposable database.
assert.ok(["localhost", "127.0.0.1"].includes(new URL(process.env.STETHOLINK_DATABASE_URL ?? "").hostname), "Use a disposable loopback database");
assert.equal(process.env.AUTH_MODE, "staging");
const secret = process.env.STAGING_LAUNCH_SECRET;
assert.ok(secret && secret.length >= 32);
const port = process.env.M7_TEST_APP_PORT ?? "3078";
const base = "http://127.0.0.1:" + port;
let app: ChildProcess | undefined;

async function start() {
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "apps/embedded-app", "--hostname", "127.0.0.1", "--port", port],
    { env: { ...process.env, NODE_ENV: "production", STAGING_SESSION_SECONDS: "900" }, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 100; i++) {
    assert.equal(app.exitCode, null, "Server exited during startup");
    if (await fetch(base + "/api/health").then((r) => r.ok).catch(() => false)) return;
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
async function call(path: string, expected: number, opts: { cookie?: string; body?: object; headers?: Record<string, string> } = {}) {
  const response = await fetch(base + path, { method: opts.body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await response.text();
  assert.equal(response.status, expected, `${path} -> ${text.slice(0, 300)}`);
  return { response, json: text ? JSON.parse(text) : null };
}
async function launch(profile: string) {
  const { response } = await call("/api/staging/launch", 200, { body: { profile }, headers: { authorization: "Bearer " + secret } });
  const cookie = response.headers.getSetCookie().find((h) => h.startsWith("stetholink-session="));
  assert.ok(cookie);
  return cookie.split(";")[0];
}

const drafts = "/api/consultations/drafts";
const run = crypto.randomUUID();
const chart = { patientId: "syn-pt-omar", encounterId: "syn-enc-omar" };
const request = "Prepare a cardiology consultation for this patient regarding possible acute coronary syndrome.";

try {
  await start();
  const physician = await launch("chest-pain-demo");
  const observer = await launch("observer");

  // --- Request validation and chart binding ------------------------------------------------
  await call(drafts, 401, { body: { ...chart, request } });
  await call(drafts, 400, { cookie: physician, body: { ...chart, request: "short" } });
  await call(drafts, 400, { cookie: physician, body: { ...chart, request, specialty: "Cardiology", clinicalQuestion: "Both forms" } });
  await call(drafts, 400, { cookie: physician, body: { ...chart, request, status: "approved" } });
  await call(drafts, 403, { cookie: physician, body: { patientId: "syn-pt-001", request } });
  await call(drafts, 400, { cookie: physician, body: { ...chart, request: "Please prepare a consultation for this patient." } });

  // --- Authored draft, stored once ----------------------------------------------------------
  const create = { ...chart, request, idempotencyKey: "m7-" + run };
  const [first, replay] = await Promise.all([call(drafts, 201, { cookie: physician, body: create }), call(drafts, 201, { cookie: physician, body: create })]);
  const draft = first.json;
  assert.deepEqual(replay.json, draft, "A retried request returns the same draft");
  assert.equal(draft.status, "pending_approval");
  assert.equal(draft.version, 1);
  assert.equal(draft.reviewedBy, undefined);
  assert.equal(draft.grounding.specialty, "Cardiology");
  assert.deepEqual(draft.grounding.authoring, { mode: "model_authored", physicianRequest: request, rejectedStatements: 0, liveInference: false, usage: null });
  assert.equal(draft.grounding.provenance.provider, "mock", "This suite runs the labelled deterministic fallback");
  assert.match(draft.summary, /12-lead ECG: Sinus rhythm, rate 94; ST depression of 1 mm in leads V4 to V6; no ST elevation recorded \[omar-ecg\]/);
  assert.match(draft.assessment, /Echocardiogram: not performed \[omar-echo\]/);
  assert.equal(draft.clinicalFacts.length, 21);
  const path = drafts + "/" + draft.id;

  // --- Natural-language revision: validated input, physician only, through the lifecycle ---
  const revise = (body: object, expected: number, cookie = physician) => call(path + "/ai-revision", expected, { cookie, body });
  const command = { instruction: "Make the consultation shorter and focus on the ECG findings.", expectedVersion: 1, idempotencyKey: "m7-rev-" + run };
  await call(path + "/ai-revision", 401, { body: command });
  await revise({ ...command, instruction: "x" }, 400);
  await revise({ ...command, decision: "approve" }, 400);
  await revise({ ...command, expectedVersion: 9 }, 409);
  await revise(command, 404, observer);
  assert.equal((await call(path, 200, { cookie: physician })).json.version, 1, "Refused revisions change nothing");
  const revised = (await revise(command, 200)).json;
  assert.equal(revised.version, 4, "Reopen, revise and resubmit are three recorded lifecycle steps");
  assert.equal(revised.status, "pending_approval");
  assert.equal(revised.reviewedBy, undefined);
  assert.deepEqual(revised.grounding, draft.grounding, "Sources, specialty and question are unchanged");
  assert.deepEqual(revised.clinicalFacts, draft.clinicalFacts);
  const history = (await call(path + "/history", 200, { cookie: physician })).json;
  assert.deepEqual(history.events.map((e: { toStatus: string }) => e.toStatus).reverse(), ["pending_review", "draft", "draft", "pending_review"]);
  await revise(command, 409);

  // --- A physician on this chart who is not a reviewer: an observer session drafts only ------
  const observed = (await call(drafts, 201, { cookie: observer, body: { patientId: "syn-pt-001", encounterId: "syn-enc-001", request: "Prepare a cardiology consultation about blood pressure control." } })).json;
  await call(drafts + "/" + observed.id + "/ai-revision", 403, { cookie: observer, body: { ...command, idempotencyKey: "m7-observer-" + run } });
  await call(drafts + "/" + observed.id + "/approval", 403, { cookie: observer, body: { draftId: observed.id, decision: "approve", recipientId: "synthetic-cardiology", expectedVersion: 1, idempotencyKey: "m7-observer-approve" } });

  // --- Approval is explicit, and ends revision ----------------------------------------------
  await call(path + "/delivery", 409, { cookie: physician, body: { providerId: "synthetic-cardiology", expectedVersion: 4, idempotencyKey: "m7-early-" + run } });
  const approved = (await call(path + "/approval", 200, { cookie: physician, body: { draftId: draft.id, decision: "approve", recipientId: "synthetic-cardiology", expectedVersion: 4, idempotencyKey: "m7-approve-" + run } })).json;
  assert.equal(approved.status, "approved");
  await revise({ ...command, expectedVersion: approved.version, idempotencyKey: "m7-late-" + run }, 409);

  // --- Restart: the authored draft and its provenance are durable ----------------------------
  await stop();
  await start();
  assert.deepEqual((await call(path, 200, { cookie: physician })).json, approved);
  const sent = (await call(path + "/delivery", 200, { cookie: physician, body: { providerId: "synthetic-cardiology", expectedVersion: approved.version, idempotencyKey: "m7-send-" + run } })).json;
  assert.equal(sent.status, "sent");
  await call(path + "/delivery/simulate", 200, { cookie: physician, body: {} });
  const done = (await call(path + "/delivery/simulate", 200, { cookie: physician, body: {} })).json;
  assert.equal(done.status, "responded");
  assert.match(done.report.report.responder, /Simulated specialist/);
  const list = (await call(drafts, 200, { cookie: physician })).json;
  assert.deepEqual(list.find((item: { id: string }) => item.id === draft.id), { id: draft.id, status: "responded", specialty: "Cardiology", updatedAt: list.find((item: { id: string }) => item.id === draft.id).updatedAt });
  console.log("Passed assistant flow (deterministic fallback, simulated specialist): request validation, chart binding, single durable draft, lifecycle-recorded revision, physician-only reopening, approval gate, restart, routing and history.");
} finally { await stop(); }
