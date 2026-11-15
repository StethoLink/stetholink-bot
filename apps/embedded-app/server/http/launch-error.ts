import "server-only";
import { NextResponse } from "next/server";
import { logSmartLaunchFailure, type SmartLaunchReason } from "@/platform/auth/smart-launch-failure";
import { errorResponse, handleRouteError } from "./respond";

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/**
 * The answer to a failed SMART launch. The EHR opens the launch and callback URLs as page navigations,
 * so a browser gets a readable page; any other client gets the usual JSON error. Both carry the
 * correlation ID an administrator matches to the `smart.launch_failed` log line.
 */
async function launchError(request: Request, failure: NextResponse, correlationId: string) {
  failure.headers.set("X-Correlation-Id", correlationId);
  if (!/\btext\/html\b/i.test(request.headers.get("accept") ?? "")) return failure;
  const { error } = await failure.json() as { error: { code: string; message: string } };
  // A condition the clinician can fix reads as an instruction, not as a refusal.
  const fixable = error.code === "unsupported_encounter";
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>StethoLink could not open</title>
<style>
body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#1a2330;background:#f6f8fa}
main{max-width:30rem;margin:0 auto;padding:1.5rem 1rem}
h1{font-size:1.25rem;margin:0 0 .5rem}
p{margin:.5rem 0}
.ref{margin-top:1.25rem;padding:.75rem;border:1px solid #c5ced8;border-radius:.5rem;background:#fff;font-size:.875rem;color:#3d4a5c}
code{font:600 1rem ui-monospace,monospace;color:#1a2330;user-select:all}
</style></head>
<body><main role="alert">
<h1>${fixable ? "StethoLink needs an open visit" : "StethoLink could not open"}</h1>
<p>${escape(error.message)}</p>
${fixable ? "" : "<p>Close this window and launch StethoLink from the patient's chart again. If it keeps failing, give the reference below to your system administrator.</p>"}
<p class="ref">Reference for your administrator: <code>${escape(correlationId)}</code></p>
</main></body></html>`;
  return new NextResponse(page, {
    status: failure.status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Correlation-Id": correlationId },
  });
}

/** A failure the platform already logged with its reason. */
export function launchErrorResponse(request: Request, error: unknown, correlationId: string) {
  return launchError(request, handleRouteError(error), correlationId);
}

/** A request refused in the route itself, before the platform saw it. */
export function refuseLaunch(request: Request, stage: "launch" | "callback", reason: SmartLaunchReason, message: string, correlationId: string) {
  logSmartLaunchFailure(stage, reason, correlationId);
  return launchError(request, errorResponse("invalid_request", message), correlationId);
}
