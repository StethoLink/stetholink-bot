import "server-only";
import { z } from "zod";
import { responsesEndpoint } from "@/core/agent/providers/openai-provider";
import { frameOriginProblems } from "@/platform/http/security-headers";

const envSchema = z.object({
  TENANT_ID: z.string().min(1).max(128),
  // Receiving specialist services of the tenant: JSON list of { id, displayName, specialties, transport, active }.
  PROVIDER_DIRECTORY: z.string().optional(),
  // Ids from PROVIDER_DIRECTORY this tenant may send to (enforced in Core and again in PostgreSQL).
  PROVIDER_ALLOWLIST: z.string().default(""),
  // Who may open a specialist inbox: JSON list of { specialistId (UUID), providerId, displayName, subject+fhirUser (EHR sign-in) and/or email }.
  SPECIALIST_MAP: z.string().optional(),
  // One-time sign-in codes by email for specialists without EHR access: none (off) or console (development only).
  EMAIL_PROVIDER: z.enum(["none", "console"]).default("none"),
  SPECIALIST_SESSION_MINUTES: z.coerce.number().int().min(5).max(60).default(30),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(10_000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Operator statement that the configured model deployment may process real patient data.
  MODEL_LIVE_DATA_APPROVED: z.enum(["true", "false"]).default("false"),
  // The only model provider. There is no stand-in: without its key and rates the server does not start.
  AI_PROVIDER: z.enum(["openai"]).default("openai"),
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
  // Order drafting. The hospital's approved orders, order sets and interaction rules as a JSON file (docs/orders.md), checked when the server starts.
  // Without it order drafting is not offered. The product ships no clinical content.
  ORDER_CATALOG_FILE: z.string().min(1).max(1024).optional(),
  // Bytes of the model request for order drafting, which carries the catalog with the chart. Default: OPENAI_MAX_INPUT_TOKENS.
  ORDER_MAX_INPUT_TOKENS: z.coerce.number().int().min(1000).max(120_000).optional(),
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
  TRANSCRIPTION_PROVIDER: z.enum(["openai", "elevenlabs"]).default("openai"),
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
  // Status of an approved order written to the EHR as ServiceRequest or MedicationRequest: draft waits there for the physician to sign and release it; active places it.
  FHIR_ORDER_STATUS: z.enum(["draft", "active"]).default("draft"),
  // The only way in is the verified SMART launch from the EHR.
  AUTH_MODE: z.enum(["smart"]).default("smart"),
  // The EHR the chart is read from. Required: there is no built-in chart.
  CLINICAL_DATA_SOURCE: z.enum(["fhir", "openemr"]),
  FHIR_BASE_URL: z.url().optional(),
  SMART_CLIENT_ID: z.string().optional(),
  SMART_AUTHORIZATION_URL: z.url().optional(),
  SMART_TOKEN_URL: z.url().optional(),
  SMART_REDIRECT_URI: z.url().optional(),
  SMART_OIDC_ISSUER: z.url().optional(),
  SMART_JWKS_URL: z.url().optional(),
  SMART_SCOPE: z.string().optional(),
  SMART_CLINICIAN_MAP: z.string().optional(),
  // Encrypts stored sessions (which hold the EHR access token). 32 random bytes, base64. Required for live data.
  SESSION_ENCRYPTION_KEY: z.string().regex(/^[A-Za-z0-9+/]{43}=$/).optional(),
  // Earlier keys, comma separated, still accepted for reading during a rotation.
  SESSION_ENCRYPTION_KEYS_PREVIOUS: z.string().optional(),
  // lax: top-level window. embedded: inside the EHR's iframe (SameSite=None; Secure; Partitioned).
  COOKIE_MODE: z.enum(["lax", "embedded"]).default("lax"),
  // Who may put StethoLink in a frame. Default: the origin of SMART_AUTHORIZATION_URL (the EHR's own sign-in page).
  EHR_FRAME_ORIGINS: z.string().optional(),
  // Language of the interface until the clinician chooses one: en or ar.
  UI_DEFAULT_LOCALE: z.enum(["en", "ar"]).default("en"),
  STETHOLINK_DATABASE_URL: z.string().optional(),
  STETHOLINK_DATABASE_CA: z.string().optional(),
});

export type ServerEnv = z.infer<typeof envSchema>;

/**
 * What is missing before this server may run. The product has one mode: a verified EHR launch,
 * the EHR's own chart, durable storage and a real model deployment approved for patient data.
 * Nothing stands in for a missing part, so an incomplete configuration is refused at startup.
 * Messages name settings only, never their values.
 */
export function configurationProblems(env: ServerEnv): string[] {
  const problems: string[] = [];
  const smart = ["FHIR_BASE_URL", "SMART_CLIENT_ID", "SMART_AUTHORIZATION_URL", "SMART_TOKEN_URL", "SMART_REDIRECT_URI", "SMART_OIDC_ISSUER", "SMART_JWKS_URL", "SMART_SCOPE", "SMART_CLINICIAN_MAP"] as const;
  const missing = smart.filter((name) => !env[name]);
  if (missing.length) problems.push(`${missing.join(", ")} must be set (the EHR launch)`);
  if (!env.STETHOLINK_DATABASE_URL) problems.push("STETHOLINK_DATABASE_URL must be set");
  if (!env.SESSION_ENCRYPTION_KEY) problems.push("SESSION_ENCRYPTION_KEY must be set (the stored EHR token is encrypted)");
  if (env.MODEL_LIVE_DATA_APPROVED !== "true") problems.push("MODEL_LIVE_DATA_APPROVED must be true");
  if (!(env.OPENAI_API_KEY && env.OPENAI_INPUT_USD_PER_MILLION && env.OPENAI_OUTPUT_USD_PER_MILLION)) {
    problems.push("OPENAI_API_KEY, OPENAI_INPUT_USD_PER_MILLION and OPENAI_OUTPUT_USD_PER_MILLION must be set");
  }
  if (env.SCRIBE_ENABLED === "true") problems.push(...scribeProblems(env).map((problem) => `scribe: ${problem}`));
  problems.push(...frameOriginProblems(env));
  return problems;
}

/**
 * Settings and values that selected built-in fictional charts, the stand-in model, the simulated
 * specialist or a launch without an EHR. They no longer exist. A deployment that still sets one
 * is refused by name, so it cannot believe it is running in the mode it asked for.
 */
const REMOVED_VALUES: Record<string, readonly string[]> = {
  AUTH_MODE: ["dev", "staging", "supabase"], CLINICAL_DATA_SOURCE: ["synthetic"], CLINICAL_DATA_MODE: ["synthetic"],
  AI_PROVIDER: ["mock"], TRANSCRIPTION_PROVIDER: ["mock"], NEXT_PUBLIC_API_MODE: ["mock"],
};
const REMOVED_SETTINGS = ["STAGING_LAUNCH_SECRET", "STAGING_SESSION_SECONDS", "STAGING_LIVE_MODEL", "MOCK_RECIPIENT_IDS", "MOCK_PROVIDER_SECRET", "LOCAL_SYNTHETIC_CHART"];
export function removedSettings(source: Record<string, string | undefined>): string[] {
  return [
    ...Object.entries(REMOVED_VALUES).filter(([name, values]) => values.includes(source[name] ?? "")).map(([name]) => `${name}=${source[name]} was removed`),
    ...REMOVED_SETTINGS.filter((name) => source[name]).map((name) => `${name} was removed and must not be set`),
  ];
}
const directoryEntry = z.object({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/), displayName: z.string().min(1).max(200), specialties: z.array(z.string().min(1).max(100)).min(1).max(20),
  transport: z.enum(["portal"]), active: z.boolean().default(true),
}).strict();
const specialistEntry = z.object({
  specialistId: z.uuid(), providerId: z.string().min(1).max(128), displayName: z.string().min(1).max(200),
  subject: z.string().min(1).optional(), fhirUser: z.string().min(1).optional(), email: z.email().max(254).optional(),
}).strict().refine((entry) => (entry.subject !== undefined) === (entry.fhirUser !== undefined) && (entry.subject !== undefined || entry.email !== undefined), "Give subject and fhirUser together, or an email");
export type ProviderDirectoryEntry = z.infer<typeof directoryEntry>;
export type SpecialistEntry = z.infer<typeof specialistEntry>;
function parseList<T>(raw: string | undefined, schema: z.ZodType<T>, name: string): T[] {
  if (!raw) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ServerConfigurationError(`${name} is not valid JSON`); }
  const parsed = z.array(schema).max(200).safeParse(value);
  if (!parsed.success) throw new ServerConfigurationError(`${name} is not in the expected format`);
  return parsed.data;
}
/** The tenant's receiving services, from server configuration. */
export function providerDirectory(env: ServerEnv): ProviderDirectoryEntry[] {
  const entries = parseList(env.PROVIDER_DIRECTORY, directoryEntry, "PROVIDER_DIRECTORY");
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length || entries.some((entry) => entry.id.startsWith("synthetic-"))) {
    throw new ServerConfigurationError("PROVIDER_DIRECTORY ids must be unique and must not name a synthetic provider");
  }
  return entries;
}
export function specialistMap(env: ServerEnv): SpecialistEntry[] {
  const entries = parseList(env.SPECIALIST_MAP, specialistEntry, "SPECIALIST_MAP");
  const unique = (values: (string | undefined)[]) => { const present = values.filter(Boolean); return new Set(present).size === present.length; };
  if (!unique(entries.map((entry) => entry.specialistId)) || !unique(entries.map((entry) => entry.subject)) || !unique(entries.map((entry) => entry.email?.toLowerCase()))) {
    throw new ServerConfigurationError("SPECIALIST_MAP entries must not repeat a specialist id, subject or email");
  }
  return entries;
}

