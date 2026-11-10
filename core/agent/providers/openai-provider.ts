import type { ModelProvider } from "./types";
import { RouteError } from "@/core/errors";

export function createOpenAIProvider(config: { apiKey?: string; model: string }, request: typeof fetch = fetch): ModelProvider {
  return {
    name: "openai",
    async generate(input) {
      if (!config.apiKey) throw new RouteError("provider_unavailable", "OpenAI is not configured");
      try {
        const response = await request("https://api.openai.com/v1/responses", {
          method: "POST",
          redirect: "error",
          headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: config.model, instructions: input.instructions, input: input.messages, store: false }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error("Provider request failed");
        const result = await response.json() as {
          status?: string;
          model?: string;
          output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
        };
        const text = result.output?.flatMap((item) => item.type === "message" ? item.content ?? [] : [])
          .filter((part) => part.type === "output_text").map((part) => part.text ?? "").join("").trim();
        if (result.status !== "completed" || !text) throw new Error("Provider response incomplete");
        return { text, model: result.model ?? config.model, provider: "openai" };
      } catch {
        throw new RouteError("provider_unavailable", "OpenAI could not generate a response");
      }
    },
  };
}
