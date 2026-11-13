import { z } from "zod";
import type { ModelProvider, SpendingLimiter } from "./types";
import { RouteError } from "@/core/errors";

const configSchema = z.object({
  apiKey: z.string().min(1).optional(), model: z.string().min(1).max(128),
  timeoutMs: z.number().int().min(1).max(60_000).default(30_000),
  maxRetries: z.number().int().min(0).max(2).default(1),
  maxInputTokens: z.number().int().min(1).max(32_000).default(16_000),
  maxOutputTokens: z.number().int().min(1).max(16_000).default(2048),
  // Sent only when set; reasoning models spend output tokens on reasoning.
  reasoningEffort: z.enum(["minimal", "low", "medium", "high"]).optional(),
  maxCostUsd: z.number().positive().max(1).default(0.1),
  // Explicit operator-supplied upper-bound rates; no guessed model pricing.
  inputUsdPerMillion: z.number().positive().max(1000).optional(),
  outputUsdPerMillion: z.number().positive().max(1000).optional(),
  // Operator statement (MODEL_LIVE_DATA_APPROVED) that this model deployment may process real
  // patient data. Without it only synthetic requests are sent.
  liveDataApproved: z.boolean().default(false),
});
export type OpenAIProviderConfig = z.input<typeof configSchema>;

/** Operational record of one generate call. Metrics and reason codes only: never prompts, outputs or keys. */
export interface ModelCallEvent {
  provider: "openai";
  model: string;
  task: string;
  outcome: "ok" | "error";
  reason?: "http_error" | "timeout" | "cost_limit" | "budget_limit" | "invalid_response" | "usage_exceeded" | "network_error";
  httpStatus?: number;
  attempts: number;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
}
export interface OpenAIProviderOptions {
  /** Cumulative limit across calls; the per-call limit is `maxCostUsd`. */
  budget?: SpendingLimiter;
  observe?(event: ModelCallEvent): void;
}
/** The only structured tasks this provider will run. Free-form chat is never sent. */
export const OPENAI_STRUCTURED_TASKS = ["consultation_evidence_selection", "consultation_referral"] as const;
class CallFailure extends Error {
  constructor(readonly reason: NonNullable<ModelCallEvent["reason"]>, readonly httpStatus?: number) { super(reason); }
}
const envelopeSchema = z.object({
  status: z.literal("completed"), model: z.string().min(1).max(256),
  output: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("reasoning") }),
    z.object({ type: z.literal("message"), role: z.literal("assistant"), status: z.literal("completed"), content: z.array(z.object({ type: z.literal("output_text"), text: z.string().min(1).max(32_000) })).min(1).max(1) }),
  ])).min(1).max(8),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
});
const transient = new Set([429, 500, 502, 503, 504]);
const RESPONSE_LIMIT = 256_000;

