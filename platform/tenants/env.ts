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
  OPENAI_MODEL: z.string().default("gpt-5"),
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
