import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { GET as smartLaunch } from "@/apps/embedded-app/app/api/smart/launch/route";
import { GET as smartCallback } from "@/apps/embedded-app/app/api/smart/callback/route";
import { session } from "@/apps/embedded-app/server/auth-routes";
import { SMART_LAUNCH_REASONS } from "@/platform/auth/smart-launch-failure";
import { ehrLaunchScope } from "@/platform/auth/smart-session";
import { FAKE_EHR, fakeEhr, smartEnv } from "../helpers/smart-launch";
import { fictionalChart, FICTIONAL_ENCOUNTER_ID, FICTIONAL_PATIENT_ID } from "../fixtures/fhir-chart";

const { jar, env, handles, store } = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  env: { NODE_ENV: "production", TENANT_ID: "fictional-tenant", CLINICAL_DATA_MODE: "live" } as Record<string, string | number>,
  handles: new Map<string, { kind: string; payload: unknown; expiresAt: number }>(),
  store: { failSession: false },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({
  get: (key: string) => ({ value: jar.get(key) }), set: (key: string, value: string) => jar.set(key, value),
}), headers: async () => new Headers({ host: "app.example.test" }) }));
vi.mock("@/platform/tenants/env", async (original) => ({
  ...await original<typeof import("@/platform/tenants/env")>(), getEnv: () => env,
}));
vi.mock("@/platform/auth/session-store", () => ({
  sessionCookie: "session", launchCookie: "launch",
  storeHandle: async (kind: string, payload: unknown, expiresAt: number) => {
    if (kind === "session" && store.failSession) throw new Error("fictional store outage");
    const key = crypto.randomUUID();
    handles.set(key, { kind, payload, expiresAt });
    return key;
  },
  readHandle: async (key: string, kind: string, consume: boolean) => {
    const stored = handles.get(key);
    if (!stored || stored.kind !== kind || stored.expiresAt <= Date.now()) return undefined;
    if (consume) handles.delete(key);
    return stored.payload;
  },
}));

const defaults = { ...env };
const seen = new Set<string>();
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  jar.clear();
  handles.clear();
  store.failSession = false;
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, defaults);
});

type Ehr = Awaited<ReturnType<typeof fakeEhr>>;
type Options = NonNullable<Parameters<typeof fakeEhr>[0]>;
type Case = {
  reason: (typeof SMART_LAUNCH_REASONS)[number];
  detail?: string;
  status: number;
  /** What the browser is told. Defaults to the generic refusal of the callback. */
  message?: string;
  ehr?: Options;
  env?: Record<string, string>;
  /** Replaces the launch request, the callback request, or both. */
  launchQuery?: Record<string, string>;
  callbackQuery?: (state: string) => Record<string, string>;
  skipLaunch?: boolean;
  before?: () => void;
};

const GENERIC = "SMART clinician or chart context could not be verified";
const stateOf = (text: string) => text.padEnd(43, "x");
const unreachable = (path: string) => (url: URL) => { if (url.pathname.endsWith(path)) throw new TypeError("fetch failed"); return undefined; };
const answer = (path: string, response: () => Response) => (url: URL) => url.pathname.endsWith(path) ? response() : undefined;
const discovery = (change: Record<string, unknown>) => answer("/.well-known/smart-configuration", () => Response.json({
  authorization_endpoint: FAKE_EHR.oidc + "/authorize", token_endpoint: FAKE_EHR.oidc + "/token", code_challenge_methods_supported: ["S256"], ...change,
}));
const mapOf = (fhirUser: string) => JSON.stringify([{ subject: FAKE_EHR.subject, fhirUser, clinicianId: FAKE_EHR.clinicianId, role: "physician" }]);
const without = (key: string) => (body: Record<string, unknown>) => Object.fromEntries(Object.entries(body).filter(([name]) => name !== key));
const now = () => Math.floor(Date.now() / 1000);

