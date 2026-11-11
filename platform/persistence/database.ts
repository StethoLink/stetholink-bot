import "server-only";
import postgres from "postgres";
import { getEnv } from "@/platform/tenants/env";
import { RouteError } from "@/core/errors";

let connection: ReturnType<typeof postgres> | undefined;

export function database() {
  const env = getEnv();
  if (!env.STETHOLINK_DATABASE_URL) throw new RouteError("provider_unavailable", "Clinical session storage is unavailable");
  return connection ??= postgres(env.STETHOLINK_DATABASE_URL, {
    ssl: env.STETHOLINK_DATABASE_CA ? { ca: env.STETHOLINK_DATABASE_CA, rejectUnauthorized: true } :
      env.NODE_ENV === "production" ? "verify-full" : undefined,
    prepare: false,
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => undefined,
  });
}
