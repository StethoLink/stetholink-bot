import { describe, expect, it } from "vitest";
import { ahmedClinicalFacts, ahmedConsultationRequest, ahmedEncounter, ahmedMissingInformation, ahmedPatient, syntheticDrafts, syntheticEncounters, syntheticPatients } from "@/shared/mocks/synthetic-data";
import { apiErrorSchema, approvalRequestSchema, attachmentReferenceSchema, clinicalFactSchema, clinicianIdentitySchema, consultationDraftSchema, consultationRequestSchema, encounterContextSchema, missingInformationSchema, patientContextSchema, providerIdSchema } from "@/shared/schemas";
import { API_ERROR_CODES } from "@/shared/constants";

describe("synthetic fixtures satisfy contracts", () => {
  it("validates all fixtures", () => {
    syntheticPatients.forEach((p) => {
      expect(patientContextSchema.parse(p).source).toBe("synthetic");
    });
    syntheticEncounters.forEach((e) => encounterContextSchema.parse(e));
    syntheticDrafts.forEach((d) => consultationDraftSchema.parse(d));
  });

  it("retains the two M0 patients and adds Ahmed with a matching cardiology encounter", () => {
    expect(syntheticPatients.map((p) => p.patientId)).toEqual(["syn-pt-001", "syn-pt-002", "syn-pt-ahmed", "syn-pt-omar"]);
    expect(patientContextSchema.parse(ahmedPatient)).toEqual(ahmedPatient);
    expect(encounterContextSchema.parse(ahmedEncounter)).toEqual(ahmedEncounter);
    expect(ahmedEncounter.patientId).toBe(ahmedPatient.patientId);
    expect(consultationRequestSchema.parse(ahmedConsultationRequest)).toEqual(ahmedConsultationRequest);
  });
});

