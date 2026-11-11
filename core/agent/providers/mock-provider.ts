import type { ModelProvider } from "./types";

/** Deterministic provider for development and tests. Makes no network calls. */
export const mockProvider: ModelProvider = {
  name: "mock",
  async generate({ messages, structuredOutput }) {
    const last = messages.findLast((m) => m.role === "user")?.content ?? "";
    if (structuredOutput?.name === "consultation_evidence_selection") {
      const context = JSON.parse(last) as { eligibleEvidenceIds: string[] };
      return { text: JSON.stringify({ evidenceIds: context.eligibleEvidenceIds }), provider: "mock", model: "mock-1" };
    }
    return { text: `[mock] Received: ${last}`, provider: "mock", model: "mock-1" };
  },
};
