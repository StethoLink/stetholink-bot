import "server-only";
import { getEnv } from "@/platform/tenants/env";
import { mockProvider } from "@/core/agent/providers/mock-provider";
import { createOpenAIProvider } from "@/core/agent/providers/openai-provider";
import type { ModelProvider } from "@/core/agent/providers/types";

export type { ModelProvider, ModelRequest, ModelResult, ModelMessage } from "@/core/agent/providers/types";

/** The only place a concrete provider is chosen. Add new providers here. */
export function getModelProvider(): ModelProvider {
  const env = getEnv();
  switch (env.AI_PROVIDER) {
    case "openai":
      return createOpenAIProvider({
        apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL,
        timeoutMs: env.OPENAI_TIMEOUT_MS, maxRetries: env.OPENAI_MAX_RETRIES,
        maxInputTokens: env.OPENAI_MAX_INPUT_TOKENS, maxOutputTokens: env.OPENAI_MAX_OUTPUT_TOKENS,
        maxCostUsd: env.OPENAI_MAX_COST_USD,
        inputUsdPerMillion: env.OPENAI_INPUT_USD_PER_MILLION, outputUsdPerMillion: env.OPENAI_OUTPUT_USD_PER_MILLION,
      });
    case "mock":
      return mockProvider;
  }
}
