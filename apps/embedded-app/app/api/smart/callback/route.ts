import { NextResponse } from "next/server";
import { errorResponse, handleRouteError } from "@/apps/embedded-app/server";
import { finishSmartLaunch } from "@/platform/auth/smart-session";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    if (params.has("error") || params.getAll("code").length !== 1 || params.getAll("state").length !== 1 ||
        (params.get("code")?.length ?? 0) > 4096 || !/^[\w-]{43}$/.test(params.get("state") ?? "")) return errorResponse("invalid_request", "Invalid SMART callback");
    await finishSmartLaunch({ code: params.get("code") ?? "", state: params.get("state") ?? "" });
    return new NextResponse(null, {
      status: 303, headers: { Location: "/embed", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
