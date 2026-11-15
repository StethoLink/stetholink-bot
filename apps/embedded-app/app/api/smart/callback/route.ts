import { NextResponse } from "next/server";
import { launchErrorResponse, refuseLaunch } from "@/apps/embedded-app/server/http/launch-error";
import { newCorrelationId } from "@/platform/auth/smart-launch-failure";
import { finishSmartLaunch } from "@/platform/auth/smart-session";

export async function GET(request: Request) {
  // One ID per request: on the error page for the clinician, and on the log line with the reason for the administrator.
  const correlationId = newCorrelationId();
  try {
    const params = new URL(request.url).searchParams;
    // The EHR's own error text is an OAuth parameter and stays out of the log.
    if (params.has("error")) return await refuseLaunch(request, "callback", "authorization_denied", "Invalid SMART callback", correlationId);
    if (params.getAll("code").length !== 1 || params.getAll("state").length !== 1 ||
        (params.get("code")?.length ?? 0) > 4096 || !/^[\w-]{43}$/.test(params.get("state") ?? "")) {
      return await refuseLaunch(request, "callback", "callback_malformed", "Invalid SMART callback", correlationId);
    }
    const destination = await finishSmartLaunch({ code: params.get("code") ?? "", state: params.get("state") ?? "" }, correlationId);
    return new NextResponse(null, {
      status: 303, headers: { Location: destination, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  } catch (error) {
    return launchErrorResponse(request, error, correlationId);
  }
}
