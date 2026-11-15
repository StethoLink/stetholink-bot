import "server-only";
import { z } from "zod";
import { DATA_CLASSIFICATIONS } from "@/shared/constants";
import { responsesEndpoint } from "@/core/agent/providers/openai-provider";

const envSchema = z.object({
  TENANT_ID: z.string().min(1).max(128).default("local-synthetic"),
  MOCK_RECIPIENT_IDS: z.string().default("synthetic-cardiology,synthetic-cardiology-declines,synthetic-cardiology-offline,synthetic-radiology"),
  MOCK_PROVIDER_SECRET: z.string().min(32).optional(),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(10_000),
  LOCAL_SYNTHETIC_CHART: z.enum(["alpha", "ahmed", "omar"]).default("alpha"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  VERCEL_ENV: z.string().optional(),
  VERCEL_TARGET_ENV: z.string().optional(),
  // Tenant data classification. "live" means real patients; see liveModeProblems below.
  CLINICAL_DATA_MODE: z.enum(DATA_CLASSIFICATIONS).default("synthetic"),
  // Operator statement that the configured model deployment may process real patient data.
  MODEL_LIVE_DATA_APPROVED: z.enum(["true", "false"]).default("false"),
  AI_PROVIDER: z.enum(["mock", "openai"]).default("mock"),
  // Preview staging stays on the deterministic mock unless a live model is explicitly allowed.
  // Staging exists only in synthetic mode, so only synthetic charts are sent either way.
  STAGING_LIVE_MODEL: z.enum(["disabled", "enabled"]).default("disabled"),
  // Cumulative model spend allowed per server instance per UTC day (in addition to the per-call limit).
  AI_DAILY_BUDGET_USD: z.coerce.number().positive().max(1000).default(2),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().min(1).max(128).default("gpt-5"),
  // Base URL of the Responses API (regional or self-hosted deployment). HTTPS; loopback HTTP outside production.
  OPENAI_BASE_URL: z.url().optional(),
  // A GPT-5 consultation takes 15-30 s and occasionally over 60 s; one deadline covers every attempt.
  OPENAI_TIMEOUT_MS: z.coerce.number().int().min(1).max(120_000).default(90_000),
  OPENAI_MAX_RETRIES: z.coerce.number().int().min(0).max(2).default(1),
  OPENAI_MAX_INPUT_TOKENS: z.coerce.number().int().min(1).max(32_000).default(16_000),
  // Reasoning models count reasoning tokens as output: a consultation used 2,500-4,400 with GPT-5.
  OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(16_000).default(8000),
  OPENAI_REASONING_EFFORT: z.enum(["minimal", "low", "medium", "high"]).optional(),
  // Worst case for one call including its retry, at the configured upper-bound rates.
  OPENAI_MAX_COST_USD: z.coerce.number().positive().max(1).default(0.25),
  OPENAI_INPUT_USD_PER_MILLION: z.coerce.number().positive().max(1000).optional(),
  OPENAI_OUTPUT_USD_PER_MILLION: z.coerce.number().positive().max(1000).optional(),
  // AI scribe. Off unless enabled. Audio is never stored: any value other than "none" is refused.
  SCRIBE_ENABLED: z.enum(["true", "false"]).default("false"),
  SCRIBE_AUDIO_RETENTION: z.enum(["none"]).default("none"),
  SCRIBE_TRANSCRIPT_RETENTION_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  SCRIBE_SPOKEN_LANGUAGE: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).default("ar-SA"),
  SCRIBE_NOTE_LANGUAGE: z.enum(["en", "ar"]).default("en"),
  SCRIBE_MAX_VISIT_MINUTES: z.coerce.number().int().min(1).max(120).default(45),
  // Hard ceiling on what one visit may cost (transcription plus the note).
  SCRIBE_MAX_VISIT_USD: z.coerce.number().positive().max(5).default(0.5),
  SCRIBE_NOTE_MODEL: z.string().min(1).max(128).default("gpt-5-mini"),
  SCRIBE_NOTE_REASONING_EFFORT: z.enum(["minimal", "low", "medium", "high"]).default("low"),
  SCRIBE_NOTE_INPUT_USD_PER_MILLION: z.coerce.number().positive().max(1000).optional(),
  SCRIBE_NOTE_OUTPUT_USD_PER_MILLION: z.coerce.number().positive().max(1000).optional(),
  TRANSCRIPTION_PROVIDER: z.enum(["mock", "openai", "elevenlabs"]).default("mock"),
  TRANSCRIPTION_MODEL: z.string().min(1).max(128).default("gpt-transcribe"),
  // Operator-verified price per audio minute, and the most the operator accepts to pay.
  TRANSCRIPTION_USD_PER_MINUTE: z.coerce.number().positive().max(1).optional(),
  TRANSCRIPTION_MAX_USD_PER_MINUTE: z.coerce.number().positive().max(1).default(0.01),
  TRANSCRIPTION_LIVE_DATA_APPROVED: z.enum(["true", "false"]).default("false"),
  TRANSCRIPTION_BASE_URL: z.url().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  // Writing approved notes and selected items to the EHR. Needs write scopes in SMART_SCOPE.
  EHR_WRITE_ENABLED: z.enum(["true", "false"]).default("false"),
  FHIR_NOTE_DOC_STATUS: z.enum(["preliminary", "final"]).default("preliminary"),
  FHIR_NOTE_TYPE_CODE: z.string().regex(/^[0-9]{3,7}-[0-9]$/).optional(),
  AUTH_MODE: z.enum(["dev", "smart", "staging", "supabase"]).default("dev"),
  CLINICAL_DATA_SOURCE: z.enum(["synthetic", "fhir", "openemr"]).default("synthetic"),
  FHIR_BASE_URL: z.url().optional(),
  SMART_CLIENT_ID: z.string().optional(),
  SMART_AUTHORIZATION_URL: z.url().optional(),
  SMART_TOKEN_URL: z.url().optional(),
  SMART_REDIRECT_URI: z.url().optional(),
  SMART_OIDC_ISSUER: z.url().optional(),
  SMART_JWKS_URL: z.url().optional(),
  SMART_SCOPE: z.string().optional(),
  SMART_CLINICIAN_MAP: z.string().optional(),
  STETHOLINK_DATABASE_URL: z.string().optional(),
  STETHOLINK_DATABASE_CA: z.string().optional(),
  STAGING_LAUNCH_SECRET: z.string().min(32).optional(),
  STAGING_SESSION_SECONDS: z.coerce.number().int().min(5).max(900).default(300),
});

