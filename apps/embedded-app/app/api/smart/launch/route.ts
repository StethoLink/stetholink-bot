import { NextResponse } from "next/server";
import { errorResponse, handleRouteError } from "@/apps/embedded-app/server";
import { openSmartLaunch } from "@/platform/auth/smart-session";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    if (params.getAll("iss").length !== 1 || params.getAll("launch").length !== 1 || (params.get("iss")?.length ?? 0) > 2048) return errorResponse("invalid_request", "Invalid SMART launch");
    const url = await openSmartLaunch(params.get("iss") ?? "", params.get("launch") ?? "");
    return NextResponse.redirect(url, { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  } catch (error) {
    return handleRouteError(error);
  }
}
