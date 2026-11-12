import "server-only";
import { getEnv } from "@/platform/tenants/env";
import { mockProvider } from "@/core/agent/providers/mock-provider";
import { createOpenAIProvider, type ModelCallEvent } from "@/core/agent/providers/openai-provider";
import { createSpendingLimiter } from "@/core/agent/providers/spending";
import type { ModelProvider, SpendingLimiter } from "@/core/agent/providers/types";

export type { ModelProvider, ModelRequest, ModelResult, ModelMessage } from "@/core/agent/providers/types";

// One limiter per server instance, so the daily limit spans every request it handles.
const globals = globalThis as typeof globalThis & { stetholinkModelBudget?: SpendingLimiter };

function budget() {
  return globals.stetholinkModelBudget ??= createSpendingLimiter(getEnv().AI_DAILY_BUDGET_USD);
}

/** Metrics only. Prompts, chart content, model output and credentials are never logged. */
function observe(event: ModelCallEvent) {
  console.info(JSON.stringify({ action: "model.call", ...event, at: new Date().toISOString() }));
}

/** The only place a concrete provider is chosen. Add new providers here. */
export function getModelProvider(): ModelProvider {
  const env = getEnv();
  switch (env.AI_PROVIDER) {
    case "openai":
      return createOpenAIProvider({
        apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL,
        timeoutMs: env.OPENAI_TIMEOUT_MS, maxRetries: env.OPENAI_MAX_RETRIES,
        maxInputTokens: env.OPENAI_MAX_INPUT_TOKENS, maxOutputTokens: env.OPENAI_MAX_OUTPUT_TOKENS,
        maxCostUsd: env.OPENAI_MAX_COST_USD, reasoningEffort: env.OPENAI_REASONING_EFFORT,
        inputUsdPerMillion: env.OPENAI_INPUT_USD_PER_MILLION, outputUsdPerMillion: env.OPENAI_OUTPUT_USD_PER_MILLION,
      }, fetch, { budget: budget(), observe });
    case "mock":
      return mockProvider;
  }
}

/** What the interface may say about the configured assistant. No secrets. */
export function describeAssistant() {
  const env = getEnv();
  const live = env.AI_PROVIDER !== "mock";
  return { provider: env.AI_PROVIDER, model: live ? env.OPENAI_MODEL : "mock-1", liveInference: live, configured: !live || Boolean(env.OPENAI_API_KEY && env.OPENAI_INPUT_USD_PER_MILLION && env.OPENAI_OUTPUT_USD_PER_MILLION) };
}