const launchCases: Case[] = [
  { reason: "launch_malformed", status: 400, message: "Invalid SMART launch", launchQuery: { launch: "fictional-launch" } },
  { reason: "not_configured", status: 501, message: "SMART launch is not configured", env: { SMART_CLIENT_ID: "" } },
  { reason: "registration_invalid", detail: "clinician_map", status: 503, message: "SMART registration is invalid", env: { SMART_CLINICIAN_MAP: "{not json" } },
  { reason: "registration_invalid", detail: "scope", status: 503, message: "SMART registration is invalid", env: { SMART_SCOPE: "launch openid" } },
  { reason: "registration_invalid", detail: "endpoint", status: 503, message: "SMART registration is invalid", env: { SMART_JWKS_URL: "http://id.example.test/jwks" } },
  { reason: "issuer_unregistered", detail: "issuer", status: 403, message: "Unregistered SMART launch", launchQuery: { iss: "https://other.example.test/fhir", launch: "fictional-launch" } },
  { reason: "discovery_unreachable", status: 503, message: "SMART discovery could not be verified", ehr: { intercept: unreachable("/smart-configuration") } },
  { reason: "discovery_rejected", detail: "http:500", status: 503, message: "SMART discovery could not be verified", ehr: { intercept: answer("/smart-configuration", () => new Response(null, { status: 500 })) } },
  { reason: "discovery_invalid", status: 503, message: "SMART discovery could not be verified", ehr: { intercept: answer("/smart-configuration", () => Response.json({})) } },
  { reason: "discovery_endpoint_mismatch", detail: "endpoint:token", status: 503, message: "SMART discovery could not be verified", ehr: { intercept: discovery({ token_endpoint: "https://other.example.test/token" }) } },
  { reason: "discovery_endpoint_mismatch", detail: "endpoint:authorization", status: 503, message: "SMART discovery could not be verified", ehr: { intercept: discovery({ authorization_endpoint: "https://other.example.test/authorize" }) } },
  { reason: "pkce_s256_unsupported", status: 503, message: "SMART discovery could not be verified", ehr: { intercept: discovery({ code_challenge_methods_supported: ["plain"] }) } },
];

