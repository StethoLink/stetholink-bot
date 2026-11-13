import type { ConsultationEnvelope, ProviderCallback, ProviderDescriptor } from "@/shared/contracts";
import { consultationEnvelopeSchema } from "@/shared/schemas";
import { ProviderTransportError, type ProviderTransport } from "@/core/routing/ports";

/** SYNTHETIC ONLY. These services do not exist; each one exercises one routing behaviour. */
export const syntheticProviderDirectory: ProviderDescriptor[] = [
  { id: "synthetic-cardiology", displayName: "Synthetic Cardiology Consult Service", specialties: ["Cardiology"], transport: "mock", active: true, synthetic: true },
  { id: "synthetic-cardiology-declines", displayName: "Synthetic Cardiology (declines requests)", specialties: ["Cardiology"], transport: "mock", active: true, synthetic: true },
  { id: "synthetic-cardiology-offline", displayName: "Synthetic Cardiology (unreachable)", specialties: ["Cardiology"], transport: "mock", active: true, synthetic: true },
  { id: "synthetic-radiology", displayName: "Synthetic Radiology Reporting Service", specialties: ["Radiology"], transport: "mock", active: true, synthetic: true },
  { id: "synthetic-cardiology-suspended", displayName: "Synthetic Cardiology (suspended)", specialties: ["Cardiology"], transport: "mock", active: false, synthetic: true },
];

/**
 * Stand-in for an external specialist's inbox. Stateless and deterministic: the same
 * request always yields the same reference, so a repeated send is received once.
 */
export function createMockSpecialistTransport(): ProviderTransport {
  return {
    kind: "mock",
    async send(envelope) {
      const received = consultationEnvelopeSchema.safeParse(envelope);
      if (!received.success) throw new ProviderTransportError("transport_error", "Mock specialist rejected a malformed envelope");
      // The simulator never receives real patient data, whatever the caller is configured for.
      if (received.data.dataClassification !== "synthetic") throw new ProviderTransportError("transport_error", "Mock specialist accepts synthetic requests only");
      if (received.data.providerId.endsWith("-offline")) throw new ProviderTransportError("transport_error", "Mock specialist is unreachable");
      return { requestId: received.data.requestId, providerReference: `mock-inbox-${received.data.requestId}` };
    },
  };
}

/**
 * The simulated specialist's next message for a request it received. The text restates
 * what was sent and what is missing; it never invents results, a diagnosis or treatment.
 */
export function mockSpecialistCallback(envelope: ConsultationEnvelope, step: "accepted" | "rejected" | "report", sentAt = new Date().toISOString()): ProviderCallback {
  const base = { contractVersion: "1.0", requestId: envelope.requestId, providerId: envelope.providerId,
    responseId: `${envelope.requestId}:${step}`, sentAt, dataClassification: envelope.dataClassification } as const;
  if (step === "accepted") return { ...base, kind: "accepted" };
  if (step === "rejected") return { ...base, kind: "rejected", reason: "Synthetic refusal: this simulated service is not accepting requests." };
  const known = envelope.clinicalFacts.filter((fact) => fact.status === "known").map((fact) => fact.label);
  const missing = envelope.missingInformation.map((fact) => fact.label);
  return {
    ...base, kind: "report",
    report: {
      responder: "Simulated specialist (synthetic, not a clinician)",
      summary: [
        `SYNTHETIC SPECIALIST RESPONSE for the ${envelope.specialty} request. This is test data, not clinical advice.`,
        `Question received: ${envelope.question}`,
        `Documented information received: ${known.length ? known.join("; ") : "none"}.`,
        `Information marked as not available: ${missing.length ? missing.join("; ") : "none"}.`,
      ].join("\n"),
      recommendations: missing.length
        ? ["Simulated reply: provide the items marked as not available so the request can be assessed.", "Simulated reply: no findings are stated because no results were supplied."]
        : ["Simulated reply: the request was complete as received."],
    },
  };
}

export function mockSpecialistNextStep(providerId: string, attemptStatus: string): "accepted" | "rejected" | "report" {
  if (providerId.endsWith("-declines")) return "rejected";
  return attemptStatus === "accepted" ? "report" : "accepted";
}
