import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout } from "node:timers/promises";

assert.ok(process.env.STETHOLINK_DATABASE_URL, "Configure isolated runtime database");
assert.equal(process.env.AUTH_MODE, "staging");
assert.equal(process.env.VERCEL_ENV, "preview");
const port = process.env.M3_TEST_APP_PORT ?? "3076";
const base = "http://127.0.0.1:" + port;
let app: ChildProcess | undefined;
async function start() {
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "apps/embedded-app", "--hostname", "127.0.0.1", "--port", port],
    { env: { ...process.env, NODE_ENV: "production" }, stdio: ["ignore", "ignore", "inherit"] });
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
async function request(path: string, expected: number, opts: { cookie?: string; body?: object; method?: string; launch?: boolean } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.cookie) headers.set("cookie", opts.cookie);
  if (opts.launch) headers.set("authorization", "Bearer " + process.env.STAGING_LAUNCH_SECRET);
  const response = await fetch(base + path, { method: opts.method ?? (opts.body ? "POST" : "GET"), headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined });
  assert.equal(response.status, expected, `${opts.method ?? (opts.body ? "POST" : "GET")} ${path}`);
  return response;
}
async function launch(profile = "physician") {
  const r = await request("/api/staging/launch", 200, { body: { profile }, launch: true });
  const cookie = r.headers.getSetCookie().find((h) => h.startsWith("stetholink-session="));
  assert.ok(cookie);
  return cookie.split(";")[0];
}
const root = "/api/consultations/drafts";
try {
  await start();
  const physician = await launch();
  const create = { patientId: "syn-pt-001", idempotencyKey: "synthetic-m3-create" };
  const results = await Promise.all([1, 2].map(async () => (await request(root, 201, { cookie: physician, body: create })).json()));
  const draft = results[0];
  assert.deepEqual(results[1], draft, "Concurrent creates must replay one persisted response");
  assert.equal(draft.lifecycleStatus, "pending_review");
  assert.equal(draft.status, "pending_approval", "Preserve legacy HTTP status");
  assert.equal(draft.tenantId, "ci-synthetic");
  assert.equal(draft.version, 1);
  assert.deepEqual(draft.grounding?.evidenceIds, []);
  assert.equal(draft.grounding.question, null, "Persisted grounding retains an explicit null question");
  assert.ok(draft.grounding?.gaps.length);
  assert.ok(draft.grounding?.provenance.promptVersion);
  assert.ok(draft.grounding?.provenance.model);
  assert.deepEqual(draft.clinicalFacts, []);
  const path = root + "/" + draft.id;
  const read = async () => (await request(path, 200, { cookie: physician })).json();
  assert.deepEqual(await read(), draft, "A later request restores all M2 metadata");
  await request(path, 401, { method: "PATCH", body: {} });
  await request(path + "/transitions", 401, { body: {} });
  await request(path + "/history", 401);
  const transition = async (action: string, version: number, key: string, expected = 200, recipientId?: string) =>
    (await request(path + "/transitions", expected, { cookie: physician,
      body: { action, expectedVersion: version, idempotencyKey: key, ...(recipientId ? { recipientId } : {}) } })).json();
  await transition("approve", 1, "illegal-ai-approval", 400);
  await transition("queue", 1, "premature-queue", 409, "synthetic-consult-team");
  await request(path + "/transitions", 400, { cookie: physician, body: { action: "cancel" } });
  for (const profile of ["same-clinician-other-chart", "other-clinician", "observer"]) {
    const cookie = await launch(profile);
    await request(path, 404, { cookie });
    await request(path + "/history", 404, { cookie });
    await request(path + "/transitions", 404, { cookie, body: { action: "cancel", expectedVersion: 1, idempotencyKey: "foreign-cancel" } });
    await request(path, 404, { method: "PATCH", cookie, body: { expectedVersion: 1, idempotencyKey: "foreign-edit", summary: "Synthetic", assessment: "Synthetic", plan: [] } });
    await request(path + "/approval", profile === "observer" ? 403 : 404, { cookie,
      body: { draftId: draft.id, decision: "approve", recipientId: "synthetic-consult-team", expectedVersion: 1, idempotencyKey: "foreign-approval" } });
  }
  const approve = async (decision: string, version: number, key: string, expected = 200) =>
    (await request(path + "/approval", expected, { cookie: physician,
      body: { draftId: draft.id, decision, expectedVersion: version, idempotencyKey: key,
        ...(decision === "approve" ? { recipientId: "synthetic-consult-team" } : {}) } })).json();
  assert.equal((await approve("request_changes", 1, "human-request-changes")).status, "draft");
  const revisions = ["first-edit", "second-edit"].map((key) => ({ expectedVersion: 2, idempotencyKey: key,
    summary: "Synthetic revised summary " + key, assessment: "Synthetic revised assessment", plan: ["Physician review required"] }));
  const edited = await Promise.all(revisions.map(async (body) => {
    const response = await fetch(base + path, { method: "PATCH", headers: { cookie: physician, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }));
  assert.deepEqual(edited.map((r) => r.status).sort(), [200, 409], "Only one concurrent edit may win");
  const winningIndex = edited.findIndex((r) => r.status === 200);
  const winner = edited[winningIndex].body;
  assert.equal(winner.version, 3);
  assert.equal(winner.reviewedBy, undefined);
  assert.deepEqual(winner.grounding, draft.grounding, "Edits preserve source grounding as generated evidence");
  const revision = revisions[winningIndex];
  assert.deepEqual(await (await request(path, 200, { cookie: physician, method: "PATCH", body: revision })).json(), winner);
  await request(path, 409, { cookie: physician, method: "PATCH", body: { ...revision, summary: "Different synthetic command" } });
  await approve("approve", 3, "unsubmitted-approval", 409);
  await request(path + "/delivery", 409, { cookie: physician, body: {
    recipientId: "synthetic-consult-team", expectedVersion: 3, idempotencyKey: "unapproved-edited-dispatch",
  } });
  await transition("submit", 3, "submit-edited");
  const decisionBodies = ["human-approve-a", "human-approve-b"].map((key) => ({ draftId: draft.id, decision: "approve", recipientId: "synthetic-consult-team", expectedVersion: 4, idempotencyKey: key }));
  const decisions = await Promise.all(decisionBodies.map(async (body) => {
    const response = await fetch(base + path + "/approval", { method: "POST", headers: { cookie: physician, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }));
  assert.deepEqual(decisions.map((r) => r.status).sort(), [200, 409], "Only one concurrent decision may win");
  const decisionIndex = decisions.findIndex((r) => r.status === 200);
  const approved = decisions[decisionIndex].body;
  assert.equal(approved.status, "approved");
  assert.equal(approved.version, 5);
  await transition("queue", 5, "disallowed-recipient", 403, "other-team");
  await transition("queue", 5, "queue-first", 200, "synthetic-consult-team");
  await transition("failed", 6, "failed-first");
  await transition("queue", 7, "queue-retry", 200, "synthetic-consult-team");
  await transition("sent", 8, "mock-sent");
  await transition("accepted", 9, "mock-accepted");
  const responded = await transition("responded", 10, "mock-responded");
  assert.equal(responded.version, 11);
  await transition("cancel", 11, "cancel-responded", 409);
  await request(path + "/delivery", 409, { cookie: physician, body: {
    recipientId: "synthetic-consult-team", expectedVersion: 11, idempotencyKey: "duplicate-dispatch",
  } });
  const history = await (await request(path + "/history", 200, { cookie: physician })).json();
  assert.equal(history.revisions.length, 11);
  assert.equal(history.events.length, 11);
  assert.equal(history.attempts.length, 2);
  assert.deepEqual(history.attempts.map((a: { status: string }) => a.status), ["responded", "failed"]);
  assert.equal(history.nextBeforeVersion, null);
  const pending = await (await request(root, 201, { cookie: physician, body: { ...create, idempotencyKey: "surviving-pending" } })).json();
  const rejected = await (await request(root, 201, { cookie: physician, body: { ...create, idempotencyKey: "rejected-draft" } })).json();
  await request(root + "/" + rejected.id + "/approval", 200, { cookie: physician,
    body: { draftId: rejected.id, decision: "reject", expectedVersion: 1, idempotencyKey: "reject-human" } });
  await request(root + "/" + rejected.id + "/delivery", 409, { cookie: physician, body: {
    recipientId: "synthetic-consult-team", expectedVersion: 2, idempotencyKey: "rejected-dispatch",
  } });
  // A genuinely fresh process restores sessions, pending drafts, grounding,
  // statuses, immutable history, attempts and exact retry responses from Postgres.
  await stop();
  await start();
  assert.deepEqual(await read(), responded, "Lifecycle survives a server restart");
  assert.deepEqual(await (await request(root + "/" + pending.id, 200, { cookie: physician })).json(), pending, "Pending draft survives restart");
  assert.equal((await (await request(root + "/" + rejected.id, 200, { cookie: physician })).json()).status, "rejected");
  assert.deepEqual(await (await request(path + "/history", 200, { cookie: physician })).json(), history);
  assert.deepEqual(await (await request(root, 201, { cookie: physician, body: create })).json(), draft);
  assert.deepEqual(await (await request(path + "/approval", 200, { cookie: physician, body: decisionBodies[decisionIndex] })).json(), approved);
  assert.deepEqual(await transition("responded", 10, "mock-responded"), responded);
  await request(root + "/" + pending.id + "/transitions", 200, { cookie: physician,
    body: { action: "cancel", expectedVersion: 1, idempotencyKey: "cancel-pending" } });
  console.log("Passed M3 HTTP concurrency, versioning, idempotency, metadata restoration, isolation, mock attempts and fresh-process persistence.");
} finally { await stop(); }