export type ServerEnv = z.infer<typeof envSchema>;

/**
 * Why this configuration may not run with real patient data. Empty when CLINICAL_DATA_MODE=live
 * is fully configured. Live mode needs the verified EHR launch, an EHR data source, durable
 * storage and a model deployment approved for live data, with every synthetic launch path off.
 * Messages name settings only, never their values.
 */
export function liveModeProblems(env: ServerEnv): string[] {
  const problems: string[] = [];
  if (env.AUTH_MODE !== "smart") problems.push("AUTH_MODE must be smart (dev and staging launches are synthetic only)");
  if (env.CLINICAL_DATA_SOURCE === "synthetic") problems.push("CLINICAL_DATA_SOURCE must be fhir or openemr");
  if (!env.STETHOLINK_DATABASE_URL) problems.push("STETHOLINK_DATABASE_URL must be set");
  if (env.STAGING_LAUNCH_SECRET) problems.push("STAGING_LAUNCH_SECRET must not be set");
  if (env.AI_PROVIDER === "mock") problems.push("AI_PROVIDER must be a real model provider (the mock never drafts from live data)");
  if (env.MODEL_LIVE_DATA_APPROVED !== "true") problems.push("MODEL_LIVE_DATA_APPROVED must be true");
  if (env.AI_PROVIDER === "openai" && !(env.OPENAI_API_KEY && env.OPENAI_INPUT_USD_PER_MILLION && env.OPENAI_OUTPUT_USD_PER_MILLION)) {
    problems.push("OPENAI_API_KEY, OPENAI_INPUT_USD_PER_MILLION and OPENAI_OUTPUT_USD_PER_MILLION must be set");
  }
  if (env.SCRIBE_ENABLED === "true") problems.push(...scribeProblems(env).map((problem) => `scribe: ${problem}`));
  return problems;
}
/** Why the scribe may not run with a real transcription provider. Empty when it is fully configured. */
export function scribeProblems(env: ServerEnv): string[] {
  const problems: string[] = [];
  if (env.TRANSCRIPTION_PROVIDER === "mock") problems.push("TRANSCRIPTION_PROVIDER must be a real provider (the stand-in never receives live speech)");
  if (env.TRANSCRIPTION_LIVE_DATA_APPROVED !== "true") problems.push("TRANSCRIPTION_LIVE_DATA_APPROVED must be true");
  if (!env.TRANSCRIPTION_USD_PER_MINUTE) problems.push("TRANSCRIPTION_USD_PER_MINUTE must be set");
  else if (env.TRANSCRIPTION_USD_PER_MINUTE > env.TRANSCRIPTION_MAX_USD_PER_MINUTE) problems.push("TRANSCRIPTION_USD_PER_MINUTE is above TRANSCRIPTION_MAX_USD_PER_MINUTE");
  if (env.TRANSCRIPTION_PROVIDER === "openai" && !env.OPENAI_API_KEY) problems.push("OPENAI_API_KEY must be set for transcription");
  if (env.TRANSCRIPTION_PROVIDER === "elevenlabs" && !env.ELEVENLABS_API_KEY) problems.push("ELEVENLABS_API_KEY must be set");
  if (!(env.SCRIBE_NOTE_INPUT_USD_PER_MILLION && env.SCRIBE_NOTE_OUTPUT_USD_PER_MILLION)) problems.push("SCRIBE_NOTE_INPUT_USD_PER_MILLION and SCRIBE_NOTE_OUTPUT_USD_PER_MILLION must be set");
  return problems;
}

