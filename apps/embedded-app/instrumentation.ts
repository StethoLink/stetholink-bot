/**
 * Validates server configuration when the server starts. A deployment that asks for live
 * clinical data without the full live configuration exits instead of serving requests.
 * The message names settings only, never their values.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getEnv } = await import("@/platform/tenants/env");
  try {
    getEnv();
  } catch (error) {
    console.error("StethoLink refused to start:", error instanceof Error ? error.message : "invalid server configuration");
    process.exit(1);
  }
}
