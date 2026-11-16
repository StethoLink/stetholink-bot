import { afterEach, describe, expect, it, vi } from "vitest";
import { logout, session } from "@/apps/embedded-app/server/auth-routes";
import { GET as smartLaunch } from "@/apps/embedded-app/app/api/smart/launch/route";
import { GET as smartCallback } from "@/apps/embedded-app/app/api/smart/callback/route";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { requireClinician } from "@/platform/auth/session";
import { completeSmartLaunch, FAKE_EHR, fakeEhr, smartEnv } from "../helpers/smart-launch";
import { FICTIONAL_ENCOUNTER_ID, FICTIONAL_PATIENT_ID } from "../fixtures/fhir-chart";
import { fictionalChart } from "../fixtures/fhir-chart";

const { jar, requestHeaders, env, handles } = vi.hoisted(() => ({
  jar: new Map<string, string>(), requestHeaders: new Headers({ host: "app.example.test" }),
  env: {
    NODE_ENV: "production", AUTH_MODE: "smart", TENANT_ID: "fictional-test", AI_PROVIDER: "openai", CLINICAL_DATA_SOURCE: "fhir",
  } as Record<string, string | number>,
  handles: new Map<string, { kind: string; payload: unknown; expiresAt: number }>(),
}));
const defaults = { ...env };
vi.mock("next/headers", () => ({ cookies: async () => ({
  get: (key: string) => ({ value: jar.get(key) }), set: (key: string, value: string) => jar.set(key, value),
}), headers: async () => requestHeaders }));
vi.mock("@/platform/tenants/env", async (original) => ({
  ...await original<typeof import("@/platform/tenants/env")>(), getEnv: () => env,
}));
vi.mock("@/platform/auth/session-store", () => ({
  sessionCookie: "session", launchCookie: "launch",
  storeHandle: async (kind: string, payload: unknown, expiresAt: number) => {
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
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  jar.clear();
  handles.clear();
  requestHeaders.delete("origin");
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, defaults);
});

const routes = { launch: smartLaunch, callback: smartCallback };
async function launchFromEhr(role: "physician" | "clinician" = "physician") {
  Object.assign(env, smartEnv(role));
  const ehr = await fakeEhr();
  vi.stubGlobal("fetch", ehr.request);
  return completeSmartLaunch(routes, ehr);
}

describe("clinician session", () => {
  it("exists only after a launch from the EHR: there is no other sign-in", async () => {
    Object.assign(env, smartEnv("physician"));
    expect((await session()).status).toBe(401);
    await expect(requireClinician()).rejects.toMatchObject({ code: "unauthenticated" });
    expect(jar.size).toBe(0);
  });

  it("binds clinician, tenant and chart, expires and revokes the session", async () => {
    expect((await session()).status).toBe(401);
    expect((await launchFromEhr()).status).toBe(303);
    expect(await (await session()).json()).toMatchObject({
      clinicianId: FAKE_EHR.clinicianId, tenantId: "fictional-test", roles: ["physician"],
      patientId: FICTIONAL_PATIENT_ID, encounterId: FICTIONAL_ENCOUNTER_ID,
    });
    // The EHR grant lasts ten minutes; the session ends with it.
    vi.useFakeTimers({ now: Date.now() + 601_000 });
    expect((await session()).status).toBe(401);
    vi.useRealTimers();
    expect((await launchFromEhr()).status).toBe(303);
    const old = jar.get("session")!;
    expect((await logout()).status).toBe(204);
    jar.set("session", old);
    expect((await session()).status).toBe(401);
  });

  it("rejects a cross-origin request on a launched session", async () => {
    expect((await launchFromEhr()).status).toBe(303);
    requestHeaders.set("origin", "https://elsewhere.example.test");
    expect((await session()).status).toBe(403);
    expect((await logout()).status).toBe(403);
  });
});

describe("SMART launch", () => {
  it.each(["valid", "wrong-nonce", "wrong-audience", "unmapped", "wrong-patient"])(
    "validates a signed EHR identity and chart without an existing session (%s)", async (scenario) => {
      const issuer = "https://ehr.example.test/fhir";
      const oidc = "https://id.example.test";
      const callback = "https://app.example.test/api/smart/callback";
      const user = "Practitioner/syn-doctor";
      const valid = scenario === "valid";
      Object.assign(env, {
        AUTH_MODE: "smart", CLINICAL_DATA_SOURCE: "fhir", FHIR_BASE_URL: issuer, SMART_OIDC_ISSUER: oidc,
        SMART_JWKS_URL: oidc + "/jwks", SMART_CLIENT_ID: "synthetic-client", SMART_REDIRECT_URI: callback,
        SMART_AUTHORIZATION_URL: oidc + "/authorize", SMART_TOKEN_URL: oidc + "/token",
        SMART_SCOPE: "launch openid fhirUser patient/Patient.r patient/Encounter.r",
        SMART_CLINICIAN_MAP: JSON.stringify([{ subject: "synthetic-sub", fhirUser: user,
          clinicianId: "11111111-1111-4111-8111-111111111111", role: "physician" }]),
      });
      const keys = await generateKeyPair("ES256");
      const jwk = await exportJWK(keys.publicKey);
      let nonce = "";
      const request = vi.fn(async (target: URL | string, init?: RequestInit) => {
        const url = new URL(target);
        if (url.pathname.endsWith("smart-configuration")) return Response.json({
          authorization_endpoint: env.SMART_AUTHORIZATION_URL, token_endpoint: env.SMART_TOKEN_URL, code_challenge_methods_supported: ["S256"],
        });
        if (url.pathname === "/token") {
          expect((init?.body as URLSearchParams).get("code_verifier")).toMatch(/^[\w-]{43}$/);
          const idToken = await new SignJWT({ nonce: scenario === "wrong-nonce" ? "other" : nonce, fhirUser: user })
            .setProtectedHeader({ alg: "ES256" }).setIssuer(oidc)
            .setAudience(scenario === "wrong-audience" ? "other" : "synthetic-client")
            .setSubject(scenario === "unmapped" ? "other" : "synthetic-sub").setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
          return Response.json({ id_token: idToken, scope: env.SMART_SCOPE, token_type: "Bearer",
            access_token: "synthetic-ehr-token", expires_in: 300, patient: "p1", encounter: "e1" });
        }
        if (url.pathname === "/jwks") return Response.json({ keys: [jwk] });
        if (url.pathname.endsWith("/Patient/p1")) return Response.json({ resourceType: "Patient", id: "p1" });
        if (url.pathname.endsWith("/Encounter/e1")) return Response.json({
          resourceType: "Encounter", id: "e1", subject: { reference: scenario === "wrong-patient" ? "Patient/p2" : "Patient/p1" },
          class: { code: "AMB" }, status: "finished", period: { start: "2026-01-01" },
        });
        return Response.json({ resourceType: "Bundle", entry: [] });
      });
      vi.stubGlobal("fetch", request);
      const untrusted = await smartLaunch(new Request("https://app.example.test/api/smart/launch?iss=https://untrusted.example&launch=synthetic"));
      expect(untrusted.status).toBe(403);
      expect(request).not.toHaveBeenCalled();
      const launch = await smartLaunch(new Request("https://app.example.test/api/smart/launch?" + new URLSearchParams({ iss: issuer, launch: "synthetic" })));
      expect(launch.status).toBe(307);
      const params = new URL(launch.headers.get("location")!).searchParams;
      nonce = params.get("nonce")!;
      expect(params.get("code_challenge_method")).toBe("S256");
      const finish = () => smartCallback(new Request(callback + "?" + new URLSearchParams({ code: "synthetic-code", state: params.get("state")! })));
      expect((await finish()).status).toBe(valid ? 303 : 403);
      expect((await finish()).status).toBe(403);
      const current = await session();
      expect(current.status).toBe(valid ? 200 : 401);
      if (valid) {
        const body = await current.json();
        // A session verified against the EHR is always classified as real patient data.
        expect(body).toMatchObject({ patientId: "p1", encounterId: "e1", roles: ["physician"], dataClassification: "live" });
        expect(body).not.toHaveProperty("ehrAccessToken");
      }
    },
  );
});

describe("SMART session permissions", () => {
  it.each([
    ["physician", ["chart:read", "consultation:draft", "scribe:record", "order:draft", "consultation:approve", "consultation:route", "chart:write", "order:approve"]],
    ["clinician", ["chart:read", "consultation:draft", "scribe:record", "order:draft"]],
  ] as const)("come from the tenant's clinician mapping after the signed launch (%s)", async (role, expected) => {
    Object.assign(env, smartEnv(role));
    // A token that claims StethoLink permissions in its scope gains nothing by it.
    const ehr = await fakeEhr({ scope: smartEnv(role).SMART_SCOPE + " consultation:approve consultation:route order:approve" });
    vi.stubGlobal("fetch", ehr.request);
    expect((await completeSmartLaunch(routes, ehr)).status).toBe(303);
    const launched = await requireClinician();
    expect(launched.context.roles).toEqual([role]);
    expect(launched.context.scopes.filter((scope) => !scope.startsWith("smart:"))).toEqual(expected);
    expect(launched.context.scopes).toContain("smart:consultation:approve");
    expect(launched.context.dataClassification).toBe("live");
  });
  it("tells the clinician why a visit cannot be opened", async () => {
    Object.assign(env, smartEnv("physician"));
    const ehr = await fakeEhr({ fhirOverride: (path) => path.startsWith("/Encounter/") ? { ...fictionalChart().encounter, status: "entered-in-error" } : undefined });
    vi.stubGlobal("fetch", ehr.request);
    const refused = await completeSmartLaunch(routes, ehr);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ error: { code: "unsupported_encounter", message: expect.stringContaining("entered-in-error") } });
    expect((await session()).status).toBe(401);
  });
  it("opens an emergency visit whose status is only arrived", async () => {
    Object.assign(env, smartEnv("physician"));
    const ehr = await fakeEhr({ fhirOverride: (path) => path.startsWith("/Encounter/") ? { ...fictionalChart().encounter, status: "arrived", class: { code: "EMER" } } : undefined });
    vi.stubGlobal("fetch", ehr.request);
    expect((await completeSmartLaunch(routes, ehr)).status).toBe(303);
  });
});
describe("session data classification", () => {
  it("rejects a stored session that is not a verified EHR session of this tenant classified as real patient data", async () => {
    const context = {
      clinicianId: "11111111-1111-4111-8111-111111111111", tenantId: "fictional-test", roles: ["physician"], scopes: ["chart:read"],
      patientId: "p1", encounterId: "e1", expiresAt: Date.now() + 60_000, authorization: "active",
    };
    Object.assign(env, smartEnv("physician"));
    const store = (dataClassification?: string, change: Record<string, unknown> = {}) => {
      handles.set("stored", { kind: "session", expiresAt: Date.now() + 60_000,
        payload: { source: "smart", ehrAccessToken: "fictional-ehr-token", ...change, context: { ...context, ...(dataClassification ? { dataClassification } : {}) } } });
      jar.set("session", "stored");
    };
    store("live");
    expect(await (await session()).json()).toMatchObject({ dataClassification: "live" });
    for (const value of [undefined, "synthetic", "production"]) {
      store(value);
      expect((await session()).status).toBe(401);
    }
    // Sessions that earlier versions issued without an EHR (development and staging launches) are refused.
    store("synthetic", { source: "synthetic", ehrAccessToken: undefined });
    expect((await session()).status).toBe(401);
    store("live", { source: "synthetic" });
    expect((await session()).status).toBe(401);
    store("live", { ehrAccessToken: undefined });
    expect((await session()).status).toBe(401);
    env.TENANT_ID = "another-tenant";
    store("live");
    expect((await session()).status).toBe(401);
  });
});
