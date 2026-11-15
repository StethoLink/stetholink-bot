import { beforeEach, describe, expect, it, vi } from "vitest";

const { env } = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock("@/platform/tenants/env", async (original) => ({ ...await original<typeof import("@/platform/tenants/env")>(), getEnv: () => env }));
vi.mock("@/platform/persistence/database", () => ({ database: () => { throw new Error("no database in this test"); } }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }), headers: async () => new Headers() }));
const { openPayload, sealPayload } = await import("@/platform/auth/session-store");
const { cookieOptions } = await import("@/platform/auth/session");
const { parseEnv, liveModeProblems } = await import("@/platform/tenants/env");

const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");
const session = { source: "smart", ehrAccessToken: "fictional-ehr-access-token", context: { clinicianId: "55555555-5555-4555-8555-555555555555" } };
beforeEach(() => { for (const key of Object.keys(env)) delete env[key]; Object.assign(env, { NODE_ENV: "production", COOKIE_MODE: "lax" }); });

describe("stored sessions", () => {
  it("are encrypted at rest: the EHR token is not readable in the stored row", () => {
    env.SESSION_ENCRYPTION_KEY = KEY_A;
    const stored = sealPayload(session);
    expect(JSON.stringify(stored)).not.toContain("fictional-ehr-access-token");
    expect(stored).toMatchObject({ sealed: "v1" });
    expect(openPayload(stored)).toEqual(session);
    // A fresh nonce every time: the same session never produces the same stored value.
    expect(JSON.stringify(sealPayload(session))).not.toBe(JSON.stringify(stored));
  });
  it("survive a key rotation while the previous key is still listed, and not after", () => {
    env.SESSION_ENCRYPTION_KEY = KEY_A;
    const stored = sealPayload(session);
    Object.assign(env, { SESSION_ENCRYPTION_KEY: KEY_B, SESSION_ENCRYPTION_KEYS_PREVIOUS: KEY_A });
    expect(openPayload(stored)).toEqual(session);
    expect(sealPayload(session)).not.toMatchObject({ key: (stored as { key: string }).key });
    env.SESSION_ENCRYPTION_KEYS_PREVIOUS = undefined;
    expect(openPayload(stored)).toBeUndefined();
  });
  it("reject a tampered row, and an unencrypted row once a key is configured", () => {
    env.SESSION_ENCRYPTION_KEY = KEY_A;
    const stored = sealPayload(session) as { data: string };
    expect(openPayload({ ...stored, data: Buffer.from("x" + Buffer.from(stored.data, "base64").toString("latin1"), "latin1").toString("base64") })).toBeUndefined();
    expect(openPayload(session)).toBeUndefined();
    env.SESSION_ENCRYPTION_KEY = undefined;
    // Local development without a key keeps working on synthetic data.
    expect(openPayload(session)).toEqual(session);
  });
  it("need a key before real patient data is allowed", () => {
    const live = { CLINICAL_DATA_MODE: "live", AUTH_MODE: "smart", CLINICAL_DATA_SOURCE: "fhir", STETHOLINK_DATABASE_URL: "postgres://x@db.example.test/x", AI_PROVIDER: "openai", OPENAI_API_KEY: "k",
      OPENAI_INPUT_USD_PER_MILLION: "1", OPENAI_OUTPUT_USD_PER_MILLION: "1", MODEL_LIVE_DATA_APPROVED: "true" };
    expect(() => parseEnv(live)).toThrow(/SESSION_ENCRYPTION_KEY/);
    expect(liveModeProblems(parseEnv({ ...live, SESSION_ENCRYPTION_KEY: KEY_A }))).toEqual([]);
    expect(() => parseEnv({ SESSION_ENCRYPTION_KEY: "too-short" })).toThrow();
  });
});

describe("session cookie", () => {
  it("is Lax for a top-level window and None, Secure, Partitioned inside the EHR iframe", () => {
    expect(cookieOptions(60)).toEqual({ httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 60 });
    env.COOKIE_MODE = "embedded";
    expect(cookieOptions(60)).toEqual({ httpOnly: true, secure: true, sameSite: "none", partitioned: true, path: "/", maxAge: 60 });
  });
});
