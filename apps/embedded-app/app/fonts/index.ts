import localFont from "next/font/local";

/**
 * IBM Plex Sans Arabic (SIL Open Font License, see LICENSE.txt), served from this application.
 * Nothing is fetched from a font CDN at build time or at run time: hospital networks are often closed.
 * The Latin and Arabic subsets are separate files, so an English page never downloads the Arabic glyphs.
 */
export const latin = localFont({
  variable: "--font-latin", display: "swap",
  src: [
    { path: "./plex-latin-400.woff2", weight: "400", style: "normal" },
    { path: "./plex-latin-500.woff2", weight: "500", style: "normal" },
    { path: "./plex-latin-600.woff2", weight: "600", style: "normal" },
  ],
  declarations: [{ prop: "unicode-range", value: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD" }],
});
export const arabic = localFont({
  variable: "--font-arabic", display: "swap", preload: false,
  src: [
    { path: "./plex-arabic-400.woff2", weight: "400", style: "normal" },
    { path: "./plex-arabic-500.woff2", weight: "500", style: "normal" },
    { path: "./plex-arabic-600.woff2", weight: "600", style: "normal" },
  ],
  declarations: [{ prop: "unicode-range", value: "U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0897-08E1,U+08E3-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC" }],
});
