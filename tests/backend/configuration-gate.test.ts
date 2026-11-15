import { describe, expect, it } from "vitest";
import { configurationProblems, parseEnv, removedSettings, ServerConfigurationError } from "@/platform/tenants/env";
import { completeConfig as complete } from "@/tests/helpers/config";

const failure = (source: Record<string, string | undefined>) => {
  try { parseEnv(source); } catch (error) { return error; }
  return undefined;
};

describe("server configuration gate", () => {
  it("accepts a complete configuration, for FHIR and OpenEMR", () => {
    expect(configurationProblems(parseEnv(complete))).toEqual([]);
    expect(parseEnv({ ...complete, CLINICAL_DATA_SOURCE: "openemr" }).CLINICAL_DATA_SOURCE).toBe("openemr");
    // The launch and the model provider have one possible value each; leaving them out changes nothing.
    expect(parseEnv({ ...complete, AUTH_MODE: undefined, AI_PROVIDER: undefined })).toMatchObject({ AUTH_MODE: "smart", AI_PROVIDER: "openai" });
  });

  it("refuses to start on nothing: there is no built-in chart, model or sign-in to fall back to", () => {
    const error = failure({});
    expect(error).toBeInstanceOf(ServerConfigurationError);
    expect((error as Error).message).toContain("StethoLink is not configured");
    expect((error as Error).message).toContain("CLINICAL_DATA_SOURCE must be set");
    expect((error as Error).message).toContain("TENANT_ID must be set");
  });

  it("ships model limits a reasoning model can draft within", () => {
    expect(parseEnv(complete)).toMatchObject({ OPENAI_TIMEOUT_MS: 90_000, OPENAI_MAX_OUTPUT_TOKENS: 8000, OPENAI_MAX_COST_USD: 0.25 });
    expect(parseEnv({ ...complete, OPENAI_TIMEOUT_MS: "120000" }).OPENAI_TIMEOUT_MS).toBe(120_000);
    expect(failure({ ...complete, OPENAI_TIMEOUT_MS: "120001" })).toBeInstanceOf(ServerConfigurationError);
  });

  it.each([
    ["no EHR data source", { CLINICAL_DATA_SOURCE: undefined }, "CLINICAL_DATA_SOURCE"],
    ["no tenant", { TENANT_ID: undefined }, "TENANT_ID"],
    ["no EHR address", { FHIR_BASE_URL: undefined }, "FHIR_BASE_URL"],
    ["no SMART client", { SMART_CLIENT_ID: undefined }, "SMART_CLIENT_ID"],
    ["no clinician map", { SMART_CLINICIAN_MAP: undefined }, "SMART_CLINICIAN_MAP"],
    ["no database", { STETHOLINK_DATABASE_URL: undefined }, "STETHOLINK_DATABASE_URL"],
    ["an empty database URL", { STETHOLINK_DATABASE_URL: "" }, "STETHOLINK_DATABASE_URL"],
    ["no session encryption key", { SESSION_ENCRYPTION_KEY: undefined }, "SESSION_ENCRYPTION_KEY"],
    ["a model not approved for patient data", { MODEL_LIVE_DATA_APPROVED: "false" }, "MODEL_LIVE_DATA_APPROVED"],
    ["no model approval statement", { MODEL_LIVE_DATA_APPROVED: undefined }, "MODEL_LIVE_DATA_APPROVED"],
    ["no model key", { OPENAI_API_KEY: undefined }, "OPENAI_API_KEY"],
    ["no model cost bounds", { OPENAI_OUTPUT_USD_PER_MILLION: undefined }, "OPENAI_OUTPUT_USD_PER_MILLION"],
    ["an unknown data source", { CLINICAL_DATA_SOURCE: "spreadsheet" }, "CLINICAL_DATA_SOURCE is not valid"],
    ["an unknown model provider", { AI_PROVIDER: "other" }, "AI_PROVIDER is not valid"],
  ])("refuses to start with %s", (_name, change, setting) => {
    const error = failure({ ...complete, ...change });
    expect(error).toBeInstanceOf(ServerConfigurationError);
    expect((error as Error).message).toContain(setting);
  });

  it.each([
    ["the development sign-in", { AUTH_MODE: "dev" }, "AUTH_MODE=dev"],
    ["the staging sign-in", { AUTH_MODE: "staging" }, "AUTH_MODE=staging"],
    ["a staging launch secret", { STAGING_LAUNCH_SECRET: "x".repeat(32) }, "STAGING_LAUNCH_SECRET"],
    ["the built-in fictional charts", { CLINICAL_DATA_SOURCE: "synthetic" }, "CLINICAL_DATA_SOURCE=synthetic"],
    ["synthetic mode", { CLINICAL_DATA_MODE: "synthetic" }, "CLINICAL_DATA_MODE=synthetic"],
    ["the stand-in model", { AI_PROVIDER: "mock" }, "AI_PROVIDER=mock"],
    ["the stand-in transcription", { TRANSCRIPTION_PROVIDER: "mock" }, "TRANSCRIPTION_PROVIDER=mock"],
    ["the in-memory browser client", { NEXT_PUBLIC_API_MODE: "mock" }, "NEXT_PUBLIC_API_MODE=mock"],
    ["simulated specialists", { MOCK_RECIPIENT_IDS: "synthetic-cardiology" }, "MOCK_RECIPIENT_IDS"],
    ["a simulated specialist secret", { MOCK_PROVIDER_SECRET: "x".repeat(32) }, "MOCK_PROVIDER_SECRET"],
    ["a local fictional chart", { LOCAL_SYNTHETIC_CHART: "omar" }, "LOCAL_SYNTHETIC_CHART"],
    ["a staging model switch", { STAGING_LIVE_MODEL: "enabled" }, "STAGING_LIVE_MODEL"],
  ])("refuses a deployment that still asks for %s, by name", (_name, change, setting) => {
    const error = failure({ ...complete, ...change });
    expect(error).toBeInstanceOf(ServerConfigurationError);
    expect((error as Error).message).toContain("no longer part of StethoLink");
    expect((error as Error).message).toContain(setting);
  });

  it("accepts the settings that used to select live mode, since it is the only mode", () => {
    expect(removedSettings({ CLINICAL_DATA_MODE: "live", NEXT_PUBLIC_API_MODE: "http" })).toEqual([]);
    expect(configurationProblems(parseEnv({ ...complete, CLINICAL_DATA_MODE: "live" }))).toEqual([]);
  });

  it("names settings but never prints their values", () => {
    const secret = "fictional-secret-that-must-not-appear-in-logs";
    for (const source of [
      { ...complete, OPENAI_API_KEY: secret, STAGING_LAUNCH_SECRET: secret, MOCK_PROVIDER_SECRET: secret },
      { ...complete, OPENAI_API_KEY: secret, SESSION_ENCRYPTION_KEY: secret, STETHOLINK_DATABASE_URL: undefined },
      { ...complete, OPENAI_API_KEY: secret, FHIR_BASE_URL: `not a url ${secret}`, OPENAI_TIMEOUT_MS: secret },
    ]) {
      const error = failure(source);
      expect(error).toBeInstanceOf(ServerConfigurationError);
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
