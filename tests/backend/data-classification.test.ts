import { describe, expect, it } from "vitest";
import {
  classificationOfSource, consultationEnvelopeSchema, consultationGroundingSchema, dataClassificationSchema,
  providerCallbackSchema, storedConsultationEnvelopeSchema, storedProviderCallbackSchema,
} from "@/shared/schemas";

// Fictional data only. Nothing here describes a real person.
const provenance = { provider: "mock", model: "mock-1", promptVersion: "p", contextVersion: "c", encounterReference: null };
const grounding = { reason: null, question: null, specialty: null, evidenceIds: [], gaps: [], conflicts: [], safetyFlags: ["clinician_review_required"] };
const envelope = {
  contractVersion: "1.0", tenantId: "fictional-tenant", providerId: "fictional-provider", specialty: "Cardiology", reason: null,
  question: "Fictional question", summary: "Fictional summary", assessment: "", plan: [], clinicalFacts: [], missingInformation: [],
  attachments: [], safetyFlags: ["clinician_review_required"],
  approval: { approvedBy: "11111111-1111-4111-8111-111111111111", approvedAt: "2026-02-03T09:00:00.000Z" },
  requestId: "7b1f3c0e-5a55-4a0b-9d0c-2f1f8d7a9c11", attempt: 1,
};
const callback = {
  contractVersion: "1.0", requestId: envelope.requestId, providerId: "fictional-provider", responseId: "r1", kind: "accepted",
  sentAt: "2026-02-03T09:05:00.000Z",
};

describe("data classification contract", () => {
  it("has exactly two classifications and derives them from the data source", () => {
    expect(dataClassificationSchema.options).toEqual(["synthetic", "live"]);
    expect(classificationOfSource("synthetic")).toBe("synthetic");
    for (const source of ["fhir", "openemr", "ehr"] as const) expect(classificationOfSource(source)).toBe("live");
  });

  it.each(["synthetic", "live"] as const)("accepts %s provenance, envelopes and callbacks", (dataClassification) => {
    expect(consultationGroundingSchema.parse({ ...grounding, provenance: { ...provenance, dataClassification } }).provenance.dataClassification).toBe(dataClassification);
    expect(consultationEnvelopeSchema.parse({ ...envelope, dataClassification }).dataClassification).toBe(dataClassification);
    expect(providerCallbackSchema.parse({ ...callback, dataClassification }).dataClassification).toBe(dataClassification);
  });

  it("rejects missing or unknown classifications", () => {
    for (const dataClassification of [undefined, "production", true, null]) {
      expect(consultationGroundingSchema.safeParse({ ...grounding, provenance: { ...provenance, dataClassification } }).success).toBe(false);
      expect(consultationEnvelopeSchema.safeParse({ ...envelope, dataClassification }).success).toBe(false);
      expect(providerCallbackSchema.safeParse({ ...callback, dataClassification }).success).toBe(false);
    }
  });

  it("reads stored records written before classification as synthetic", () => {
    const legacy = consultationGroundingSchema.parse({ ...grounding, provenance: { ...provenance, syntheticOnly: true } });
    expect(legacy.provenance).toEqual({ ...provenance, dataClassification: "synthetic" });
    expect(storedConsultationEnvelopeSchema.parse({ ...envelope, syntheticOnly: true })).toMatchObject({ dataClassification: "synthetic" });
    expect(storedProviderCallbackSchema.parse({ ...callback, syntheticOnly: true })).toMatchObject({ dataClassification: "synthetic" });
  });

  it("does not accept the retired flag on new envelopes or inbound callbacks", () => {
    expect(consultationEnvelopeSchema.safeParse({ ...envelope, syntheticOnly: true }).success).toBe(false);
    expect(providerCallbackSchema.safeParse({ ...callback, syntheticOnly: true }).success).toBe(false);
  });

  it("never lets the retired flag override or accompany an explicit classification", () => {
    for (const schema of [storedConsultationEnvelopeSchema, consultationEnvelopeSchema]) {
      expect(schema.safeParse({ ...envelope, syntheticOnly: true, dataClassification: "live" }).success).toBe(false);
    }
    expect(storedProviderCallbackSchema.safeParse({ ...callback, syntheticOnly: true, dataClassification: "live" }).success).toBe(false);
    expect(consultationGroundingSchema.safeParse({ ...grounding, provenance: { ...provenance, syntheticOnly: true, dataClassification: "live" } }).success).toBe(false);
    // A false or malformed flag is not a classification.
    expect(consultationGroundingSchema.safeParse({ ...grounding, provenance: { ...provenance, syntheticOnly: false } }).success).toBe(false);
    expect(storedConsultationEnvelopeSchema.safeParse({ ...envelope, syntheticOnly: "true" }).success).toBe(false);
  });
});
