import "server-only";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  AI_PROVIDER: z.enum(["mock", "openai"]).default("mock"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-5"),
  AUTH_MODE: z.enum(["dev", "supabase"]).default("dev"),
  CLINICAL_DATA_SOURCE: z.enum(["synthetic", "fhir"]).default("synthetic"),
  FHIR_BASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
});

export type ServerEnv = z.infer<typeof envSchema>;

let cached: ServerEnv | undefined;
/** Server environment, parsed once. Empty strings are treated as unset. */
export function getEnv(): ServerEnv {
  if (!cached) {
    const raw = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ""));
    cached = envSchema.parse(raw);
  }
  return cached;
}