/** Why the scribe may not run with a real transcription provider. Empty when it is fully configured. */
export function scribeProblems(env: ServerEnv): string[] {
  const problems: string[] = [];
  if (env.TRANSCRIPTION_LIVE_DATA_APPROVED !== "true") problems.push("TRANSCRIPTION_LIVE_DATA_APPROVED must be true");
  if (!env.TRANSCRIPTION_USD_PER_MINUTE) problems.push("TRANSCRIPTION_USD_PER_MINUTE must be set");
  else if (env.TRANSCRIPTION_USD_PER_MINUTE > env.TRANSCRIPTION_MAX_USD_PER_MINUTE) problems.push("TRANSCRIPTION_USD_PER_MINUTE is above TRANSCRIPTION_MAX_USD_PER_MINUTE");
  if (env.TRANSCRIPTION_PROVIDER === "openai" && !env.OPENAI_API_KEY) problems.push("OPENAI_API_KEY must be set for transcription");
  if (env.TRANSCRIPTION_PROVIDER === "elevenlabs" && !env.ELEVENLABS_API_KEY) problems.push("ELEVENLABS_API_KEY must be set");
  if (!(env.SCRIBE_NOTE_INPUT_USD_PER_MILLION && env.SCRIBE_NOTE_OUTPUT_USD_PER_MILLION)) problems.push("SCRIBE_NOTE_INPUT_USD_PER_MILLION and SCRIBE_NOTE_OUTPUT_USD_PER_MILLION must be set");
  return problems;
}

