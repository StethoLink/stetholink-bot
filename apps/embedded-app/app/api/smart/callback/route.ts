import { NextResponse } from "next/server";
import { handleRouteError, requireClinician } from "@/apps/embedded-app/server";
import { finishSmartLaunch } from "@/platform/auth/smart-session";

export async function GET(request: Request) {
  try {
    const session = await requireClinician({ navigation: true });
    const params = new URL(request.url).searchParams;
    await finishSmartLaunch(session, { code: params.get("code") ?? "", state: params.get("state") ?? "" });
    return new NextResponse(null, {
      status: 303, headers: { Location: "/embed", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
