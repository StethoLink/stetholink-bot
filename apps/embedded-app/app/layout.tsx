import type { Metadata } from "next";
import { arabic, latin } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "StethoLink",
  description: "Clinical documentation and consultation assistant inside the patient chart",
};

/**
 * English, left to right, by default. The layout uses logical CSS properties throughout, so an
 * Arabic interface needs only `lang="ar" dir="rtl"` here once the texts are translated.
 */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" dir="ltr" className={`${latin.variable} ${arabic.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
