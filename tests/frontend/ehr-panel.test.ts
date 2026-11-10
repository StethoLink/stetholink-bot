import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EncounterSummaryView, PatientContextView, loadResource, type ResourceState } from "@/apps/embedded-app/features/ehr-panel";
import { createMockApiClient } from "@/shared/api-client";

// Vitest compiles JSX with the classic runtime until esbuild.jsx is set to "automatic".
(globalThis as { React?: typeof React }).React = React;

async function run<T>(load: () => Promise<T>) {
  const states: ResourceState<T>[] = [];
  await loadResource(load, (s) => states.push(s), "fallback");
  return states;
}

describe("loadResource", () => {
  const client = createMockApiClient();

  it("goes loading → ready", async () => {
    const s = await run(() => client.getPatientContext("syn-pt-001"));
    expect(s.map((x) => x.status)).toEqual(["loading", "ready"]);
  });

  it("surfaces API error messages", async () => {
    const s = await run(() => client.getEncounterContext("missing"));
    expect(s.at(-1)).toEqual({ status: "error", message: "Encounter not found" });
  });

  it("uses the fallback for unknown errors", async () => {
    const s = await run(() => Promise.reject(new Error("boom")));
    expect(s.at(-1)).toEqual({ status: "error", message: "fallback" });
  });

  it("ignores results once inactive", async () => {
    const states: ResourceState<number>[] = [];
    await loadResource(async () => 1, (x) => states.push(x), "f", () => false);
    expect(states.map((x) => x.status)).toEqual(["loading"]);
  });
});

describe("PatientContextView", () => {
  it("shows every allergy prominently, plus medications and the synthetic badge", async () => {
    const patient = await createMockApiClient().getPatientContext("syn-pt-001");
    const long = { ...patient, allergies: ["Penicillin", "Sulfonamides", "Latex", "Iodinated contrast", "Peanuts"] };
    const html = renderToStaticMarkup(createElement(PatientContextView, { patient: long }));
    expect(html).toContain('role="note"');
    expect(html).toContain("Allergies (5)");
    for (const a of long.allergies) expect(html).toContain(a);
    expect(html).toContain("Metformin 500 mg BID");
    expect(html).toContain("Synthetic data");
  });

  it("does not imply 'no known allergies' when the list is empty", async () => {
    const patient = await createMockApiClient().getPatientContext("syn-pt-002");
    const html = renderToStaticMarkup(createElement(PatientContextView, { patient }));
    expect(html).toContain("None recorded. Confirm with the patient");
  });

  it("omits the synthetic badge for non-synthetic sources", async () => {
    const patient = await createMockApiClient().getPatientContext("syn-pt-001");
    const html = renderToStaticMarkup(createElement(PatientContextView, { patient: { ...patient, source: "fhir" } }));
    expect(html).not.toContain("Synthetic data");
  });
});

describe("EncounterSummaryView", () => {
  it("shows type, status, reason and location", async () => {
    const encounter = await createMockApiClient().getEncounterContext("syn-enc-001");
    const html = renderToStaticMarkup(createElement(EncounterSummaryView, { encounter }));
    expect(html).toContain("Outpatient encounter · In progress");
    expect(html).toContain("Follow-up of glycemic control");
    expect(html).toContain("Internal Medicine Clinic");
  });
});
