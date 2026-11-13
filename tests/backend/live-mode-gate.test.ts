import { describe, expect, it } from "vitest";
import { liveModeProblems, parseEnv, ServerConfigurationError, syntheticStagingEnabled } from "@/platform/tenants/env";

// A complete live configuration. Every value is fictional.
const live = {
  CLINICAL_DATA_MODE: "live", AUTH_MODE: "smart", CLINICAL_DATA_SOURCE: "fhir", TENANT_ID: "fictional-hospital",
  STETHOLINK_DATABASE_URL: "postgres://stetholink_runtime@db.example.test/postgres",
  AI_PROVIDER: "openai", MODEL_LIVE_DATA_APPROVED: "true", OPENAI_API_KEY: "fictional-key",
  OPENAI_INPUT_USD_PER_MILLION: "1", OPENAI_OUTPUT_USD_PER_MILLION: "2",
};

describe("tenant live-mode gate", () => {
  it("defaults to synthetic and never approves live model data by default", () => {
    const env = parseEnv({});
    expect(env.CLINICAL_DATA_MODE).toBe("synthetic");
    expect(env.MODEL_LIVE_DATA_APPROVED).toBe("false");
  });

  it("accepts a complete live configuration, for FHIR and OpenEMR", () => {
    expect(parseEnv(live).CLINICAL_DATA_MODE).toBe("live");
    expect(parseEnv({ ...live, CLINICAL_DATA_SOURCE: "openemr" }).CLINICAL_DATA_MODE).toBe("live");
    expect(liveModeProblems(parseEnv(live))).toEqual([]);
  });

  it.each([
    ["dev launches", { AUTH_MODE: "dev" }, "AUTH_MODE"],
    ["staging launches", { AUTH_MODE: "staging" }, "AUTH_MODE"],
    ["a default auth mode", { AUTH_MODE: undefined }, "AUTH_MODE"],
    ["a configured staging launch secret", { STAGING_LAUNCH_SECRET: "x".repeat(32) }, "STAGING_LAUNCH_SECRET"],
    ["the synthetic data source", { CLINICAL_DATA_SOURCE: "synthetic" }, "CLINICAL_DATA_SOURCE"],
    ["a default data source", { CLINICAL_DATA_SOURCE: undefined }, "CLINICAL_DATA_SOURCE"],
    ["no database", { STETHOLINK_DATABASE_URL: undefined }, "STETHOLINK_DATABASE_URL"],
    ["an empty database URL", { STETHOLINK_DATABASE_URL: "" }, "STETHOLINK_DATABASE_URL"],
    ["the mock model", { AI_PROVIDER: "mock" }, "AI_PROVIDER"],
    ["a default model provider", { AI_PROVIDER: undefined }, "AI_PROVIDER"],
    ["a model not approved for live data", { MODEL_LIVE_DATA_APPROVED: "false" }, "MODEL_LIVE_DATA_APPROVED"],
    ["no model approval statement", { MODEL_LIVE_DATA_APPROVED: undefined }, "MODEL_LIVE_DATA_APPROVED"],
    ["no model key", { OPENAI_API_KEY: undefined }, "OPENAI_API_KEY"],
    ["no model cost bounds", { OPENAI_OUTPUT_USD_PER_MILLION: undefined }, "OPENAI_OUTPUT_USD_PER_MILLION"],
  ])("refuses live mode with %s", (_name, change, setting) => {
    let failure: unknown;
    try { parseEnv({ ...live, ...change }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ServerConfigurationError);
    expect((failure as Error).message).toContain("CLINICAL_DATA_MODE=live is refused");
    expect((failure as Error).message).toContain(setting);
  });

  it("names settings but never prints their values", () => {
    const secret = "fictional-secret-that-must-not-appear-in-logs";
    try { parseEnv({ ...live, AUTH_MODE: "dev", OPENAI_API_KEY: secret, STAGING_LAUNCH_SECRET: secret, STETHOLINK_DATABASE_URL: `postgres://u:${secret}@db.example.test/x` }); }
    catch (error) { expect((error as Error).message).not.toContain(secret); return; }
    throw new Error("live mode was accepted");
  });

  it("rejects an unknown mode", () => {
    expect(() => parseEnv({ CLINICAL_DATA_MODE: "production" })).toThrow();
  });

  it("keeps the same settings valid in synthetic mode", () => {
    for (const change of [{ AUTH_MODE: "dev" }, { AI_PROVIDER: "mock" }, { STETHOLINK_DATABASE_URL: undefined }, { MODEL_LIVE_DATA_APPROVED: "true" }]) {
      expect(parseEnv({ ...live, CLINICAL_DATA_MODE: "synthetic", ...change }).CLINICAL_DATA_MODE).toBe("synthetic");
    }
  });

  it("has no synthetic staging in live mode", () => {
    const staging = parseEnv({ AUTH_MODE: "staging", VERCEL_ENV: "preview", STAGING_LAUNCH_SECRET: "x".repeat(32) });
    expect(syntheticStagingEnabled(staging)).toBe(true);
    // Unreachable through parseEnv; the launch gate still checks the mode itself.
    expect(syntheticStagingEnabled({ ...staging, CLINICAL_DATA_MODE: "live" })).toBe(false);
  });
});