export class ServerConfigurationError extends Error {}

/** Parses and validates server configuration. Refuses an incomplete configuration; nothing falls back to fabricated data. */
export function parseEnv(source: Record<string, string | undefined>): ServerEnv {
  const removed = removedSettings(source);
  if (removed.length) throw new ServerConfigurationError(`Fictional charts, the stand-in model, the simulated specialist and launches without an EHR are no longer part of StethoLink: ${removed.join("; ")}`);
  const parsed = envSchema.safeParse(Object.fromEntries(Object.entries(source).filter(([, v]) => v !== "")));
  if (!parsed.success) {
    // Setting names and the kind of problem only; a rejected value is never echoed.
    const names = [...new Set(parsed.error.issues.map((issue) => `${String(issue.path[0])} ${source[String(issue.path[0])] ? "is not valid" : "must be set"}`))];
    throw new ServerConfigurationError(`StethoLink is not configured: ${names.join("; ")}`);
  }
  const env = parsed.data;
  if (env.TRANSCRIPTION_BASE_URL && !responsesEndpoint(env.TRANSCRIPTION_BASE_URL, env.NODE_ENV !== "production")) {
    throw new ServerConfigurationError("TRANSCRIPTION_BASE_URL must be an HTTPS URL without credentials or parameters (HTTP is accepted only for a loopback address outside production)");
  }
  if (env.OPENAI_BASE_URL && !responsesEndpoint(env.OPENAI_BASE_URL, env.NODE_ENV !== "production")) {
    throw new ServerConfigurationError("OPENAI_BASE_URL must be an HTTPS URL without credentials or parameters (HTTP is accepted only for a loopback address outside production)");
  }
  // Malformed directory or specialist settings stop the server.
  const directory = providerDirectory(env);
  const specialists = specialistMap(env);
  const allow = env.PROVIDER_ALLOWLIST.split(",").map((id) => id.trim()).filter(Boolean);
  if (allow.some((id) => !directory.some((entry) => entry.id === id))) throw new ServerConfigurationError("PROVIDER_ALLOWLIST names a provider that is not in PROVIDER_DIRECTORY");
  if (specialists.some((entry) => !directory.some((provider) => provider.id === entry.providerId))) throw new ServerConfigurationError("SPECIALIST_MAP names a provider that is not in PROVIDER_DIRECTORY");
  if (env.EMAIL_PROVIDER === "console" && env.NODE_ENV === "production") throw new ServerConfigurationError("EMAIL_PROVIDER=console prints sign-in codes to the log and is refused in production");
  const problems = configurationProblems(env);
  if (problems.length) throw new ServerConfigurationError(`StethoLink is not configured: ${problems.join("; ")}`);
  return env;
}

let cached: ServerEnv | undefined;
export function getEnv(): ServerEnv {
  return cached ??= parseEnv(process.env);
}
