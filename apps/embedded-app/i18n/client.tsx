"use client";
import { createContext, useContext, type ReactNode } from "react";
import { dirOf, messages, type Locale } from "./messages";

const LocaleContext = createContext<Locale>("en");

export function LocaleProvider({ locale, children }: { locale: Locale; children?: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

/** The interface texts of the chosen language. Without a provider (unit tests) it is English. */
export function useT() {
  const locale = useContext(LocaleContext);
  return { t: messages[locale], locale, dir: dirOf(locale) } as const;
}
