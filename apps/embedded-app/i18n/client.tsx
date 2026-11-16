"use client";
import { createContext, useContext, type ReactNode } from "react";
import { dirOf, messages, type Locale, type Messages } from "./messages";

const LocaleContext = createContext<Locale>("en");

/**
 * The language of this document, for code that builds a text outside a component (the failure texts of a request).
 * It is set in the browser only: a server render never reads it, so concurrent requests cannot mix languages.
 */
let documentLocale: Locale = "en";
export const currentMessages = (): Messages => messages[documentLocale];
export const currentLocale = (): Locale => documentLocale;

export function LocaleProvider({ locale, children }: { locale: Locale; children?: ReactNode }) {
  if (typeof window !== "undefined") documentLocale = locale;
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

/** The interface texts of the chosen language. Without a provider (unit tests) it is English. */
export function useT() {
  const locale = useContext(LocaleContext);
  return { t: messages[locale], locale, dir: dirOf(locale) } as const;
}