const callbackCases: Case[] = [
  { reason: "authorization_denied", status: 400, message: "Invalid SMART callback", callbackQuery: (state) => ({ error: "access_denied", error_description: "fictional-ehr-refusal-text", state }) },
  { reason: "callback_malformed", status: 400, message: "Invalid SMART callback", callbackQuery: (state) => ({ state }) },
  { reason: "launch_session_missing", status: 403, message: "SMART launch session is missing or expired", skipLaunch: true },
  { reason: "callback_invalid", status: 403, callbackQuery: () => ({ code: "fictional-code", state: stateOf("forged") }) },
  { reason: "token_endpoint_unreachable", status: 403, ehr: { intercept: unreachable("/token") } },
  { reason: "token_exchange_rejected", detail: "http:400", status: 403, ehr: { intercept: answer("/token", () => Response.json({ error: "invalid_grant" }, { status: 400 })) } },
  { reason: "grant_invalid", status: 403, ehr: { token: (body) => ({ ...body, token_type: "mac" }) } },
  { reason: "grant_invalid", status: 403, ehr: { intercept: answer("/token", () => new Response("<html>", { status: 200 })) } },
  { reason: "id_token_missing", detail: "id_token", status: 403, ehr: { token: without("id_token") } },
  { reason: "id_token_missing", detail: "scope", status: 403, ehr: { token: without("scope") } },
  { reason: "identity_scopes_missing", status: 403, ehr: { scope: "launch openid patient/Patient.rs" } },
  { reason: "jwks_unavailable", status: 403, ehr: { intercept: unreachable("/jwks") } },
  { reason: "jwks_unavailable", status: 403, ehr: { intercept: answer("/jwks", () => new Response(null, { status: 500 })) } },
  { reason: "jwks_no_matching_key", status: 403, ehr: { intercept: answer("/jwks", () => Response.json({ keys: [] })) } },
  { reason: "id_token_invalid", detail: "signature", status: 403, ehr: { idToken: { foreignKey: true } } },
  { reason: "id_token_invalid", detail: "claim:iss", status: 403, ehr: { idToken: { issuer: "https://other.example.test" } } },
  { reason: "id_token_invalid", detail: "claim:aud", status: 403, ehr: { idToken: { audience: "other-client" } } },
  { reason: "id_token_invalid", detail: "claim:exp", status: 403, ehr: { idToken: { issuedAt: now() - 120, expiresAt: now() - 60 } } },
  { reason: "id_token_invalid", detail: "claim:fhiruser", status: 403, ehr: { idToken: { claims: { fhirUser: undefined } } } },
  { reason: "binding_failed", detail: "check:nonce", status: 403, ehr: { idToken: { claims: { nonce: "fictional-other-nonce" } } } },
  { reason: "binding_failed", detail: "check:azp", status: 403, ehr: { idToken: { claims: { azp: "other-client" } } } },
  { reason: "binding_failed", detail: "check:at_hash", status: 403, ehr: { idToken: { claims: { at_hash: "fictional-other-hash" } } } },
  { reason: "missing_patient", status: 403, ehr: { token: without("patient") } },
  { reason: "clinician_unmapped", detail: "subject:fhir_user_relative", status: 403, ehr: { idToken: { subject: "fictional-other-subject" } } },
  { reason: "clinician_unmapped", detail: "fhir_user:absolute_on_issuer", status: 403, ehr: { idToken: { claims: { fhirUser: `${FAKE_EHR.fhir}/Practitioner/fic-another-doctor` } } } },
  // OpenEMR signs Person/<uuid> for a mapped user who has no NPI.
  { reason: "clinician_not_practitioner", status: 403, ehr: { idToken: { claims: { fhirUser: `${FAKE_EHR.fhir}/Person/fic-doctor` } } } },
  { reason: "clinician_unmapped", detail: "fhir_user:absolute_elsewhere", status: 403, ehr: { idToken: { claims: { fhirUser: `https://other.example.test/${FAKE_EHR.fhirUser}` } } } },
  { reason: "clinician_reference_invalid", status: 403, env: { SMART_CLINICIAN_MAP: mapOf("Patient/fic-doctor") }, ehr: { idToken: { claims: { fhirUser: "Patient/fic-doctor" } } } },
  { reason: "missing_encounter", status: 422, message: "Open a visit in the patient's chart, then launch StethoLink again.", ehr: { token: without("encounter") } },
  { reason: "fhir_patient_unreadable", detail: "http:403", status: 403, ehr: { intercept: answer(`/Patient/${FICTIONAL_PATIENT_ID}`, () => new Response(null, { status: 403 })) } },
  { reason: "fhir_patient_unreadable", detail: "empty", status: 403, ehr: { intercept: answer(`/Patient/${FICTIONAL_PATIENT_ID}`, () => new Response(null, { status: 404 })) } },
  { reason: "fhir_patient_unreadable", detail: "request_failed", status: 403, ehr: { intercept: unreachable(`/Patient/${FICTIONAL_PATIENT_ID}`) } },
  { reason: "fhir_encounter_unreadable", detail: "http:401", status: 403, ehr: { intercept: answer(`/Encounter/${FICTIONAL_ENCOUNTER_ID}`, () => new Response(null, { status: 401 })) } },
  { reason: "fhir_encounter_unreadable", detail: "empty", status: 403, ehr: { fhirOverride: (path) => path.startsWith("/Encounter/") ? { ...fictionalChart().encounter, subject: { reference: "Patient/fic-other" } } : undefined } },
  { reason: "encounter_unsupported", status: 422, message: expect.stringContaining("entered-in-error") as unknown as string, ehr: { fhirOverride: (path) => path.startsWith("/Encounter/") ? { ...fictionalChart().encounter, status: "entered-in-error" } : undefined } },
  // The grant runs out while the chart is being read.
  { reason: "grant_expired", status: 403, message: "SMART grant expired", before: () => { vi.useFakeTimers({ toFake: ["Date"] }); },
    ehr: { intercept: (url) => { if (url.pathname.endsWith(`/Patient/${FICTIONAL_PATIENT_ID}`)) vi.setSystemTime(Date.now() + 20 * 60_000); return undefined; } } },
  { reason: "unexpected", status: 500, message: "Unexpected server error", before: () => { store.failSession = true; } },
];

