import type { ModelProvider } from "./types";

/**
 * Placeholder for the OpenAI Responses API integration (Codex task).
 * Intentionally makes no network calls yet.
 */
export function createOpenAIProvider(config: { apiKey?: string; model: string }): ModelProvider {
  return {
    name: "openai",
    async generate() {
      if (!config.apiKey) throw new Error("OPENAI_API_KEY is not configured");
      throw new Error("OpenAI provider is not implemented yet");
    },
  };
}
