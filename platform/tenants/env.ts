import "server-only";
import { z } from "zod";

const envSchema = z.object({
  TENANT_ID: z.string().min(1).max(128).default("local-synthetic"),
  MOCK_RECIPIENT_IDS: z.string().default("synthetic-consult-team"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  VERCEL_ENV: z.string().optional(),
  VERCEL_TARGET_ENV: z.string().optional(),
  AI_PROVIDER: z.enum(["mock", "openai"]).default("mock"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().min(1).max(128).default("gpt-5"),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().min(1).max(60_000).default(30_000),
  OPENAI_MAX_RETRIES: z.coerce.number().int().min(0).max(2).default(1),
  OPENAI_MAX_INPUT_TOKENS: z.coerce.number().int().min(1).max(32_000).default(16_000),
  OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(4096).default(2048),
  OPENAI_MAX_COST_USD: z.coerce.number().positive().max(1).default(0.1),
  OPENAI_INPUT_USD_PER_MILLION: z.coerce.number().positive().max(1000).optional(),
  OPENAI_OUTPUT_USD_PER_MILLION: z.coerce.number().positive().max(1000).optional(),
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

export function syntheticStagingEnabled(env: ServerEnv) {
  return env.AUTH_MODE === "staging" && env.VERCEL_ENV === "preview" &&
    (!env.VERCEL_TARGET_ENV || env.VERCEL_TARGET_ENV === "preview") &&
    env.CLINICAL_DATA_SOURCE === "synthetic" && env.AI_PROVIDER === "mock";
}

let cached: ServerEnv | undefined;
export function getEnv(): ServerEnv {
  return cached ??= envSchema.parse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== "")));
}