/** Runs a launch that is expected to fail. Returns the failing response, everything written to the console, and the secrets in play. */
async function run(test: Case, stage: "launch" | "callback", accept?: string) {
  Object.assign(env, smartEnv("physician"), test.env);
  test.before?.();
  const ehr: Ehr = await fakeEhr(test.ehr);
  vi.stubGlobal("fetch", ehr.request);
  const output: string[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { output.push(args.map(String).join(" ")); });
  }
  const headers = accept ? { accept } : undefined;
  const launchQuery = test.launchQuery ?? { iss: FAKE_EHR.fhir, launch: "fictional-launch" };
  const secrets = [FAKE_EHR.accessToken, FAKE_EHR.subject, FAKE_EHR.fhirUser, FAKE_EHR.clinicianId, FAKE_EHR.clientId, FICTIONAL_PATIENT_ID,
    FICTIONAL_ENCOUNTER_ID, "fictional-code", "fictional-launch", "example.test", "access_denied", "fictional-ehr-refusal-text", "fictional-other"];
  let state = stateOf("no-launch");
  if (!test.skipLaunch) {
    const launch = await smartLaunch(new Request(`${FAKE_EHR.app}/api/smart/launch?` + new URLSearchParams(launchQuery), { headers }));
    if (stage === "launch") return { response: launch, output, secrets, ehr };
    expect(launch.status).toBe(307);
    expect(output).toEqual([]);
    const params = new URL(launch.headers.get("location")!).searchParams;
    state = params.get("state")!;
    ehr.state.nonce = params.get("nonce")!;
    secrets.push(state, ehr.state.nonce);
  }
  const query = test.callbackQuery?.(state) ?? { code: "fictional-code", state };
  const response = await smartCallback(new Request(`${FAKE_EHR.app}/api/smart/callback?` + new URLSearchParams(query), { headers }));
  secrets.push(...[ehr.state.verifier, ehr.state.idToken, ...ehr.state.idToken.split(".")].filter(Boolean));
  return { response, output, secrets, ehr };
}

describe.each([["launch", launchCases], ["callback", callbackCases]] as const)("a failed SMART %s", (stage, cases) => {
  it.each(cases.map((test) => [test.reason + (test.detail ? ` (${test.detail})` : ""), test] as const))(
    "is logged as %s with the correlation ID and nothing else",
    async (_name, test) => {
      const { response, output, secrets } = await run(test, stage);
      seen.add(test.reason);
      expect(response.status).toBe(test.status);
      expect(await response.json()).toMatchObject({ error: { message: test.message ?? GENERIC } });
      expect((await session()).status).toBe(401);

      const failures = output.filter((line) => line.includes("smart.launch_failed"));
      expect(failures).toHaveLength(1);
      const entry = JSON.parse(failures[0]) as Record<string, string>;
      const correlationId = response.headers.get("x-correlation-id");
      expect(correlationId).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
      expect(entry).toEqual({
        action: "smart.launch_failed", stage, reason: test.reason, correlationId, at: expect.any(String),
        ...(test.detail ? { detail: test.detail } : {}),
      });

      // Nothing written to any console stream carries a token, code, state, nonce, verifier, identity, chart identifier or URL.
      const written = output.join("\n");
      for (const secret of secrets) expect(written).not.toContain(secret);
    },
  );
});

