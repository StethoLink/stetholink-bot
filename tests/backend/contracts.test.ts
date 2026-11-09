import { describe, expect, it } from "vitest";
import { syntheticDrafts, syntheticEncounters, syntheticPatients } from "@/shared/mocks/synthetic-data";
import { consultationDraftSchema, encounterContextSchema, patientContextSchema } from "@/shared/schemas";

describe("synthetic fixtures satisfy contracts", () => {
  it("validates all fixtures", () => {
    syntheticPatients.forEach((p) => {
      expect(patientContextSchema.parse(p).source).toBe("synthetic");
    });
    syntheticEncounters.forEach((e) => encounterContextSchema.parse(e));
    syntheticDrafts.forEach((d) => consultationDraftSchema.parse(d));
  });
});
