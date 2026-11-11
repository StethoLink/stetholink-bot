import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout } from "node:timers/promises";

// Own only a loopback app process and synthetic rows in a disposable database.
const base = new URL(process.env.STAGING_BASE_URL ?? "http://127.0.0.1:3075");
assert.equal(base.hostname, "127.0.0.1");
assert.equal(base.protocol, "http:");
assert.ok(["localhost", "127.0.0.1"].includes(new URL(process.env.STETHOLINK_DATABASE_URL ?? "").hostname));
const secret = process.env.STAGING_LAUNCH_SECRET;
assert.ok(secret && secret.length >= 32);
let app: ChildProcess | undefined;

async function start() {
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "apps/embedded-app", "--hostname", "127.0.0.1", "--port", base.port], {
    env: { ...process.env, AUTH_MODE: "staging", VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "preview",
      AI_PROVIDER: "mock", CLINICAL_DATA_SOURCE: "synthetic", STAGING_SESSION_SECONDS: "900" },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    assert.equal(app.exitCode, null, "Local app exited before readiness");
    if (await fetch(new URL("/api/health", base)).then((r) => r.ok).catch(() => false)) return;
    await setTimeout(200);
  }
  throw new Error("Local app did not become ready");
}
async function stop() {
  if (!app || app.exitCode !== null) return;
  const exited = once(app, "exit");
  const timer = globalThis.setTimeout(() => app?.kill("SIGKILL"), 5000);
  app.kill("SIGTERM");
  try { await exited; } finally { globalThis.clearTimeout(timer); app = undefined; }
}
async function request(path: string, method = "GET", body?: object, cookie?: string) {
  return fetch(new URL(path, base), { method, redirect: "manual",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}),
      ...(path === "/api/staging/launch" ? { authorization: "Bearer " + secret } : {}) },
    body: body && JSON.stringify(body),
  });
}
async function json(path: string, expected: number, method = "GET", body?: object, cookie?: string) {
  const response = await request(path, method, body, cookie);
  assert.equal(response.status, expected, method + " " + path);
  return response.json();
}
async function launch(profile: string) {
  const response = await request("/api/staging/launch", "POST", { profile });
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie().find((v) => v.startsWith("stetholink-session="));
  assert.ok(cookie);
  return cookie.split(";")[0];
}

try {
  await start();
  const cookie = await launch("physician");
  const drafts = "/api/consultations/drafts";
  const key = "m3-" + crypto.randomUUID();
  const create = { patientId: "syn-pt-001", idempotencyKey: key };
  const [initial, duplicate] = await Promise.all([
    json(drafts, 201, "POST", create, cookie), json(drafts, 201, "POST", create, cookie),
  ]);
  assert.deepEqual(duplicate, initial, "Concurrent create must replay the original snapshot");
  assert.equal(initial.version, 1);
  assert.equal(initial.lifecycleStatus, "pending_review");
  assert.equal(initial.status, "pending_approval", "Legacy HTTP alias must be preserved");
  assert.ok(initial.grounding?.provenance.syntheticOnly);
  assert.equal(initial.grounding.question, null, "Persisted grounding retains an explicit null question");
  assert.ok(initial.grounding.provenance.promptVersion && initial.grounding.provenance.provider && initial.grounding.provenance.model);
  const path = drafts + "/" + initial.id;
  assert.deepEqual(await json(path, 200, "GET", undefined, cookie), initial);
  for (const [suffix, method, body] of [
    ["/history", "GET", undefined], ["", "PATCH", {}], ["/transitions", "POST", {}],
  ] as const) await json(path + suffix, 401, method, body);
  for (const profile of ["other-clinician", "same-clinician-other-chart"]) {
    const other = await launch(profile);
    await json(path + "/history", 404, "GET", undefined, other);
    await json(path + "/transitions", 404, "POST", { action: "cancel", expectedVersion: 1, idempotencyKey: key + profile }, other);
  }
  await json(path, 400, "PATCH", { expectedVersion: 1 }, cookie);
  await json(path + "/transitions", 400, "POST", { action: "approve", expectedVersion: 1, idempotencyKey: key }, cookie);
  const changes = await json(path + "/approval", 200, "POST", {
    draftId: initial.id, decision: "request_changes", expectedVersion: 1, idempotencyKey: key + "-changes",
  }, cookie);
  assert.equal(changes.lifecycleStatus, "draft");
  const edits = await Promise.all(["A", "B"].map((letter) => request(path, "PATCH", {
    expectedVersion: 2, idempotencyKey: key + "-edit-" + letter,
    summary: "Revised synthetic summary " + letter, assessment: initial.assessment, plan: initial.plan,
  }, cookie)));
  assert.deepEqual(edits.map((r) => r.status).sort(), [200, 409], "Concurrent edits must prevent lost updates");
  const revised = await edits.find((r) => r.status === 200)!.json();
  assert.equal(revised.version, 3);
  assert.equal(revised.reviewedBy, undefined);

  await stop();
  await start();
  assert.deepEqual(await json(path, 200, "GET", undefined, cookie), revised, "Session and revised draft must survive process replacement");
  assert.deepEqual(revised.grounding, initial.grounding);
  assert.deepEqual(revised.clinicalFacts, initial.clinicalFacts);
  assert.deepEqual(revised.missingInformation, initial.missingInformation);
  const transition = async (action: string, expectedVersion: number, recipientId?: string) => json(path + "/transitions", 200, "POST", {
    action, expectedVersion, idempotencyKey: key + "-" + action + expectedVersion, ...(recipientId ? { recipientId } : {}),
  }, cookie);
  await transition("submit", 3);
  const approval = { draftId: initial.id, decision: "approve", expectedVersion: 4, idempotencyKey: key + "-approve" };
  const approved = await json(path + "/approval", 200, "POST", approval, cookie);
  assert.equal(approved.lifecycleStatus, "approved");
  await json(path + "/transitions", 400, "POST", { action: "queue", expectedVersion: 5, idempotencyKey: key + "-queue", recipientId: "synthetic-cardiology" }, cookie);
  await json(path + "/transitions", 400, "POST", { action: "responded", expectedVersion: 5, idempotencyKey: key + "-responded" }, cookie);
  const responded = approved;
  const history = await json(path + "/history", 200, "GET", undefined, cookie);
  assert.equal(history.revisions.length, 5);
  assert.equal(history.events.length, 5);
  assert.equal(history.attempts.length, 0);
  const older = await json(path + "/history?beforeVersion=4", 200, "GET", undefined, cookie);
  assert.deepEqual(older.revisions.map((v: { version: number }) => v.version), [3, 2, 1]);
  await stop();
  await start();
  assert.deepEqual(await json(path, 200, "GET", undefined, cookie), responded);
  assert.deepEqual(await json(path + "/history", 200, "GET", undefined, cookie), history);
  assert.deepEqual(await json(drafts, 201, "POST", create, cookie), initial, "Create replay survives restart and later transitions");
  assert.deepEqual(await json(path + "/approval", 200, "POST", approval, cookie), approved);
  assert.deepEqual(await json(path, 200, "GET", undefined, cookie), responded, "Replays cannot regress durable state");
  await json(path + "/approval", 409, "POST", { ...approval, decision: "reject" }, cookie);
  console.log("Passed M3 HTTP concurrency, metadata, lifecycle, history, isolation, durable replay and two app-process replacements.");
} finally { await stop(); }
