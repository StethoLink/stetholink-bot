import "server-only";
import { getEnv } from "@/platform/tenants/env";
import { createOpenAIProvider, type ModelCallEvent } from "@/core/agent/providers/openai-provider";
import { createSpendingLimiter } from "@/core/agent/providers/spending";
import { createLedgerLimiter } from "@/platform/persistence/spend-ledger";
import type { ModelProvider, SpendingLimiter } from "@/core/agent/providers/types";
import type { ModelPrivacy } from "@/core/privacy/ports";
import { createPseudonymizingProvider } from "@/core/privacy/provider";
import { createMemoryVault } from "@/platform/privacy/vault";

export type { ModelProvider, ModelRequest, ModelResult, ModelMessage } from "@/core/agent/providers/types";

// One limiter per server instance, so the daily limit spans every request it handles.
const globals = globalThis as typeof globalThis & { stetholinkModelBudget?: SpendingLimiter };

/** The durable ledger. The in-process limit remains only for code run without a database (unit tests). */
export function spendingLimiter(kind: "model" | "transcription"): SpendingLimiter {
  const env = getEnv();
  if (env.STETHOLINK_DATABASE_URL) return createLedgerLimiter(env.TENANT_ID, kind, env.AI_DAILY_BUDGET_USD);
  return globals.stetholinkModelBudget ??= createSpendingLimiter(env.AI_DAILY_BUDGET_USD);
}
const budget = () => spendingLimiter("model");

/** Metrics only. Prompts, chart content, model output and credentials are never logged. */
function observe(event: ModelCallEvent) {
  console.info(JSON.stringify({ action: "model.call", ...event, at: new Date().toISOString() }));
}

/**
 * The only place a concrete provider is built, for every model task (consultation drafting, the
 * scribe's note and order drafting). What it returns is always the de-identification layer around the provider:
 * there is no way to get the bare provider from here, and the provider itself refuses a request
 * that did not pass through the layer. There is no stand-in: server configuration is refused at
 * startup without the provider's key and rates.
 */
export function getModelProvider(privacy: ModelPrivacy, task: "consultation" | "scribe_note" | "order_drafting" = "consultation"): ModelProvider {
  const env = getEnv();
  const scribe = task === "scribe_note";
  const provider = createOpenAIProvider({
    apiKey: env.OPENAI_API_KEY, model: scribe ? env.SCRIBE_NOTE_MODEL : env.OPENAI_MODEL,
    ...(env.OPENAI_BASE_URL ? { baseUrl: env.OPENAI_BASE_URL } : {}), allowLoopbackHttp: env.NODE_ENV !== "production",
    timeoutMs: env.OPENAI_TIMEOUT_MS, maxRetries: env.OPENAI_MAX_RETRIES,
    // A visit transcript is larger than a consultation request; the note has its own, cheaper model and bounds. One call per visit.
    ...(scribe ? {
      maxInputTokens: 120_000, maxOutputTokens: 12_000, maxCostUsd: Math.min(1, env.SCRIBE_MAX_VISIT_USD), reasoningEffort: env.SCRIBE_NOTE_REASONING_EFFORT,
      inputUsdPerMillion: env.SCRIBE_NOTE_INPUT_USD_PER_MILLION ?? env.OPENAI_INPUT_USD_PER_MILLION, outputUsdPerMillion: env.SCRIBE_NOTE_OUTPUT_USD_PER_MILLION ?? env.OPENAI_OUTPUT_USD_PER_MILLION,
    } : {
      // Order drafting sends the hospital's catalog with the chart, so it may have its own, larger input limit; every other bound is the consultation's.
      maxInputTokens: task === "order_drafting" ? env.ORDER_MAX_INPUT_TOKENS ?? env.OPENAI_MAX_INPUT_TOKENS : env.OPENAI_MAX_INPUT_TOKENS,
      maxOutputTokens: env.OPENAI_MAX_OUTPUT_TOKENS, maxCostUsd: env.OPENAI_MAX_COST_USD, reasoningEffort: env.OPENAI_REASONING_EFFORT,
      inputUsdPerMillion: env.OPENAI_INPUT_USD_PER_MILLION, outputUsdPerMillion: env.OPENAI_OUTPUT_USD_PER_MILLION,
    }),
    liveDataApproved: env.MODEL_LIVE_DATA_APPROVED === "true",
  }, fetch, { budget: budget(), observe });
  return createPseudonymizingProvider(provider, privacy, createMemoryVault());
}

/** What the interface may say about the configured assistant. No secrets. */
export function describeAssistant() {
  const env = getEnv();
  return { provider: env.AI_PROVIDER, model: env.OPENAI_MODEL };
}