export class ServerConfigurationError extends Error {}

/** Parses and validates server configuration. Refuses an incomplete live-mode configuration. */
export function parseEnv(source: Record<string, string | undefined>): ServerEnv {
  const env = envSchema.parse(Object.fromEntries(Object.entries(source).filter(([, v]) => v !== "")));
  if (env.TRANSCRIPTION_BASE_URL && !responsesEndpoint(env.TRANSCRIPTION_BASE_URL, env.NODE_ENV !== "production")) {
    throw new ServerConfigurationError("TRANSCRIPTION_BASE_URL must be an HTTPS URL without credentials or parameters (HTTP is accepted only for a loopback address outside production)");
  }
  if (env.OPENAI_BASE_URL && !responsesEndpoint(env.OPENAI_BASE_URL, env.NODE_ENV !== "production")) {
    throw new ServerConfigurationError("OPENAI_BASE_URL must be an HTTPS URL without credentials or parameters (HTTP is accepted only for a loopback address outside production)");
  }
  if (env.CLINICAL_DATA_MODE === "live") {
    const problems = liveModeProblems(env);
    if (problems.length) throw new ServerConfigurationError(`CLINICAL_DATA_MODE=live is refused: ${problems.join("; ")}`);
  }
  return env;
}

export function syntheticStagingEnabled(env: ServerEnv) {
  return env.CLINICAL_DATA_MODE === "synthetic" && env.AUTH_MODE === "staging" && env.VERCEL_ENV === "preview" &&
    (!env.VERCEL_TARGET_ENV || env.VERCEL_TARGET_ENV === "preview") &&
    env.CLINICAL_DATA_SOURCE === "synthetic" && (env.AI_PROVIDER === "mock" || env.STAGING_LIVE_MODEL === "enabled");
}

let cached: ServerEnv | undefined;
export function getEnv(): ServerEnv {
  return cached ??= parseEnv(process.env);
}
