import "server-only";
import { getEnv } from "@/server/config/env";

export interface ClinicianSession {
  clinicianId: string;
  roles: ReadonlyArray<"clinician" | "admin">;
}

export class AuthError extends Error {
  constructor(readonly code: "unauthenticated" | "forbidden", message: string) {
    super(message);
  }
}

/**
 * Server-side authorization gate for every protected clinical route.
 * The dev mode identity only works outside production. Supabase Auth is a Codex task.
 */
export async function requireClinician(): Promise<ClinicianSession> {
  const env = getEnv();
  if (env.AUTH_MODE === "dev" && env.NODE_ENV !== "production") {
    return { clinicianId: "dev-clinician", roles: ["clinician"] };
  }
  throw new AuthError("unauthenticated", "Authentication is not configured");
}
