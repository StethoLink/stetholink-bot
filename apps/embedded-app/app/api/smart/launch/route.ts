import { NextResponse } from "next/server";
import { launchErrorResponse, refuseLaunch } from "@/apps/embedded-app/server/http/launch-error";
import { newCorrelationId } from "@/platform/auth/smart-launch-failure";
import { openSmartLaunch } from "@/platform/auth/smart-session";

export async function GET(request: Request) {
  const correlationId = newCorrelationId();
  try {
    const params = new URL(request.url).searchParams;
    if (params.getAll("iss").length !== 1 || params.getAll("launch").length !== 1 || (params.get("iss")?.length ?? 0) > 2048) {
      return await refuseLaunch(request, "launch", "launch_malformed", "Invalid SMART launch", correlationId);
    }
    const url = await openSmartLaunch(params.get("iss") ?? "", params.get("launch") ?? "", correlationId);
    return NextResponse.redirect(url, { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  } catch (error) {
    return launchErrorResponse(request, error, correlationId);
  }
}
