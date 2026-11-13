import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ProviderTransportError, type ProviderTransport } from "@/core/routing/ports";
import { createHttpPartnerAdapter } from "@/integrations/providers/http-partner";
import { createMockSpecialistTransport, mockSpecialistCallback } from "@/integrations/mock/specialist";
import type { ConsultationEnvelope } from "@/shared/contracts";
import { omarClinicalFacts, omarMissingInformation } from "@/shared/mocks/synthetic-data";

// Fake transports only. No provider endpoint, credential or agreement exists; these tests show
// what an adapter must do before it can be considered for a real integration.
const SECRET = "synthetic-conformance-secret-0123456789abcdef";
const envelope = (providerId: string): ConsultationEnvelope => ({
  contractVersion: "1.0", requestId: "3b241101-e2bb-4255-8caf-4136c566a962", attempt: 1, tenantId: "synthetic-tenant", providerId,
  specialty: "Cardiology", reason: "Chest pain", question: "Possible acute coronary syndrome?", summary: "Synthetic summary", assessment: "", plan: [],
  clinicalFacts: omarClinicalFacts, missingInformation: omarMissingInformation, attachments: [], safetyFlags: ["clinician_review_required"],
  approval: { approvedBy: "11111111-1111-4111-8111-111111111111", approvedAt: "2026-02-03T09:00:00.000Z" }, dataClassification: "synthetic",
});
const partner = (request: typeof fetch, overrides = {}) => createHttpPartnerAdapter({ providerId: "partner-sandbox", endpoint: "https://provider.invalid/consultations", secret: SECRET, ...overrides }, request);
const ack = (body: unknown, status = 200) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));

/** What every transport must guarantee, whichever provider it talks to. */
function conformance(name: string, make: () => { transport: ProviderTransport; providerId: string }) {
  describe(`provider transport conformance: ${name}`, () => {
    it("acknowledges with the request id it was given and a provider reference", async () => {
      const { transport, providerId } = make();
      const result = await transport.send(envelope(providerId));
      expect(result.requestId).toBe(envelope(providerId).requestId);
      expect(result.providerReference).toMatch(/\S/);
    });
    it("is idempotent on the request id", async () => {
      const { transport, providerId } = make();
      expect(await transport.send(envelope(providerId))).toEqual(await transport.send(envelope(providerId)));
    });
    it("refuses a malformed envelope with a typed failure", async () => {
      const { transport, providerId } = make();
      await expect(transport.send({ ...envelope(providerId), patientName: "must never be sent" } as ConsultationEnvelope)).rejects.toBeInstanceOf(ProviderTransportError);
    });
  });
}
conformance("mock specialist", () => ({ transport: createMockSpecialistTransport(), providerId: "synthetic-cardiology" }));
conformance("HTTP partner (contract 1.0)", () => ({
  providerId: "partner-sandbox",
  transport: partner(vi.fn<typeof fetch>(async (_url, init) => Response.json({ requestId: JSON.parse(String(init!.body)).requestId, providerReference: "ref-" + JSON.parse(String(init!.body)).requestId }))),
}));

describe("HTTP partner adapter", () => {
  it("signs the exact body, sends an idempotency key and never follows redirects or sends the secret", async () => {
    const request = ack({ requestId: envelope("partner-sandbox").requestId, providerReference: "ref-1" }, 202);
    await partner(request).send(envelope("partner-sandbox"));
    const [url, init] = request.mock.calls[0];
    const headers = init!.headers as Record<string, string>;
    expect(String(url)).toBe("https://provider.invalid/consultations");
    expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
    expect(headers["Idempotency-Key"]).toBe(envelope("partner-sandbox").requestId);
    expect(headers["X-StethoLink-Signature"]).toBe(createHmac("sha256", SECRET).update(`${headers["X-StethoLink-Timestamp"]}.${init!.body}`).digest("hex"));
    expect(JSON.stringify([headers, init!.body])).not.toContain(SECRET);
    expect(JSON.parse(String(init!.body))).toEqual(envelope("partner-sandbox"));
  });

  it("only talks to HTTPS endpoints without embedded credentials, using a real secret", () => {
    const request = vi.fn<typeof fetch>();
    for (const overrides of [{ endpoint: "http://provider.invalid/x" }, { endpoint: "https://user:pass@provider.invalid/x" }, { endpoint: "https://provider.invalid/x?token=1" }, { secret: "short" }]) {
      expect(() => partner(request, overrides)).toThrow();
    }
    expect(() => partner(request, { endpoint: "http://127.0.0.1:9/x" })).not.toThrow();
  });

  it.each([
    ["an HTTP error", () => new Response("sensitive provider body", { status: 503 }), "transport_error"],
    ["a body that is not JSON", () => new Response("<html>"), "invalid_acknowledgement"],
    ["an acknowledgement for another request", () => Response.json({ requestId: "9c8b4d47-0d55-4d0f-9d0c-1c2a3b4c5d6e", providerReference: "x" }), "invalid_acknowledgement"],
    ["an acknowledgement without a reference", () => Response.json({ requestId: envelope("partner-sandbox").requestId }), "invalid_acknowledgement"],
  ] as const)("maps %s to a typed failure without leaking the provider's body", async (_name, respond, code) => {
    const failure = await partner(vi.fn<typeof fetch>(async () => respond())).send(envelope("partner-sandbox")).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderTransportError);
    expect(failure).toMatchObject({ code });
    expect((failure as Error).message).not.toContain("sensitive");
  });

  it("reports a network failure and a timeout distinctly", async () => {
    await expect(partner(vi.fn<typeof fetch>(async () => { throw new Error("socket hang up"); })).send(envelope("partner-sandbox"))).rejects.toMatchObject({ code: "transport_error" });
    const stalled = vi.fn<typeof fetch>((_url, init) => new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason))));
    await expect(partner(stalled, { timeoutMs: 20 }).send(envelope("partner-sandbox"))).rejects.toMatchObject({ code: "transport_timeout" });
  });

  it("refuses an envelope addressed to another provider before any request", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(partner(request).send(envelope("someone-else"))).rejects.toMatchObject({ code: "transport_error" });
    expect(request).not.toHaveBeenCalled();
  });

  it("polls for normalized events and drops those for other requests or providers", async () => {
    const mine = mockSpecialistCallback(envelope("partner-sandbox"), "accepted", "2026-02-03T09:05:00.000Z");
    const request = ack({ events: [mine, { ...mine, requestId: "9c8b4d47-0d55-4d0f-9d0c-1c2a3b4c5d6e", responseId: "other" }] });
    const adapter = partner(request);
    expect(await adapter.poll!({ requestId: mine.requestId, providerReference: "ref-1" })).toEqual([mine]);
    expect(String(request.mock.calls[0][0])).toBe(`https://provider.invalid/consultations/${mine.requestId}/events`);
    expect(() => adapter.normalize!({ ...mine, providerId: "someone-else" })).toThrow(ProviderTransportError);
    expect(() => adapter.normalize!({ ...mine, kind: "report" })).toThrow(ProviderTransportError);
    await expect(partner(ack({ events: [{ status: "done" }] })).poll!({ requestId: mine.requestId, providerReference: "ref-1" })).rejects.toBeInstanceOf(ProviderTransportError);
  });
});