describe("SMART launch diagnostics", () => {
  afterAll(() => {
    // Every reason code the product can log has a test above.
    expect([...seen].sort()).toEqual([...SMART_LAUNCH_REASONS].sort());
  });

  it("writes nothing on a launch that succeeds", async () => {
    const { response, output } = await run({ reason: "unexpected", status: 303 }, "callback");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/embed");
    expect(output).toEqual([]);
  });

  it("shows the clinician a page with what to do and the correlation ID when no visit is open", async () => {
    const test = callbackCases.find((entry) => entry.reason === "missing_encounter")!;
    const { response, output } = await run(test, "callback", "text/html,application/xhtml+xml");
    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const page = await response.text();
    expect(page).toContain("Open a visit in the patient&#39;s chart, then launch StethoLink again.");
    const { correlationId } = JSON.parse(output.find((line) => line.includes("smart.launch_failed"))!) as { correlationId: string };
    expect(page).toContain(correlationId);
    expect(response.headers.get("x-correlation-id")).toBe(correlationId);
  });

  it("shows the same generic page, with the correlation ID and no reason, for a security failure", async () => {
    const pages = await Promise.all(["clinician_unmapped", "binding_failed"].map(async (reason) => {
      const result = await run(callbackCases.find((entry) => entry.reason === reason)!, "callback", "text/html");
      vi.restoreAllMocks();
      jar.clear();
      const id = result.response.headers.get("x-correlation-id")!;
      const page = await result.response.text();
      expect(result.response.status).toBe(403);
      expect(page).toContain(id);
      expect(page).toContain(GENERIC);
      expect(page).not.toContain(reason);
      return page.replace(id, "");
    }));
    expect(pages[0]).toBe(pages[1]);
  });

  // OpenEMR signs the absolute form with a UUID id; other EHRs sign the relative one. The map may hold either.
  const uuid = "a33befbc-75b6-4434-8ece-e0c1762888a0";
  it.each([
    ["absolute", "relative", `${FAKE_EHR.fhir}/${FAKE_EHR.fhirUser}`, FAKE_EHR.fhirUser],
    ["relative", "absolute", FAKE_EHR.fhirUser, `${FAKE_EHR.fhir}/${FAKE_EHR.fhirUser}`],
    ["absolute UUID", "relative UUID", `${FAKE_EHR.fhir}/Practitioner/${uuid}`, `Practitioner/${uuid}`],
    ["absolute UUID", "absolute UUID", `${FAKE_EHR.fhir}/Practitioner/${uuid}`, `${FAKE_EHR.fhir}/Practitioner/${uuid}`],
  ])("accepts a signed %s fhirUser for a %s map entry of the same clinician", async (_signed, _mapped, signed, mapped) => {
    const { response, output } = await run({ reason: "unexpected", status: 303, env: { SMART_CLINICIAN_MAP: mapOf(mapped) }, ehr: { idToken: { claims: { fhirUser: signed } } } }, "callback");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/embed");
    expect(output).toEqual([]);
  });

  it.each([
    ["another id", `${FAKE_EHR.fhir}/Practitioner/fic-doctor-2`],
    ["an id in another letter case", `${FAKE_EHR.fhir}/Practitioner/FIC-DOCTOR`],
    ["another resource type", `${FAKE_EHR.fhir}/PractitionerRole/fic-doctor`],
    ["another host", `https://ehr.example.test.attacker.example/fhir/${FAKE_EHR.fhirUser}`],
    ["another path on the host", `${FAKE_EHR.fhir}-other/${FAKE_EHR.fhirUser}`],
    ["a deeper path", `${FAKE_EHR.fhir}/tenant-2/${FAKE_EHR.fhirUser}`],
    ["http instead of https", `${FAKE_EHR.fhir.replace("https:", "http:")}/${FAKE_EHR.fhirUser}`],
    ["a trailing path", `${FAKE_EHR.fhir}/${FAKE_EHR.fhirUser}/_history/1`],
    ["a query", `${FAKE_EHR.fhir}/${FAKE_EHR.fhirUser}?x=1`],
  ])("still refuses a signed fhirUser with %s", async (_name, signed) => {
    const { response } = await run({ reason: "clinician_unmapped", status: 403, ehr: { idToken: { claims: { fhirUser: signed } } } }, "callback");
    expect(response.status).toBe(403);
    expect((await session()).status).toBe(401);
  });

  it("still needs the signed subject to equal the mapped one, whatever the fhirUser form", async () => {
    const { response } = await run({ reason: "clinician_unmapped", status: 403,
      ehr: { idToken: { subject: FAKE_EHR.subject.toUpperCase(), claims: { fhirUser: `${FAKE_EHR.fhir}/${FAKE_EHR.fhirUser}` } } } }, "callback");
    expect(response.status).toBe(403);
  });

  it("gives every failed request its own correlation ID", async () => {
    const test = launchCases.find((entry) => entry.reason === "issuer_unregistered")!;
    const first = (await run(test, "launch")).response.headers.get("x-correlation-id");
    const second = (await run(test, "launch")).response.headers.get("x-correlation-id");
    expect(first).not.toBe(second);
  });

  it("never sends launch/patient on an EHR launch, so OpenEMR keeps the encounter in the token", async () => {
    expect(ehrLaunchScope("launch launch/patient openid  fhirUser patient/Patient.rs")).toBe("launch openid fhirUser patient/Patient.rs");
    Object.assign(env, smartEnv("physician"));
    env.SMART_SCOPE = "launch launch/patient " + String(env.SMART_SCOPE).replace(/^launch /, "");
    vi.stubGlobal("fetch", (await fakeEhr()).request);
    const launch = await smartLaunch(new Request(`${FAKE_EHR.app}/api/smart/launch?` + new URLSearchParams({ iss: FAKE_EHR.fhir, launch: "fictional-launch" })));
    expect(launch.status).toBe(307);
    const scopes = new URL(launch.headers.get("location")!).searchParams.get("scope")!.split(" ");
    expect(scopes).not.toContain("launch/patient");
    expect(scopes).toEqual(expect.arrayContaining(["launch", "openid", "fhirUser", "patient/Patient.rs", "patient/Encounter.rs"]));
  });
});
