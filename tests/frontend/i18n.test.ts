import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ClinicalFact, PatientContext } from "@/shared/contracts";
import { LocaleProvider } from "@/apps/embedded-app/i18n/client";
import { ar, dirOf, en, isLocale } from "@/apps/embedded-app/i18n/messages";
import { ErrorWithRetry, NotSharedNotice, PatientContextView, loadResource, partsNotShared, type ResourceState } from "@/apps/embedded-app/features/ehr-panel";
import { ApiClientError } from "@/shared/api-client";

const root = join(import.meta.dirname, "../..");
const inArabic = (node: ReactElement) => renderToStaticMarkup(createElement(LocaleProvider, { locale: "ar" }, node));
const ARABIC = /[؀-ۿ]/;

/** Every leaf of a dictionary as text; a text with parameters is called with sample values. */
function leaves(value: unknown, path = ""): [string, string][] {
  if (typeof value === "string") return [[path, value]];
  if (typeof value === "function") return [[path, String((value as (...args: unknown[]) => string)("3", "2"))]];
  if (Array.isArray(value)) return value.flatMap((item, index) => leaves(item, `${path}[${index}]`));
  return Object.entries(value as object).flatMap(([key, item]) => leaves(item, path ? `${path}.${key}` : key));
}

describe("interface languages", () => {
  it("has an Arabic text for every English one", () => {
    expect(leaves(ar).map(([path]) => path)).toEqual(leaves(en).map(([path]) => path));
  });

  it("writes every Arabic text in Arabic, except product names and key names", () => {
    const allowed = /^(appName|language\.other|shortcuts\.items\[\d\]\[0\]|work\.composer\.ctrlEnter)$/;
    expect(leaves(ar).filter(([path, text]) => !allowed.test(path) && !ARABIC.test(text)).map(([path]) => path)).toEqual([]);
    expect(leaves(en).filter(([path, text]) => path !== "language.other" && ARABIC.test(text)).map(([path]) => path)).toEqual([]);
  });

  it("reads Arabic right to left and accepts only the two languages", () => {
    expect([dirOf("ar"), dirOf("en")]).toEqual(["rtl", "ltr"]);
    expect([isLocale("ar"), isLocale("en"), isLocale("fr"), isLocale(undefined)]).toEqual([true, true, false, false]);
  });
});

describe("right-to-left layout", () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? (name === "node_modules" || name === ".next" ? [] : files(path)) : [path];
    });
  }
  const ui = files(join(root, "apps/embedded-app")).filter((path) => /\.(tsx|css)$/.test(path));

  it("uses no left or right utility or property, so the whole interface mirrors with dir", () => {
    // Tailwind's physical utilities, and the physical CSS properties, in class strings and stylesheets.
    const physical = /(?<![\w-])(?:-?m[lr]|p[lr]|left|right|border-[lr]|rounded-(?:[lr]|t[lr]|b[lr])|text-(?:left|right)|float-(?:left|right)|scroll-[mp][lr])-(?:\[|\d|px|auto|full)|(?<![\w-])(?:text-(?:left|right)|float-(?:left|right)|border-[lr])(?![\w-])|(?:margin|padding|border)-(?:left|right)\s*:|(?<![\w-])(?:left|right)\s*:\s*[\d-]|text-align\s*:\s*(?:left|right)/;
    const hits = ui.flatMap((path) => readFileSync(path, "utf8").split("\n")
      .filter((line) => physical.test(line)).map((line) => `${relative(root, path)}: ${line.trim().slice(0, 90)}`));
    expect(hits).toEqual([]);
  });
});

const fact = (over: Partial<ClinicalFact> & Pick<ClinicalFact, "id" | "category" | "label">): ClinicalFact =>
  ({ status: "unknown", reason: "not_provided", source: { type: "fhir", reference: "x" }, timestamp: "2026-01-01T00:00:00Z", ...over } as ClinicalFact);
