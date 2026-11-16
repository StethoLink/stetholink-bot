import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, handleRouteError, readJson } from "@/apps/embedded-app/server";
import { isLocale, localeCookie } from "@/apps/embedded-app/i18n/messages";
import { cookieOptions, requireSameOrigin } from "@/platform/auth/session";

const bodySchema = z.object({ locale: z.string().refine(isLocale) }).strict();

/** Remembers the interface language. It holds "en" or "ar" and nothing about the clinician or the chart. */
export async function POST(request: Request) {
  try {
    await requireSameOrigin();
    const body = bodySchema.safeParse(await readJson(request));
    if (!body.success) return errorResponse("invalid_request", "Unknown language");
    (await cookies()).set(localeCookie, body.data.locale, cookieOptions(60 * 60 * 24 * 365));
    return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleRouteError(error);
  }
}
