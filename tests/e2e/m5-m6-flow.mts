import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { setTimeout } from "node:timers/promises";
import postgres from "postgres";

// Full synthetic consultation: chart -> grounded draft -> physician approval -> allowlisted
// routing -> mock specialist -> signed callbacks -> clinician readback, across app restarts.
// Owns only a loopback app process and synthetic rows in a disposable database.
const dbUrl = process.env.STETHOLINK_DATABASE_URL ?? "";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(dbUrl).hostname), "Use a disposable loopback database");
assert.equal(process.env.AUTH_MODE, "staging");
assert.equal(process.env.VERCEL_ENV, "preview");
const launchSecret = process.env.STAGING_LAUNCH_SECRET;
assert.ok(launchSecret && launchSecret.length >= 32);
const port = process.env.M5_TEST_APP_PORT ?? "3077";
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
type Options = { cookie?: string; body?: object; method?: string; headers?: Record<string, string>; raw?: string };
async function call(path: string, expected: number, opts: Options = {}) {
  const method = opts.method ?? (opts.body || opts.raw ? "POST" : "GET");
  const response = await fetch(base + path, { method,
    headers: { "content-type": "application/json", ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers },
    body: opts.raw ?? (opts.body ? JSON.stringify(opts.body) : undefined) });
  const text = await response.text();
  assert.equal(response.status, expected, `${method} ${path} -> ${text.slice(0, 300)}`);
  return { response, json: text ? JSON.parse(text) : null };
}
async function launch(profile: string) {
  const { response } = await call("/api/staging/launch", 200, { body: { profile }, headers: { authorization: "Bearer " + launchSecret } });
  const cookie = response.headers.getSetCookie().find((h) => h.startsWith("stetholink-session="));
  assert.ok(cookie);
  return cookie.split(";")[0];
}
// The test plays the external specialist: it holds that provider's callback secret.
const providerSecret = (providerId: string) => createHmac("sha256", process.env.MOCK_PROVIDER_SECRET ?? launchSecret)
  .update("stetholink-provider-callback:" + providerId).digest("hex");
function callback(providerId: string, message: object, options: { secret?: string; timestamp?: number; signAs?: string } = {}) {
  const raw = JSON.stringify(message);
  const timestamp = String(options.timestamp ?? Date.now());
  const signature = createHmac("sha256", options.secret ?? providerSecret(options.signAs ?? providerId)).update(timestamp + "." + raw).digest("hex");
  return { raw, headers: { "x-stetholink-provider": providerId, "x-stetholink-timestamp": timestamp, "x-stetholink-signature": signature } };
}
const message = (requestId: string, providerId: string, kind: string, responseId: string, extra: object = {}) => ({
  contractVersion: "1.0", requestId, providerId, responseId, kind, sentAt: new Date().toISOString(), dataClassification: "synthetic", ...extra });
const report = { summary: "SYNTHETIC SPECIALIST RESPONSE. Test data, not clinical advice.", recommendations: ["Provide the missing ECG."], responder: "Simulated specialist" };

const drafts = "/api/consultations/drafts";
const run = crypto.randomUUID();
const intent = { specialty: "Cardiology", clinicalQuestion: "Please review the documented hypertension and diabetes; investigation results are not provided." };
const owner = process.env.STETHOLINK_TEST_OWNER_URL ? postgres(process.env.STETHOLINK_TEST_OWNER_URL, { max: 1, onnotice: () => undefined }) : undefined;

