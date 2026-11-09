import "server-only";
import { getEnv } from "@/server/config/env";
import { mockProvider } from "./mock-provider";
import { createOpenAIProvider } from "./openai-provider";
import type { ModelProvider } from "./types";

export type { ModelProvider, ModelRequest, ModelResult, ModelMessage } from "./types";

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
