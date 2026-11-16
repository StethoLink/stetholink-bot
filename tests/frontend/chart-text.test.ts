import { describe, expect, it } from "vitest";
import { ageText as demographicsAge } from "@/core/consultation/demographics";
import { normalizeChart } from "@/integrations/fhir/facts";
import { renderReferral } from "@/core/consultation/authoring";
import { ageText, chartNote, factLabel, missingLine, planNote } from "@/apps/embedded-app/i18n/chart-text";

const ARABIC = /[؀-ۿ]/;
const LATIN_WORDS = /[A-Za-z]{3,}/;

describe("the connector's own chart texts in Arabic", () => {
  it("translates every fact label it can write, and leaves a label the EHR wrote alone", () => {
    const labels = ["Allergies", "Active problems", "Active medication orders", "Vital signs in the last 14 days", "Laboratory results in the last 365 days",
      "Allergies (could not be loaded from the EHR)", "Active problems (could not be loaded from the EHR)", "Active medication orders (could not be loaded from the EHR)",
      "Vital signs (could not be loaded from the EHR)", "Laboratory results (could not be loaded from the EHR)"];
    for (const label of labels) {
      const arabic = factLabel(label, "ar");
      expect(arabic, label).toMatch(ARABIC);
      expect(arabic, label).not.toMatch(LATIN_WORDS);
      expect(factLabel(label, "en")).toBe(label);
    }
    expect(factLabel("Penicillin", "ar")).toBe("Penicillin");
    expect(factLabel("Type 2 diabetes mellitus without complications", "ar")).toBe("Type 2 diabetes mellitus without complications");
  });

  it("translates every note it can write", () => {
    const notes = [
      "Allergies could not be loaded from the EHR. Check them in the chart.",
      "Laboratory results could not be loaded from the EHR. Check them in the chart.",
      "The EHR holds more allergy records than StethoLink loads at once; the first 100 records were read. Check the chart for the rest.",
      "The EHR holds more medication orders than StethoLink loads at once; the first 100 records were read. Check the chart for the rest.",
      "The EHR holds more vital signs than StethoLink loads at once; the first 100 records were read. Check the chart for the rest.",
      "1 active medication order has no readable medication name and is not listed. Check the medication list in the chart.",
      "3 active medication orders have no readable medication name and are not listed. Check the medication list in the chart.",
      "2 vital signs records have no readable name or value and are not listed.",
      "1 laboratory results record has no readable name or value and is not listed.",
      "Loaded from the EHR: the latest value of each laboratory test from the last 365 days and of each vital sign from the last 14 days. Older results are not included.",
      "Only the 6 most recent vital signs are included here; 4 more are in the chart.",
      "Only the 6 most recent laboratory results are included here; 1 more is in the chart.",
      "2 chart items have no recorded date in the EHR; the date shown for them is the day the chart was loaded.",
      "1 chart item has no recorded date in the EHR; the date shown for it is the day the chart was loaded.",
    ];
    for (const note of notes) {
      const arabic = chartNote(note, "ar");
      expect(arabic, note).toMatch(ARABIC);
      // The product name is the one Latin word that stays.
      expect(arabic.replace(/StethoLink/g, ""), note).not.toMatch(/[A-Za-z]{3,}/);
      expect(chartNote(note, "en")).toBe(note);
    }
    // A sentence that is not the connector's own is shown as it came.
    expect(chartNote("Patient moved clinics in 2024.", "ar")).toBe("Patient moved clinics in 2024.");
  });

  it("is built from the sentences the connector writes, so a changed sentence fails here", () => {
    // The real connector's output in the three cases that write notes and labels: every read refused, nothing recorded, records too many or unreadable.
    const refused = { resources: [], failed: true, truncated: false };
    const empty = { resources: [], failed: false, truncated: false };
    const options = { now: new Date("2026-01-15T10:00:00Z"), windows: { vitalDays: 14, laboratoryDays: 365 }, factId: (prefix: string, key: string) => `${prefix}-${key}` };
    const outputs = [
      normalizeChart({ allergies: refused, conditions: refused, medications: refused, vitals: refused, laboratory: refused } as never, options),
      normalizeChart({ allergies: empty, conditions: empty, medications: empty, vitals: empty, laboratory: empty } as never, options),
    ];
    const texts = outputs.flatMap((built) => [...built.facts.map((fact) => fact.label), ...built.notes]);
    expect(texts.length).toBeGreaterThan(8);
    for (const text of texts) {
      const translated = text.endsWith(".") ? chartNote(text, "ar") : factLabel(text, "ar");
      expect(translated, text).not.toBe(text);
      expect(translated.replace(/StethoLink/g, ""), text).not.toMatch(/[A-Za-z]{3,}/);
    }
  });

  it("writes a patient's age in Arabic for every form the server uses", () => {
    const at = new Date("2026-06-01T00:00:00Z");
    for (const birth of ["1968-03-14", "1930-01-01", "2024-09-01", "2026-03-10", "2026-05-25"]) {
      const english = demographicsAge(birth, at) as string;
      expect(ageText(english, "ar"), english).toMatch(ARABIC);
      expect(ageText(english, "en")).toBe(english);
    }
    expect(ageText("58 years", "ar")).toBe("58 سنة");
    expect(ageText("not recorded", "ar")).toBe("غير مسجَّل");
  });

  it("translates the fixed lines the core writes into a draft, pinned to renderReferral's real output", () => {
    const missing = [{ id: "m1", category: "vital_sign", label: "Vital signs in the last 14 days", status: "unknown", reason: "not_recorded", source: { type: "fhir", reference: "x" }, timestamp: "2026-01-15T10:00:00Z" }];
    const withMissing = renderReferral({ specialty: "Cardiology", clinicalQuestion: "q?", sections: { relevantHistory: [], presentingSymptoms: [], examinationFindings: [], investigations: [], currentMedications: [], clinicalContext: [] }, suggestions: [] },
      { reasonForVisit: undefined, missing: missing as never, demographics: undefined } as never, ["Allergies could not be loaded from the EHR. Check them in the chart."]);
    const lines = withMissing.assessment.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2).replace(/\s*\[[^\]]*\]\s*$/, ""));
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(missingLine(line, "ar"), line).not.toBe(line);
      expect(missingLine(line, "ar").replace(/StethoLink/g, ""), line).not.toMatch(/[A-Za-z]{3,}/);
      expect(missingLine(line, "en")).toBe(line);
    }
    const none = renderReferral({ specialty: "Cardiology", clinicalQuestion: "q?", sections: { relevantHistory: [], presentingSymptoms: [], examinationFindings: [], investigations: [], currentMedications: [], clinicalContext: [] }, suggestions: [] },
      { reasonForVisit: undefined, missing: [], demographics: undefined } as never, []);
    const noneLine = none.assessment.split("\n")[1].slice(2);
    expect(missingLine(noneLine, "ar")).not.toBe(noneLine);
    const note = none.plan[none.plan.length - 1];
    expect(planNote(note, "ar")).toMatch(ARABIC);
    expect(planNote(note, "en")).toBe(note);
    expect(planNote("A physician's own line", "ar")).toBe("A physician's own line");
  });
});
