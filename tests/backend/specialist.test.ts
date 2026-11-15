import { describe, expect, it } from "vitest";
import { createPortalTransport } from "@/integrations/providers/portal";
import { allowRequest } from "@/platform/http/rate-limit";
import { parseEnv, providerDirectory, specialistMap } from "@/platform/tenants/env";
import { specialistResponseRequestSchema } from "@/shared/schemas";

/** Every service, specialist and address here is fictional. */
const directory = JSON.stringify([{ id: "fictional-cardiology-service", displayName: "Fictional Cardiology Service", specialties: ["Cardiology"], transport: "portal" }]);
const specialist = { specialistId: "77777777-7777-4777-8777-777777777771", providerId: "fictional-cardiology-service", displayName: "Dr Fictional" };

describe("provider directory and specialist configuration", () => {
  it("accepts in-hospital inbox services and refuses the simulated specialist", () => {
    expect(providerDirectory(parseEnv({ PROVIDER_DIRECTORY: directory }))).toEqual([expect.objectContaining({ id: "fictional-cardiology-service", transport: "portal", active: true })]);
    expect(() => parseEnv({ PROVIDER_DIRECTORY: JSON.stringify([{ id: "synthetic-cardiology", displayName: "x", specialties: ["Cardiology"], transport: "portal" }]) })).toThrow(/synthetic/);
    expect(() => parseEnv({ PROVIDER_DIRECTORY: JSON.stringify([{ id: "a", displayName: "x", specialties: ["Cardiology"], transport: "mock" }]) })).toThrow(/expected format/);
    expect(() => parseEnv({ PROVIDER_DIRECTORY: "not json" })).toThrow(/not valid JSON/);
  });
  it("ties the allowlist and every specialist to a configured service", () => {
    expect(() => parseEnv({ PROVIDER_DIRECTORY: directory, PROVIDER_ALLOWLIST: "another-service" })).toThrow(/PROVIDER_ALLOWLIST/);
    expect(() => parseEnv({ PROVIDER_DIRECTORY: directory, SPECIALIST_MAP: JSON.stringify([{ ...specialist, providerId: "another-service", email: "dr@example.test" }]) })).toThrow(/SPECIALIST_MAP/);
    expect(() => parseEnv({ PROVIDER_DIRECTORY: directory, SPECIALIST_MAP: JSON.stringify([specialist]) })).toThrow(/expected format/);
    expect(() => parseEnv({ PROVIDER_DIRECTORY: directory, SPECIALIST_MAP: JSON.stringify([{ ...specialist, subject: "sub" }]) })).toThrow(/expected format/);
    const env = parseEnv({ PROVIDER_DIRECTORY: directory, PROVIDER_ALLOWLIST: "fictional-cardiology-service",
      SPECIALIST_MAP: JSON.stringify([{ ...specialist, subject: "fic-sub", fhirUser: "Practitioner/fic-1" }, { ...specialist, specialistId: "77777777-7777-4777-8777-777777777772", email: "Dr.Fictional@example.test" }]) });
    expect(specialistMap(env)).toHaveLength(2);
  });
  it("never prints sign-in codes to the log in production", () => {
    expect(() => parseEnv({ NODE_ENV: "production", EMAIL_PROVIDER: "console" })).toThrow(/refused in production/);
    expect(parseEnv({ EMAIL_PROVIDER: "console" }).EMAIL_PROVIDER).toBe("console");
  });
});

describe("portal transport", () => {
  const envelope = {
    contractVersion: "1.0" as const, tenantId: "fictional", providerId: "fictional-cardiology-service", specialty: "Cardiology", reason: null, question: "Fictional question?",
    summary: "Consultation request: Cardiology", assessment: "", plan: [], clinicalFacts: [], missingInformation: [], attachments: [], safetyFlags: ["clinician_review_required" as const],
    approval: { approvedBy: "55555555-5555-4555-8555-555555555555", approvedAt: "2026-03-02T09:00:00.000Z" }, dataClassification: "live" as const,
    requestId: "9f6b7c1e-1c1f-4c58-9a57-0d7f6f0d1a11", attempt: 1,
  };
  it("acknowledges the stored request under its own id, the same way every time", async () => {
    const transport = createPortalTransport();
    const first = await transport.send(envelope);
    expect(first).toEqual({ requestId: envelope.requestId, providerReference: `inbox:${envelope.requestId}` });
    expect(await transport.send(envelope)).toEqual(first);
    await expect(transport.send({ ...envelope, requestId: "not-a-uuid" })).rejects.toMatchObject({ code: "transport_error" });
  });
});

describe("specialist replies and request limits", () => {
  it("needs a reason to decline and a summary to report; the sender is never taken from the body", () => {
    const key = "9f6b7c1e-1c1f-4c58-9a57-0d7f6f0d1a11";
    expect(specialistResponseRequestSchema.safeParse({ kind: "accepted", idempotencyKey: key }).success).toBe(true);
    expect(specialistResponseRequestSchema.safeParse({ kind: "rejected", idempotencyKey: key }).success).toBe(false);
    expect(specialistResponseRequestSchema.safeParse({ kind: "report", summary: "", recommendations: [], idempotencyKey: key }).success).toBe(false);
    expect(specialistResponseRequestSchema.safeParse({ kind: "accepted", idempotencyKey: key, providerId: "another-service" }).success).toBe(false);
    expect(specialistResponseRequestSchema.safeParse({ kind: "report", summary: "Fictional opinion.", recommendations: ["Fictional advice"], idempotencyKey: key, responder: "Someone else" }).success).toBe(false);
  });
  it("limits requests per key inside a window and starts again in the next", () => {
    const key = `test:${crypto.randomUUID()}`;
    expect([1, 2, 3, 4].map(() => allowRequest(key, 3, 60_000, 1_000))).toEqual([true, true, true, false]);
    expect(allowRequest(key, 3, 60_000, 62_000)).toBe(true);
    expect(allowRequest(`${key}:other`, 3, 60_000, 1_000)).toBe(true);
  });
});
