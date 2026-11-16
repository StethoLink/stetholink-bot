import { NextResponse, type NextRequest } from "next/server";
import { securityHeaders } from "@/platform/http/security-headers";

/**
 * Every response says who may frame StethoLink (the tenant's EHR only) and that the page loads and calls
 * nothing outside its own origin. The settings are read per request, at run time: the image is built without them.
 */
export function middleware(request: NextRequest) {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const headers = securityHeaders(process.env, nonce);
  // Next reads the nonce for its own inline scripts from the policy on the request.
  const forwarded = new Headers(request.headers);
  forwarded.set("x-nonce", nonce);
  forwarded.set("Content-Security-Policy", headers["Content-Security-Policy"]);
  const response = NextResponse.next({ request: { headers: forwarded } });
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

export const config = { runtime: "nodejs", matcher: "/:path*" };
