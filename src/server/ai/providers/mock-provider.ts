import type { AiProvider } from "@/shared/contracts";

/** Deterministic provider for local dev and tests. Real providers live beside it. */
export const mockProvider: AiProvider = {
  name: "mock",
  async complete({ messages }) {
    const last = messages.at(-1)?.content ?? "";
    return `[mock] Received: ${last}`;
  },
};
