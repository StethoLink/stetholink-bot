import { afterEach, describe, expect, it, vi } from "vitest";
import { logout, session } from "@/apps/embedded-app/server/auth-routes";
import { POST as stage } from "@/apps/embedded-app/app/api/staging/launch/route";
import { GET as smartLaunch } from "@/apps/embedded-app/app/api/smart/launch/route";
import { GET as smartCallback } from "@/apps/embedded-app/app/api/smart/callback/route";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const { jar, requestHeaders, env, handles } = vi.hoisted(() => ({
  jar: new Map<string, string>(), requestHeaders: new Headers({ host: "app.example.test" }),
  env: {
    NODE_ENV: "production", AUTH_MODE: "staging", VERCEL_ENV: "preview", TENANT_ID: "synthetic-test",
    AI_PROVIDER: "mock", CLINICAL_DATA_SOURCE: "synthetic", CLINICAL_DATA_MODE: "synthetic", STAGING_LAUNCH_SECRET: "synthetic-test-secret-for-unit-test",
    STAGING_SESSION_SECONDS: 60,
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

const stageRequest = (secret = env.STAGING_LAUNCH_SECRET, profile = "physician") =>
  new Request("https://app.example.test/api/staging/launch", {
    method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ profile }),
  });

describe("synthetic launch", () => {
  it("requires preview, a launch secret and a known profile", async () => {
    expect((await stage(stageRequest("wrong"))).status).toBe(401);
    expect((await stage(stageRequest(undefined, "unverified"))).status).toBe(400);
    env.VERCEL_ENV = "production";
    expect((await stage(stageRequest())).status).toBe(404);
    env.VERCEL_ENV = "preview";
    env.VERCEL_TARGET_ENV = "production";
    expect((await stage(stageRequest())).status).toBe(404);
    expect(jar.size).toBe(0);
  });

  it("binds clinician, tenant and chart, expires and revokes the session", async () => {
    vi.useFakeTimers();
    expect((await session()).status).toBe(401);
    expect(await (await stage(stageRequest())).json()).toEqual({ workspace: "/embed" });
    expect(await (await session()).json()).toMatchObject({
      clinicianId: "11111111-1111-4111-8111-111111111111", tenantId: "synthetic-test", roles: ["physician"],
      patientId: "syn-pt-001", encounterId: "syn-enc-001",
    });
    vi.advanceTimersByTime(60_000);
    expect((await session()).status).toBe(401);
    expect((await stage(stageRequest())).status).toBe(200);
    const old = jar.get("session")!;
    expect((await logout()).status).toBe(204);
    jar.set("session", old);
    expect((await session()).status).toBe(401);
  });

  it("rejects a cross-origin launch", async () => {
    requestHeaders.set("origin", "https://elsewhere.example.test");
    expect((await stage(stageRequest())).status).toBe(403);
    expect(jar.size).toBe(0);
  });
});

describe("SMART launch", () => {
  it.each(["valid", "wrong-nonce", "wrong-audience", "unmapped", "wrong-patient"])(
    "validates a signed EHR identity and chart without an existing session (%s)", async (scenario) => {
      const issuer = "https://ehr.example.test/fhir";
      const oidc = "https://id.example.test";
      const callback = "https://app.example.test/api/smart/callback";
      const user = "Practitioner/syn-doctor";
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
      expect((await finish()).status).toBe(scenario === "valid" ? 303 : 403);
      expect((await finish()).status).toBe(403);
      const current = await session();
      expect(current.status).toBe(scenario === "valid" ? 200 : 401);
      if (scenario === "valid") {
        const body = await current.json();
        expect(body).toMatchObject({ patientId: "p1", encounterId: "e1", roles: ["physician"] });
        expect(body).not.toHaveProperty("ehrAccessToken");
      }
    },
  );
});