describe("M1 clinical data contracts", () => {
  const missing = ahmedMissingInformation.find((f) => f.id === "ahmed-troponin")!;
  const known = ahmedClinicalFacts.find((f) => f.id === "ahmed-hypertension")!;
  const attachment = { id: "syn-attachment-001", contentType: "application/pdf", description: "Fictional reference only", source: known.source, timestamp: known.timestamp };

  it("preserves fact source, timestamp and explicit unknowns through JSON and schema parsing", () => {
    const parsed = patientContextSchema.parse(JSON.parse(JSON.stringify(ahmedPatient)));
    expect(parsed.clinicalFacts).toEqual(ahmedClinicalFacts);
    for (const fact of parsed.clinicalFacts!) {
      expect(fact.source).toEqual({ type: "synthetic", reference: "synthetic-case-ahmed-v1" });
      expect(fact.timestamp).toBe("2026-01-15T10:00:00.000Z");
    }
  });

  it("records only documented problems and medication names, with no invented doses or results", () => {
    const knownFacts = ahmedClinicalFacts.filter((f) => f.status === "known");
    expect(knownFacts.map((f) => f.label)).toEqual(["Essential hypertension", "Type 2 diabetes mellitus", "Metformin", "Amlodipine"]);
    expect(ahmedPatient.medications).toEqual(["Metformin (dose and schedule not provided)", "Amlodipine (dose and schedule not provided)"]);
    expect(ahmedPatient.birthDate).toBeUndefined();
    const investigations = ahmedClinicalFacts.filter((f) => f.category === "investigation");
    expect(investigations.map((f) => f.label)).toEqual(["ECG", "Troponin", "HbA1c", "Renal function", "Lipid profile"]);
    for (const fact of investigations) {
      expect(missingInformationSchema.parse(fact).reason).toBe("not_provided");
      expect(fact).not.toHaveProperty("value");
      expect(fact).not.toHaveProperty("unit");
    }
    expect(ahmedPatient.allergies).toEqual([]);
    expect(ahmedClinicalFacts).toContainEqual(expect.objectContaining({ category: "allergy", status: "unknown" }));
  });

  it.each([0, false, "Documented synthetic finding"])("preserves known value %s without treating it as missing", (value) => {
    expect(clinicalFactSchema.parse({ ...known, value })).toEqual({ ...known, value });
  });

  it.each([
    { ...known, source: undefined },
    { ...known, source: { type: "synthetic", reference: "" } },
    { ...known, timestamp: undefined },
    { ...known, timestamp: "2026-01-15" },
    { ...known, value: undefined },
    { ...known, value: " " },
    { ...known, value: Number.NaN },
    { ...known, value: Number.POSITIVE_INFINITY },
    { ...known, value: null },
    { ...known, status: "assumed" },
    { ...missing, reason: undefined },
    { ...missing, reason: "normal" },
    { ...missing, value: 0 },
    { ...missing, value: null },
    { ...missing, unit: "ng/L" },
  ])("rejects incomplete or contradictory facts (%#)", (fact) => {
    expect(clinicalFactSchema.safeParse(fact).success).toBe(false);
    expect(patientContextSchema.safeParse({ ...ahmedPatient, clinicalFacts: [fact] }).success).toBe(false);
    expect(encounterContextSchema.safeParse({ ...ahmedEncounter, clinicalFacts: [fact] }).success).toBe(false);
    expect(consultationDraftSchema.safeParse({ ...syntheticDrafts[0], clinicalFacts: [fact] }).success).toBe(false);
  });

  it.each(["not_recorded", "not_provided", "not_performed", "pending"])("supports missing reason %s without fabricating a value", (reason) => {
    expect(missingInformationSchema.parse({ ...missing, reason })).toEqual({ ...missing, reason });
  });

  it("retains evidence, missing information and attachment metadata on a draft without approving it", () => {
    const draft = { ...syntheticDrafts[0], patientId: ahmedPatient.patientId, encounterId: ahmedEncounter.encounterId, clinicalFacts: ahmedClinicalFacts, missingInformation: ahmedMissingInformation, attachments: [attachment] };
    expect(consultationDraftSchema.parse(draft)).toEqual(draft);
    expect(draft.status).toBe("pending_approval");
    expect(draft.reviewedBy).toBeUndefined();
    expect(draft.reviewedAt).toBeUndefined();
    expect(consultationDraftSchema.safeParse({ ...draft, missingInformation: [known] }).success).toBe(false);
  });

  it("validates attachment references as metadata only", () => {
    expect(attachmentReferenceSchema.parse(attachment)).toEqual(attachment);
    expect(attachmentReferenceSchema.safeParse({ ...attachment, contentType: "pdf" }).success).toBe(false);
    expect(attachmentReferenceSchema.safeParse({ ...attachment, url: "https://synthetic.example/attachment?token=fictional" }).success).toBe(false);
    expect(attachmentReferenceSchema.safeParse({ ...attachment, bytes: "fictional" }).success).toBe(false);
    expect(attachmentReferenceSchema.safeParse({ ...attachment, source: undefined }).success).toBe(false);
  });

  it("accepts a session identity projection and provider ID without accepting credentials", () => {
    expect(clinicianIdentitySchema.parse({ clinicianId: "syn-clinician", roles: ["clinician"], providerId: "syn-provider" }).providerId).toBe("syn-provider");
    expect(clinicianIdentitySchema.safeParse({ clinicianId: "syn-clinician", roles: ["patient"] }).success).toBe(false);
    expect(clinicianIdentitySchema.safeParse({ clinicianId: "syn-clinician", roles: [] }).success).toBe(false);
    expect(clinicianIdentitySchema.safeParse({ clinicianId: "syn-clinician", roles: ["clinician"], accessToken: "synthetic-token" }).success).toBe(false);
    expect(providerIdSchema.safeParse(" ").success).toBe(false);
    expect(providerIdSchema.safeParse("x".repeat(129)).success).toBe(false);
  });

  it("requires a question and specialty and excludes approval, delivery and identity from consultation intent", () => {
    expect(consultationRequestSchema.parse({ ...ahmedConsultationRequest, attachments: [attachment] }).attachments).toEqual([attachment]);
    for (const field of ["patientId", "specialty", "clinicalQuestion"]) {
      expect(consultationRequestSchema.safeParse({ ...ahmedConsultationRequest, [field]: " " }).success).toBe(false);
    }
    for (const field of ["clinicianId", "reviewedBy", "status", "recipientId", "decision"]) {
      expect(consultationRequestSchema.safeParse({ ...ahmedConsultationRequest, [field]: "forged" }).success).toBe(false);
    }
    const review = { draftId: "syn-draft", decision: "approve", expectedVersion: 1, idempotencyKey: "review-1" };
    expect(approvalRequestSchema.safeParse(review).success).toBe(false);
    expect(approvalRequestSchema.safeParse({ ...review, recipientId: "team-a", reviewedBy: "forged" }).success).toBe(false);
    expect(approvalRequestSchema.parse({ ...review, recipientId: "team-a" })).toEqual({ ...review, recipientId: "team-a" });
  });

  it.each(API_ERROR_CODES)("reuses the existing API error code %s", (code) => {
    expect(apiErrorSchema.parse({ error: { code, message: "Synthetic error", requestId: "syn-request" } }).error.code).toBe(code);
    expect(apiErrorSchema.safeParse({ error: { code: "unknown_error", message: "Synthetic" } }).success).toBe(false);
  });
});
