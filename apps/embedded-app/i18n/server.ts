import "server-only";
import { cookies } from "next/headers";
import { isLocale, localeCookie, type Locale } from "./messages";

/**
 * The clinician's choice (a cookie holding "en" or "ar"), else the hospital's default.
 * The cookie is read first so that a build never evaluates server configuration.
 */
export async function getLocale(): Promise<Locale> {
  const chosen = (await cookies()).get(localeCookie)?.value;
  if (isLocale(chosen)) return chosen;
  const fallback = process.env.UI_DEFAULT_LOCALE;
  return isLocale(fallback) ? fallback : "en";
}
