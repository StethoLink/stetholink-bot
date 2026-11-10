import { NextResponse } from "next/server";
import { handleRouteError, requireClinician } from "@/apps/embedded-app/server";
import { openSmartLaunch } from "@/platform/auth/smart-session";

export async function GET(request: Request) {
  try {
    const session = await requireClinician({ navigation: true });
    const params = new URL(request.url).searchParams;
    const url = await openSmartLaunch(session, params.get("iss") ?? "", params.get("launch") ?? "");
    return NextResponse.redirect(url, { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  } catch (error) {
    return handleRouteError(error);
  }
}
