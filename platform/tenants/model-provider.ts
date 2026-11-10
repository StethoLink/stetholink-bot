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
      return createOpenAIProvider({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL });
    case "mock":
      return mockProvider;
  }
}
