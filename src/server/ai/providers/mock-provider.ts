import type { ModelProvider } from "./types";

/** Deterministic provider for development and tests. Makes no network calls. */
export const mockProvider: ModelProvider = {
  name: "mock",
  async generate({ messages }) {
    const last = messages.findLast((m) => m.role === "user")?.content ?? "";
    return { text: `[mock] Received: ${last}`, provider: "mock", model: "mock-1" };
  },
};
