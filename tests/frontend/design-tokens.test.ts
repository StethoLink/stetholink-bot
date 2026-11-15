import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** WCAG 2.2 AA: 4.5:1 for text, 3:1 for the boundary of an input. Pairs are the ones the components use. */
const css = readFileSync(new URL("../../apps/embedded-app/app/globals.css", import.meta.url), "utf8");
const token = (name: string) => {
  if (name === "white") return "#ffffff";
  const match = new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, "i").exec(css);
  if (!match) throw new Error(`Unknown token ${name}`);
  return match[1];
};
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(token(a)), luminance(token(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("design tokens", () => {
  it.each([
    ["slate-900", "white"], ["slate-700", "white"], ["slate-700", "slate-50"], ["slate-600", "white"], ["slate-600", "slate-50"], ["slate-800", "slate-100"],
    ["white", "sky-700"], ["white", "sky-800"], ["sky-800", "white"], ["sky-900", "sky-50"], ["sky-950", "sky-50"],
    ["white", "emerald-700"], ["emerald-900", "emerald-50"], ["emerald-800", "white"],
    ["white", "red-700"], ["red-900", "red-50"], ["red-800", "white"],
    ["amber-900", "amber-50"], ["amber-950", "amber-50"], ["amber-900", "white"],
    ["violet-950", "violet-50"],
  ])("text %s on %s meets 4.5:1", (foreground, background) => {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });
  it.each([["slate-500", "white"], ["sky-600", "white"], ["sky-700", "white"]])("boundary or focus ring %s on %s meets 3:1", (foreground, background) => {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(3);
  });
  it("loads no font or stylesheet from another origin", () => {
    expect(css).not.toMatch(/https?:\/\//);
  });
});
