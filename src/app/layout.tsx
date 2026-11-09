// PROTECTED (integration owner). See docs/architecture/ARCHITECTURE.md §2.
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "StethoLink",
  description: "Clinical AI assistant for hospital workflows",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
