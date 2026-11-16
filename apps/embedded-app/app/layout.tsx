import type { Metadata } from "next";
import { LocaleProvider } from "@/apps/embedded-app/i18n/client";
import { dirOf, messages } from "@/apps/embedded-app/i18n/messages";
import { getLocale } from "@/apps/embedded-app/i18n/server";
import { arabic, latin } from "./fonts";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = messages[await getLocale()];
  return { title: t.appName, description: t.description, robots: { index: false, follow: false } };
}

/**
 * English or Arabic: the clinician's choice, else the hospital's default (UI_DEFAULT_LOCALE).
 * The layout uses logical CSS properties throughout, so `dir` alone mirrors it.
 */
export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = await getLocale();
  return (
    <html lang={locale} dir={dirOf(locale)} className={`${latin.variable} ${arabic.variable}`}>
      <body className="antialiased"><LocaleProvider locale={locale}>{children}</LocaleProvider></body>
    </html>
  );
}