async function readBounded(response: Response) {
  if (!response.body) throw new Error("Missing response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT) throw new Error("Oversized response");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

export function createOpenAIProvider(config: OpenAIProviderConfig, request: typeof fetch = fetch, options: OpenAIProviderOptions = {}): ModelProvider {
  return {
    name: "openai",
    async generate(input) {
      const parsed = configSchema.safeParse(config);
      if (!parsed.success || !parsed.data.apiKey) throw new RouteError("provider_unavailable", "OpenAI is not configured");
      const settings = parsed.data;
      const task = input.structuredOutput?.name;
      if (!input.dataClassification || !task || !(OPENAI_STRUCTURED_TASKS as readonly string[]).includes(task)) {
        throw new RouteError("forbidden", "OpenAI is restricted to classified, structured consultation drafting");
      }
      // Live data is sent only to a deployment the operator approved for it. No fallback.
      if (input.dataClassification === "live" && !settings.liveDataApproved) {
        throw new RouteError("provider_unavailable", "The model provider is not approved for live clinical data (MODEL_LIVE_DATA_APPROVED)");
      }
      if (!settings.inputUsdPerMillion || !settings.outputUsdPerMillion) {
        throw new RouteError("provider_unavailable", "OpenAI cost bounds are not configured");
      }
      const inputRate = settings.inputUsdPerMillion;
      const outputRate = settings.outputUsdPerMillion;
      const body = JSON.stringify({
        model: settings.model, instructions: input.instructions, input: input.messages, store: false,
        max_output_tokens: settings.maxOutputTokens,
        ...(settings.reasoningEffort ? { reasoning: { effort: settings.reasoningEffort } } : {}),
        text: { format: { type: "json_schema", name: task, strict: true, schema: input.structuredOutput!.schema } },
      });
      // UTF-8 bytes plus overhead is a conservative token upper bound, including
      // instructions and schema. Reserve the maximum per attempt, even failed ones.
      const inputTokenBound = new TextEncoder().encode(body).length + 512;
      if (inputTokenBound > settings.maxInputTokens) throw new RouteError("provider_unavailable", "OpenAI input token limit exceeded");
      const attemptCost = (inputTokenBound * inputRate + settings.maxOutputTokens * outputRate) / 1_000_000;
      let reservedCost = 0;
      let attempts = 0;
      const started = Date.now();
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new CallFailure("timeout")); }, settings.timeoutMs);
      });
      async function run() {
        for (let attempt = 0; attempt <= settings.maxRetries; attempt++) {
          if (controller.signal.aborted) throw new CallFailure("timeout");
          if (reservedCost + attemptCost > settings.maxCostUsd) throw new CallFailure("cost_limit");
          let reservation: ReturnType<SpendingLimiter["reserve"]> | undefined;
          try { reservation = options.budget?.reserve(attemptCost); }
          catch { throw new CallFailure("budget_limit"); }
          reservedCost += attemptCost;
          attempts = attempt + 1;
          let response: Response;
          try {
            response = await request("https://api.openai.com/v1/responses", {
              method: "POST", redirect: "error", cache: "no-store",
              headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
              body, signal: controller.signal,
            });
          } catch { throw new CallFailure(controller.signal.aborted ? "timeout" : "network_error"); }
          if (!response.ok) {
            await response.body?.cancel();
            // A failed attempt keeps its full reservation: the provider may still have billed it.
            if (!transient.has(response.status) || attempt === settings.maxRetries) throw new CallFailure("http_error", response.status);
            // Bounded exponential backoff; the shared deadline includes retries.
            await new Promise<void>((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
            continue;
          }
          let result: z.infer<typeof envelopeSchema>;
          try { result = envelopeSchema.parse(await readBounded(response)); }
          catch { throw new CallFailure(controller.signal.aborted ? "timeout" : "invalid_response"); }
          const messages = result.output.filter((item) => item.type === "message");
          if (messages.length !== 1) throw new CallFailure("invalid_response");
          if (result.usage.input_tokens > inputTokenBound || result.usage.output_tokens > settings.maxOutputTokens) throw new CallFailure("usage_exceeded");
          const estimatedCostUsd = (result.usage.input_tokens * inputRate + result.usage.output_tokens * outputRate) / 1_000_000;
          reservation?.settle(estimatedCostUsd);
          return { text: messages[0].content[0].text, model: result.model, provider: "openai", usage: {
            inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens,
            estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)), latencyMs: Date.now() - started, attempts,
          } };
        }
        throw new CallFailure("http_error");
      }
      const base = { provider: "openai" as const, model: settings.model, task };
      try {
        const result = await Promise.race([run(), timeout]);
        options.observe?.({ ...base, model: result.model, outcome: "ok", attempts, latencyMs: result.usage.latencyMs,
          inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, estimatedCostUsd: result.usage.estimatedCostUsd ?? undefined });
        return result;
      } catch (error) {
        const failure = error instanceof CallFailure ? error : new CallFailure("invalid_response");
        options.observe?.({ ...base, outcome: "error", reason: failure.reason, httpStatus: failure.httpStatus, attempts, latencyMs: Date.now() - started });
        // One message for every cause: provider bodies and transport details never reach a client.
        throw new RouteError("provider_unavailable", "OpenAI could not generate a validated response within configured limits");
      } finally { clearTimeout(timer); controller.abort(); }
    },
  };
}