const withheld = [
  fact({ id: "a", category: "allergy", label: "Allergies (could not be loaded from the EHR)", source: { type: "fhir", reference: "AllergyIntolerance/not-loaded" } }),
  fact({ id: "m", category: "medication", label: "Active medication orders (could not be loaded from the EHR)", source: { type: "fhir", reference: "MedicationRequest/not-loaded" } }),
  fact({ id: "s", category: "symptom", label: "Chest pain", reason: "not_recorded" }),
];
// A fictional person, written in both scripts as an EHR may hold it.
const patient: PatientContext = {
  patientId: "fic-1", displayName: "سلمى الفارس", birthDate: "1980-05-01", sex: "female", source: "fhir",
  allergies: [], activeProblems: ["Hypertension"], medications: [], clinicalFacts: withheld,
} as PatientContext;

describe("a resource the EHR did not grant", () => {
  it("is named by part, and never counted when the EHR simply has no record", () => {
    expect(partsNotShared(withheld)).toEqual(["allergy", "medication"]);
    expect(partsNotShared([withheld[2]])).toEqual([]);
    expect(partsNotShared(undefined)).toEqual([]);
  });

  it("is announced with what it means for a draft and who can grant it", () => {
    const html = renderToStaticMarkup(createElement(NotSharedNotice, { facts: withheld }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Not loaded: allergies, medications.");
    expect(html).toContain("grant StethoLink read access");
    expect(renderToStaticMarkup(createElement(NotSharedNotice, { facts: [withheld[2]] }))).toBe("");
  });

  it("is not shown as 'no allergies recorded'", () => {
    const html = renderToStaticMarkup(createElement(PatientContextView, { patient }));
    expect(html).toContain("The EHR did not share the allergy list");
    expect(html).not.toContain("None recorded. Confirm with the patient");
  });

  it("reads in Arabic, with the chart's own entries in their own direction", () => {
    const html = inArabic(createElement(PatientContextView, { patient }));
    expect(html).toContain("لم يشارك النظام الطبي قائمة الحساسية");
    expect(html).toContain("لم يُحمَّل: الحساسية، الأدوية.");
    expect(html).toContain("<bdi>سلمى الفارس</bdi>");
    expect(html).toContain('<li dir="auto" class="break-words">Hypertension</li>');
    expect(html).toContain("أنثى");
  });
});

describe("an error with a reference", () => {
  const states = async (error: unknown) => {
    const seen: ResourceState<number>[] = [];
    await loadResource(() => Promise.reject(error), (state) => seen.push(state), "fallback");
    return seen.at(-1);
  };

  it("keeps the code and the server's reference", async () => {
    expect(await states(new ApiClientError("provider_unavailable", "Database is temporarily unavailable", 503, "3FA9-01BC-77D2")))
      .toEqual({ status: "error", message: "Database is temporarily unavailable", code: "provider_unavailable", reference: "3FA9-01BC-77D2" });
    expect(await states(new ApiClientError("not_found", "Encounter not found", 404))).toEqual({ status: "error", message: "Encounter not found", code: "not_found" });
  });

  it("shows the reference left to right and selectable, in both languages", () => {
    const props = { message: "Database is temporarily unavailable", code: "provider_unavailable" as const, reference: "3FA9-01BC-77D2", onRetry: () => undefined };
    const english = renderToStaticMarkup(createElement(ErrorWithRetry, props));
    expect(english).toContain("Database is temporarily unavailable");
    expect(english).toContain('Reference for your administrator: <code dir="ltr" class="font-semibold select-all">3FA9-01BC-77D2</code>');
    const arabic = inArabic(createElement(ErrorWithRetry, props));
    expect(arabic).toContain("خدمة يعتمد عليها StethoLink لا تستجيب");
    expect(arabic).not.toContain("Database is temporarily unavailable");
    expect(arabic).toContain('<code dir="ltr" class="font-semibold select-all">3FA9-01BC-77D2</code>');
    expect(arabic).toContain("أعد المحاولة");
  });

  it("shows no reference when the server logged none", () => {
    expect(renderToStaticMarkup(createElement(ErrorWithRetry, { message: "Encounter not found", onRetry: () => undefined }))).not.toContain("Reference");
  });
});
