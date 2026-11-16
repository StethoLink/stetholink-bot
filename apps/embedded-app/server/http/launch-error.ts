import "server-only";
import { NextResponse } from "next/server";
import { logSmartLaunchFailure, type SmartLaunchReason } from "@/platform/auth/smart-launch-failure";
import { dirOf, isLocale, localeCookie, messages, type Locale } from "@/apps/embedded-app/i18n/messages";
import { errorResponse, handleRouteError } from "./respond";

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** The clinician's remembered language, else the hospital's default. There is no session yet, so only the cookie can say. */
function localeOf(request: Request): Locale {
  const chosen = new RegExp(`(?:^|;\\s*)${localeCookie}=(en|ar)(?:;|$)`).exec(request.headers.get("cookie") ?? "")?.[1];
  if (isLocale(chosen)) return chosen;
  return isLocale(process.env.UI_DEFAULT_LOCALE) ? process.env.UI_DEFAULT_LOCALE : "en";
}

/**
 * The answer to a failed SMART launch. The EHR opens the launch and callback URLs as page navigations
 * inside its own frame, so a browser gets a readable page there (no new window, nothing loaded from
 * elsewhere); any other client gets the usual JSON error. Both carry the correlation ID an administrator
 * matches to the `smart.launch_failed` log line.
 */
async function launchError(request: Request, failure: NextResponse, correlationId: string) {
  failure.headers.set("X-Correlation-Id", correlationId);
  if (!/\btext\/html\b/i.test(request.headers.get("accept") ?? "")) return failure;
  const { error } = await failure.json() as { error: { code: string; message: string } };
  // A condition the clinician can fix reads as an instruction, not as a refusal.
  const fixable = error.code === "unsupported_encounter";
  const locale = localeOf(request);
  const t = messages[locale].launch;
  // The server explains in English. In Arabic the explanation for the case is shown, with the server's words under it.
  const explanation = locale === "en"
    ? `<p>${escape(error.message)}</p>`
    : `<p>${escape(fixable ? t.visit : t.generic)}</p>${fixable && error.message !== messages.en.launch.visit ? `<p class="detail">${escape(t.detail)}:<bdi lang="en" dir="ltr">${escape(error.message)}</bdi></p>` : ""}`;
  // Colours and sizes are the design tokens of app/globals.css; system fonts, because this page loads no file at all.
  const page = `<!doctype html>
<html lang="${locale}" dir="${dirOf(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escape(fixable ? t.visitTitle : t.title)}</title>
<style>
body{margin:0;font:14px/1.5 "Segoe UI",Tahoma,system-ui,sans-serif;color:#171b23;background:#f6f7f9}
main{max-width:30rem;margin:0 auto;padding:1rem .75rem}
.card{background:#fff;border:1px solid #dfe3e8;border-inline-start:3px solid ${fixable ? "#8f5a07" : "#b3261e"};border-radius:.5rem;padding:.875rem}
h1{font-size:1rem;margin:0 0 .375rem}
p{margin:.375rem 0;overflow-wrap:anywhere}
.detail{font-size:.8125rem;color:#3c4452}
.detail bdi{display:block}
.ref{margin-top:.75rem;padding:.5rem .75rem;border:1px solid #c9cfd8;border-radius:.375rem;background:#f6f7f9;font-size:.8125rem;color:#3c4452}
code{font:600 .9375rem ui-monospace,Consolas,monospace;color:#171b23;user-select:all}
</style></head>
<body><main><div class="card" role="alert" data-state="${fixable ? "no-open-visit" : "launch-failed"}">
<h1>${escape(fixable ? t.visitTitle : t.title)}</h1>
${explanation}
${fixable ? "" : `<p>${escape(t.again)}</p>`}
<p class="ref">${escape(messages[locale].common.reference)}: <code dir="ltr">${escape(correlationId)}</code></p>
</div></main></body></html>`;
  return new NextResponse(page, {
    status: failure.status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Correlation-Id": correlationId },
  });
}

/** A failure the platform already logged with its reason. */
export function launchErrorResponse(request: Request, error: unknown, correlationId: string) {
  return launchError(request, handleRouteError(error, { correlationId }), correlationId);
}

/** A request refused in the route itself, before the platform saw it. */
export function refuseLaunch(request: Request, stage: "launch" | "callback", reason: SmartLaunchReason, message: string, correlationId: string) {
  logSmartLaunchFailure(stage, reason, correlationId);
  return launchError(request, errorResponse("invalid_request", message, { correlationId }), correlationId);
}
