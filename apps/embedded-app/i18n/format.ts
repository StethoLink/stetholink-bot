import type { Locale } from "./messages";

/** Arabic dates and numbers are written with Latin digits in the Gregorian calendar, as the hospital's other systems do. */
export const dateLocale = (locale: Locale) => (locale === "ar" ? "ar-SA-u-ca-gregory-nu-latn" : undefined);

/** A date and time, or the text as it came when it is not a date. */
export function formatDateTime(iso: string, locale: Locale = "en"): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(dateLocale(locale), { dateStyle: "medium", timeStyle: "short" });
}

export function formatDate(iso: string, locale: Locale = "en"): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(dateLocale(locale), { dateStyle: "medium" });
}