try {
  await start();
  const physician = await launch("cardiology-demo");
  const chart = { patientId: "syn-pt-ahmed", encounterId: "syn-enc-ahmed" };

  // --- Correct patient context, grounded draft, explicit missing information -------------
  const session = (await call("/api/auth/session", 200, { cookie: physician })).json;
  assert.equal(session.patientId, chart.patientId);
  await call(drafts, 403, { cookie: physician, body: { patientId: "syn-pt-001", ...intent } });
  await call(drafts, 400, { cookie: physician, body: { ...chart, specialty: "Cardiology" } });
  async function prepare(key: string) {
    const draft = (await call(drafts, 201, { cookie: physician, body: { ...chart, ...intent, idempotencyKey: key + "-" + run } })).json;
    return { draft, path: drafts + "/" + draft.id };
  }
  // The physician approves the content for one destination; routing can only go there.
  async function approve(path: string, draft: { id: string; version: number }, recipientId = "synthetic-cardiology", cookie = physician, expected = 200) {
    return (await call(path + "/approval", expected, { cookie, body: { draftId: draft.id, decision: "approve", recipientId, expectedVersion: draft.version, idempotencyKey: "approve-" + draft.id } })).json;
  }
  const send = (path: string, providerId: string, expectedVersion: number, key: string, expected = 200, cookie = physician) =>
    call(path + "/delivery", expected, { cookie, body: { providerId, expectedVersion, idempotencyKey: key + "-" + run } });
  const view = async (path: string, cookie = physician) => (await call(path + "/delivery", 200, { cookie })).json;

  const { draft, path } = await prepare("m5-main");
  assert.equal(draft.patientId, chart.patientId);
  assert.equal(draft.grounding.specialty, "Cardiology");
  assert.equal(draft.grounding.question, intent.clinicalQuestion);
  assert.deepEqual([...draft.grounding.evidenceIds].sort(), ["ahmed-amlodipine", "ahmed-diabetes", "ahmed-hypertension", "ahmed-metformin"]);
  assert.ok(draft.grounding.safetyFlags.includes("missing_investigations"));
  assert.deepEqual(draft.missingInformation.map((m: { label: string }) => m.label).sort(),
    ["Allergy history", "Current blood pressure", "ECG", "HbA1c", "Lipid profile", "Renal function", "Troponin"]);
  assert.ok(draft.missingInformation.every((m: { status: string; value?: unknown }) => m.status === "unknown" && m.value === undefined));
  assert.ok(draft.clinicalFacts.every((f: { source: { reference: string } }) => f.source.reference === "synthetic-case-ahmed-v1"));

  // --- Nothing can be sent before the physician approves ---------------------------------
  assert.deepEqual((await view(path)).attempts, []);
  assert.equal((await view(path)).canSend, false);
  assert.deepEqual((await call(path + "/providers", 200, { cookie: physician })).json.map((p: { id: string }) => p.id).sort(),
    ["synthetic-cardiology", "synthetic-cardiology-declines", "synthetic-cardiology-offline"], "Only allowed, active providers of the specialty are eligible");
  await send(path, "synthetic-cardiology", 1, "premature", 409);
  await call(path + "/delivery/simulate", 409, { cookie: physician, body: {} });
  for (const action of ["queue", "sent", "accepted", "responded"]) {
    await call(path + "/transitions", 400, { cookie: physician, body: { action, expectedVersion: 1, idempotencyKey: "forge-" + action + run } });
  }
  // An observer (non-physician) on the same chart identity class can neither approve nor send.
  const observer = await launch("observer");
  await approve(path, draft, "synthetic-cardiology", observer, 403);
  await send(path, "synthetic-cardiology", 1, "observer-send", 403, observer);
  await approve(path, draft, "synthetic-cardiology-suspended", physician, 403);
  await approve(path, draft, "not-a-provider", physician, 403);
  const approved = await approve(path, draft);
  assert.equal(approved.lifecycleStatus, "approved");
  assert.equal(approved.approvedRecipientId, "synthetic-cardiology");
  assert.equal((await view(path)).provider.id, "synthetic-cardiology", "The approved destination is shown before sending");
  assert.equal(approved.reviewedBy, session.clinicianId);

  // --- Provider eligibility, allowlist and scope -----------------------------------------
  await send(path, "synthetic-radiology", 2, "wrong-specialty", 403);
  await send(path, "synthetic-cardiology-suspended", 2, "suspended", 403);
  await send(path, "not-a-provider", 2, "unknown", 403);
  await send(path, "synthetic-cardiology-offline", 2, "not-the-approved-destination", 403);
  await send(path, "synthetic-cardiology", 1, "stale-version", 409);
  await call(path + "/delivery", 401, { body: { providerId: "synthetic-cardiology", expectedVersion: 2, idempotencyKey: "anonymous" } });
  // "physician" is the same clinician on a different chart (syn-pt-001).
  for (const profile of ["other-clinician", "physician"]) {
    const other = await launch(profile);
    await send(path, "synthetic-cardiology", 2, "foreign-" + profile, 404, other);
    await call(path + "/delivery", 404, { cookie: other });
    await call(path + "/providers", 404, { cookie: other });
    await call(path + "/delivery/simulate", 404, { cookie: other, body: {} });
    assert.deepEqual((await call(drafts, 200, { cookie: other })).json.filter((d: { id: string }) => d.id === draft.id), []);
  }
  assert.deepEqual((await view(path)).attempts, [], "Refused routing attempts leave no delivery record");
  assert.equal((await view(path)).canSend, true);

  // --- Exactly one durable request, even for concurrent and repeated commands ------------
  const sends = await Promise.all([send(path, "synthetic-cardiology", 2, "send-1"), send(path, "synthetic-cardiology", 2, "send-1")]);
  const sent = sends[0].json;
  await send(path, "synthetic-cardiology", 2, "send-again");
  await send(path, "synthetic-cardiology-declines", 2, "redirect", 409);
  const afterSend = await view(path);
  assert.equal(afterSend.status, "sent");
  assert.equal(afterSend.attempts.length, 1, "One request despite three send commands");
  assert.equal(afterSend.provider.id, "synthetic-cardiology");
  assert.equal(afterSend.report, null);
  const requestId = afterSend.attempts[0].requestId;
  assert.equal(sent.attempts[0].requestId, requestId);
  if (owner) {
    const [row] = await owner`select envelope, provider_reference from public.consultation_delivery_attempts where id=${requestId}`;
    assert.equal(row.provider_reference, "mock-inbox-" + requestId);
    assert.equal(row.envelope.requestId, requestId);
    assert.equal(row.envelope.approval.approvedBy, session.clinicianId);
    assert.equal(row.envelope.question, intent.clinicalQuestion);
    const serialized = JSON.stringify(row.envelope);
    for (const leaked of ["Ahmed (fictional", chart.patientId, chart.encounterId, "displayName", "birthDate"]) assert.ok(!serialized.includes(leaked), "Envelope must not carry " + leaked);
  }

  // --- Callback identity and correlation ---------------------------------------------------
  const cb = "/api/provider/v1/callbacks";
  const accepted = message(requestId, "synthetic-cardiology", "accepted", "resp-accepted");
  await call(cb, 401, { raw: JSON.stringify(accepted) });
  await call(cb, 401, callback("synthetic-cardiology", accepted, { secret: "wrong-secret" }));
  await call(cb, 401, callback("synthetic-cardiology", accepted, { timestamp: Date.now() - 3_600_000 }));
  await call(cb, 401, callback("synthetic-cardiology", accepted, { signAs: "synthetic-cardiology-declines" }));
  await call(cb, 401, callback("unknown-provider", accepted));
  // A different, genuinely authenticated provider cannot answer someone else's request.
  await call(cb, 403, callback("synthetic-cardiology-declines", accepted));
  await call(cb, 404, callback("synthetic-cardiology-declines", message(requestId, "synthetic-cardiology-declines", "report", "steal", { report })));
  await call(cb, 404, callback("synthetic-cardiology", message(crypto.randomUUID(), "synthetic-cardiology", "accepted", "unknown-request")));
  await call(cb, 400, callback("synthetic-cardiology", message(requestId, "synthetic-cardiology", "report", "no-report")));
  await call(cb, 400, callback("synthetic-cardiology", { ...message(requestId, "synthetic-cardiology", "report", "markup", { report: { ...report, summary: "<script>alert(1)</script>" } }) }));
  await call(cb, 400, callback("synthetic-cardiology", { ...accepted, dataClassification: "unclassified" }));
  assert.equal((await view(path)).status, "sent", "Refused callbacks change nothing");
  assert.equal((await view(path)).responses.length, 0);

  assert.equal((await call(cb, 200, callback("synthetic-cardiology", accepted))).json.disposition, "applied");
  assert.equal((await view(path)).status, "accepted");

  // --- Restart: the in-flight request and session survive a fresh process ------------------
  await stop();
  await start();
  const restored = await view(path);
  assert.equal(restored.status, "accepted");
  assert.equal(restored.attempts[0].requestId, requestId);

  const reportMessage = message(requestId, "synthetic-cardiology", "report", "resp-report", { report });
  const [first, second] = await Promise.all([call(cb, 200, callback("synthetic-cardiology", reportMessage)), call(cb, 200, callback("synthetic-cardiology", reportMessage))]);
  assert.deepEqual([first.json.disposition, second.json.disposition].sort(), ["applied", "duplicate"], "Concurrent duplicate callbacks apply once");
  assert.equal((await call(cb, 200, callback("synthetic-cardiology", reportMessage))).json.disposition, "duplicate");
  await call(cb, 409, callback("synthetic-cardiology", { ...reportMessage, report: { ...report, summary: "Tampered synthetic text" } }));
  await call(cb, 409, callback("synthetic-cardiology", message(requestId, "synthetic-cardiology", "report", "resp-report-2", { report })));
  assert.equal((await call(cb, 200, callback("synthetic-cardiology", message(requestId, "synthetic-cardiology", "accepted", "late-accept")))).json.disposition, "ignored");
  await call(cb, 409, callback("synthetic-cardiology", message(requestId, "synthetic-cardiology", "rejected", "late-reject", { reason: "Synthetic late refusal" })));

  // --- Clinician readback of the correct response ------------------------------------------
  const done = await view(path);
  assert.equal(done.status, "responded");
  assert.equal(done.report.requestId, requestId);
  assert.equal(done.report.providerId, "synthetic-cardiology");
  assert.deepEqual(done.report.report, report);
  assert.equal(done.canSend || done.canRetry || done.canSimulate, false);
  const final = (await call(path, 200, { cookie: physician })).json;
  assert.equal(final.lifecycleStatus, "responded");
  assert.deepEqual(final.grounding, draft.grounding, "Source grounding is unchanged by delivery");
  await send(path, "synthetic-cardiology", final.version, "send-after-response");
  assert.equal((await view(path)).attempts.length, 1, "A responded consultation is never re-sent");
  await call(path + "/transitions", 409, { cookie: physician, body: { action: "cancel", expectedVersion: final.version, idempotencyKey: "cancel-responded" + run } });
  const history = (await call(path + "/history", 200, { cookie: physician })).json;
  assert.deepEqual(history.events.map((e: { toStatus: string }) => e.toStatus).reverse(), ["pending_review", "approved", "queued", "sent", "accepted", "responded"]);

  // --- Provider failure, safe retry, and the demo simulator --------------------------------
  const offline = await prepare("m5-offline");
  const offlineApproved = await approve(offline.path, offline.draft, "synthetic-cardiology-offline");
  const failed = (await send(offline.path, "synthetic-cardiology-offline", offlineApproved.version, "offline-1")).json;
  assert.equal(failed.status, "failed");
  assert.equal(failed.attempts[0].failureCode, "transport_error");
  assert.equal(failed.canRetry, true);
  await send(offline.path, "synthetic-cardiology", failed.version, "offline-redirect", 403);
  const retried = (await send(offline.path, "synthetic-cardiology-offline", failed.version, "offline-2")).json;
  assert.equal(retried.attempts.length, 2);
  assert.notEqual(retried.attempts[0].requestId, retried.attempts[1].requestId, "A retry is a new request with a new id");
  await call(cb, 409, callback("synthetic-cardiology-offline", message(retried.attempts[1].requestId, "synthetic-cardiology-offline", "report", "superseded", { report })));
  await call(offline.path + "/delivery/simulate", 409, { cookie: physician, body: {} });
  const cancelled = (await call(offline.path + "/transitions", 200, { cookie: physician, body: { action: "cancel", expectedVersion: retried.version, idempotencyKey: "cancel-offline" + run } })).json;
  assert.equal(cancelled.lifecycleStatus, "cancelled");
  await call(cb, 409, callback("synthetic-cardiology-offline", message(retried.attempts[0].requestId, "synthetic-cardiology-offline", "report", "after-cancel", { report })));

  const declined = await prepare("m5-declined");
  const declinedApproved = await approve(declined.path, declined.draft, "synthetic-cardiology-declines");
  await send(declined.path, "synthetic-cardiology-declines", declinedApproved.version, "declines-1");
  const refusal = (await call(declined.path + "/delivery/simulate", 200, { cookie: physician, body: {} })).json;
  assert.equal(refusal.status, "failed");
  assert.equal(refusal.attempts[0].status, "rejected");
  assert.equal(refusal.canRetry, false);
  assert.match(refusal.responses[0].reason, /Synthetic refusal/);
  await send(declined.path, "synthetic-cardiology-declines", refusal.version, "declines-2", 409);

  const demo = await prepare("m5-demo");
  const demoApproved = await approve(demo.path, demo.draft);
  const demoSent = (await send(demo.path, "synthetic-cardiology", demoApproved.version, "demo-1")).json;
  assert.equal(demoSent.canSimulate, true);
  assert.equal((await call(demo.path + "/delivery/simulate", 200, { cookie: physician, body: {} })).json.status, "accepted");
  const simulated = (await call(demo.path + "/delivery/simulate", 200, { cookie: physician, body: {} })).json;
  assert.equal(simulated.status, "responded");
  assert.match(simulated.report.report.summary, /SYNTHETIC SPECIALIST RESPONSE/);
  assert.match(simulated.report.report.summary, /ECG/);
  assert.ok(!/normal/i.test(JSON.stringify(simulated.report.report)), "The simulated reply never calls missing data normal");
  await call(demo.path + "/delivery/simulate", 409, { cookie: physician, body: {} });

  // --- Everything is still there after another restart, for the right clinician only -------
  await stop();
  await start();
  assert.deepEqual(await view(path), done, "Delivery state and the specialist response survive restart");
  assert.deepEqual(await view(demo.path), simulated);
  const list = (await call(drafts, 200, { cookie: physician })).json;
  for (const expected of [draft.id, offline.draft.id, declined.draft.id, demo.draft.id]) assert.ok(list.some((d: { id: string }) => d.id === expected));
  assert.equal(list.find((d: { id: string }) => d.id === draft.id).status, "responded");
  await call(path + "/delivery", 404, { cookie: await launch("other-clinician") });
  await call(path + "/delivery", 401);
  console.log("Passed M5/M6 synthetic flow: grounded draft, approval gate, allowlisted idempotent routing, provider failure and retry, signed callback identity and correlation, duplicate/late/out-of-order handling, clinician readback and two app restarts.");
} finally {
  await stop();
  await owner?.end();
}
