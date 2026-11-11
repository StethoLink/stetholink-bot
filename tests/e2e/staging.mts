import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";

const base = new URL(process.env.STAGING_BASE_URL ?? "");
const secret = process.env.STAGING_LAUNCH_SECRET;
assert.ok(secret && secret.length >= 32, "Set STAGING_LAUNCH_SECRET");
assert.ok(base.protocol === "https:" || base.hostname === "127.0.0.1", "Use HTTPS except on loopback");
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

async function request(path: string, expected: number, opts: { cookie?: string; body?: object; launch?: boolean; origin?: string; contentType?: string; method?: "GET" | "POST" } = {}) {
  const headers = new Headers();
  if (bypass) headers.set("x-vercel-protection-bypass", bypass);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  if (opts.body) headers.set("content-type", opts.contentType ?? "application/json");
  if (opts.origin) headers.set("origin", opts.origin);
  if (opts.launch) headers.set("authorization", "Bearer " + secret);
  const response = await fetch(new URL(path, base), {
    method: opts.method ?? (opts.body ? "POST" : "GET"), headers,
    body: opts.body && JSON.stringify(opts.body), redirect: "manual",
  });
  assert.equal(response.status, expected, path);
  return response;
}

const launch = async (profile: string) => {
  const response = await request("/api/staging/launch", 200, { body: { profile }, launch: true });
  const setCookie = response.headers.getSetCookie().find((header) => header.startsWith("stetholink-session="));
  assert.ok(setCookie && /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie));
  assert.match(setCookie, /Secure/i);
  return setCookie.split(";")[0];
};

const drafts = "/api/consultations/drafts";
const session = "/api/auth/session";
await request(session, 401);
await request("/api/auth/login", 404);
await request("/api/staging/launch", 401, { body: { profile: "physician" } });
await request(drafts, 401, { body: { patientId: "syn-pt-001" } });
await request(session, 401, { cookie: "stetholink-session=" + "a".repeat(43) });

const physician = await launch("physician");
const identity = await (await request(session, 200, { cookie: physician })).json();
assert.equal(identity.clinicianId, "11111111-1111-4111-8111-111111111111");
assert.deepEqual(identity.roles, ["physician"]);
assert.equal(identity.patientId, "syn-pt-001");
assert.equal(identity.encounterId, "syn-enc-001");
assert.ok(identity.tenantId && identity.expiresAt > Date.now());
assert.equal(identity.ehrAccessToken, undefined);
await request("/api/patients/syn-pt-001/context", 200, { cookie: physician });
await request("/api/encounters/syn-enc-001", 200, { cookie: physician });
await request("/api/consultations/demo", 403, { cookie: physician, method: "POST" });
const ahmed = await launch("same-clinician-other-chart");
await request("/api/consultations/demo", 200, { cookie: ahmed, method: "POST" });
await request("/api/consultations/demo", 400, { cookie: ahmed, body: { patientId: "syn-pt-001" } });
await request("/api/patients/syn-pt-002/context", 404, { cookie: physician });
await request(drafts, 403, { cookie: physician, body: { patientId: "syn-pt-002" } });
await request(drafts, 403, { cookie: physician, body: { patientId: "syn-pt-001", encounterId: "other-encounter" } });
const draft = await (await request(drafts, 201, { cookie: physician, body: { patientId: "syn-pt-001" } })).json();
assert.equal(draft.status, "pending_approval");
assert.equal(draft.encounterId, "syn-enc-001");
const path = drafts + "/" + encodeURIComponent(draft.id);
const recipientId = "synthetic-consult-team";
const body = { draftId: draft.id, decision: "approve", recipientId,
  expectedVersion: draft.version, idempotencyKey: draft.id + "-review" };
const send = { recipientId, expectedVersion: draft.version + 1, idempotencyKey: draft.id + "-send" };
await request(path + "/delivery", 409, { cookie: physician, body: { ...send, expectedVersion: draft.version } });
await request(path + "/approval", 400, { cookie: physician, body: { ...body, reviewedBy: identity.clinicianId, status: "approved" } });
await request(path + "/approval", 400, { cookie: physician, body: { ...body, expectedVersion: undefined } });
await request(path + "/approval", 400, { cookie: physician, body, contentType: "text/plain" });
await request(path + "/approval", 403, { cookie: physician, body, origin: "https://unrelated.example" });
await request(path + "/approval", 403, { cookie: physician, body: { ...body, recipientId: "unlisted-team" } });

for (const profile of ["same-clinician-other-chart", "other-clinician", "observer"]) {
  const cookie = await launch(profile);
  await request(path, 404, { cookie });
  await request(path + "/approval", profile === "observer" ? 403 : 404, { cookie, body });
  await request(path + "/delivery", profile === "observer" ? 403 : 404, { cookie, body: send });
}

const approved = await (await request(path + "/approval", 200, { cookie: physician, body })).json();
assert.equal(approved.status, "approved");
assert.equal(approved.reviewedBy, identity.clinicianId);
assert.equal(approved.approvedRecipientId, recipientId);
assert.deepEqual(await (await request(path + "/approval", 200, { cookie: physician, body })).json(), approved);
await request(path + "/approval", 409, { cookie: physician, body: { ...body, idempotencyKey: "different-review" } });
await request(path + "/delivery", 400, { cookie: physician, body: { ...send, tenantId: "another-tenant" } });
await request(path + "/delivery", 403, { cookie: physician, body: { ...send, recipientId: "unlisted-team" } });
const [receipt, replay] = await Promise.all([
  request(path + "/delivery", 200, { cookie: physician, body: send }),
  request(path + "/delivery", 200, { cookie: physician, body: send }),
].map(async (response) => (await response).json()));
assert.deepEqual(receipt, { draftId: draft.id, recipientId, status: "submitted" });
assert.deepEqual(replay, receipt);
assert.deepEqual(await (await request(path + "/delivery", 200, { cookie: physician })).json(), receipt);
await request(path + "/delivery", 409, { cookie: physician, body: { ...send, idempotencyKey: "different-send" } });
const history = await (await request(path + "/history", 200, { cookie: physician })).json();
assert.equal(history.attempts.length, 1);
assert.equal(history.events.filter((event: { toStatus: string }) => event.toStatus === "sent").length, 1);

const revocable = await launch("physician");
await request("/api/auth/logout", 204, { cookie: revocable, body: {} });
await request(session, 401, { cookie: revocable });
const expiryWait = identity.expiresAt - Date.now() + 500;
assert.ok(expiryWait <= 60_000, "Use STAGING_SESSION_SECONDS=45 for the smoke run");
await setTimeout(Math.max(0, expiryWait));
await request(session, 401, { cookie: physician });
await request(path + "/approval", 401, { cookie: physician, body });
await request(path + "/delivery", 401, { cookie: physician, body: send });
console.log("Passed M4 HTTP boundaries: clinician and chart binding, expiry, forged fields, origin, recipient policy and replay-safe dispatch.");
