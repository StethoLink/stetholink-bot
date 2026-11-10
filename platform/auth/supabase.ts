import "server-only";
import { z } from "zod";
import { getEnv } from "@/platform/tenants/env";

export class SupabaseError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`Supabase request failed (${status}, ${code})`);
  }
}

export function supabaseConfig() {
  const env = getEnv();
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !key) throw new SupabaseError(503, "configuration_missing");
  return { url: env.NEXT_PUBLIC_SUPABASE_URL, key };
}

/** Uses only a public key and, for database access, the verified caller's token. */
export function createSupabaseTransport(config = supabaseConfig(), doFetch: typeof fetch = fetch) {
  return async (path: string, init: RequestInit = {}, token?: string): Promise<unknown> => {
    let response: Response;
    try {
      response = await doFetch(new URL(path, config.url), {
        ...init,
        headers: { apikey: config.key, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new SupabaseError(503, "network_error");
    }
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = z.object({ code: z.string().optional(), error_code: z.string().optional() }).safeParse(data);
      throw new SupabaseError(response.status, error.success ? error.data.code ?? error.data.error_code ?? "request_failed" : "request_failed");
    }
    return data;
  };
}

export const authUserSchema = z.object({
  id: z.string().uuid(),
  app_metadata: z.object({ role: z.string().optional() }).passthrough(),
  is_anonymous: z.boolean().optional(),
});
export const tokenSchema = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(), user: authUserSchema,
});

export function clinicianRole(user: z.infer<typeof authUserSchema>): "clinician" | "admin" | null {
  if (user.is_anonymous) return null;
  const role = user.app_metadata.role;
  return role === "clinician" || role === "admin" ? role : null;
}
