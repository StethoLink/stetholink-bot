import { z } from "zod";
import type { ModelProvider } from "./types";
import { RouteError } from "@/core/errors";

const configSchema = z.object({
  apiKey: z.string().min(1).optional(), model: z.string().min(1).max(128),
  timeoutMs: z.number().int().min(1).max(60_000).default(30_000),
  maxRetries: z.number().int().min(0).max(2).default(1),
  maxInputTokens: z.number().int().min(1).max(32_000).default(16_000),
  maxOutputTokens: z.number().int().min(1).max(4096).default(2048),
  maxCostUsd: z.number().positive().max(1).default(0.1),
  // Explicit operator-supplied upper-bound rates; no guessed model pricing.
  inputUsdPerMillion: z.number().positive().max(1000).optional(),
  outputUsdPerMillion: z.number().positive().max(1000).optional(),
});
export type OpenAIProviderConfig = z.input<typeof configSchema>;
const envelopeSchema = z.object({
  status: z.literal("completed"), model: z.string().min(1).max(256),
  output: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("reasoning") }),
    z.object({ type: z.literal("message"), role: z.literal("assistant"), status: z.literal("completed"), content: z.array(z.object({ type: z.literal("output_text"), text: z.string().min(1).max(16_000) })).min(1).max(1) }),
  ])).min(1).max(8),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
});
const transient = new Set([429, 500, 502, 503, 504]);
const RESPONSE_LIMIT = 64_000;

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

export function createOpenAIProvider(config: OpenAIProviderConfig, request: typeof fetch = fetch): ModelProvider {
  return {
    name: "openai",
    async generate(input) {
      const parsed = configSchema.safeParse(config);
      if (!parsed.success || !parsed.data.apiKey) throw new RouteError("provider_unavailable", "OpenAI is not configured");
      const settings = parsed.data;
      if (input.dataClassification !== "synthetic" || input.structuredOutput?.name !== "consultation_evidence_selection") {
        throw new RouteError("forbidden", "OpenAI is restricted to structured synthetic consultation drafting");
      }
      if (!settings.inputUsdPerMillion || !settings.outputUsdPerMillion) {
        throw new RouteError("provider_unavailable", "OpenAI cost bounds are not configured");
      }
      const inputRate = settings.inputUsdPerMillion;
      const outputRate = settings.outputUsdPerMillion;
      const body = JSON.stringify({
        model: settings.model, instructions: input.instructions, input: input.messages, store: false,
        max_output_tokens: settings.maxOutputTokens,
        text: { format: { type: "json_schema", name: input.structuredOutput.name, strict: true, schema: input.structuredOutput.schema } },
      });
      // UTF-8 bytes plus overhead is a conservative token upper bound, including
      // instructions and schema. Reserve the maximum per attempt, even failed ones.
      const inputTokenBound = new TextEncoder().encode(body).length + 512;
      if (inputTokenBound > settings.maxInputTokens) throw new RouteError("provider_unavailable", "OpenAI input token limit exceeded");
      const attemptCost = (inputTokenBound * inputRate + settings.maxOutputTokens * outputRate) / 1_000_000;
      let reservedCost = 0;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("Provider deadline exceeded")); }, settings.timeoutMs);
      });
      async function run() {
        for (let attempt = 0; attempt <= settings.maxRetries; attempt++) {
          if (controller.signal.aborted) throw new Error("Provider deadline exceeded");
          if (reservedCost + attemptCost > settings.maxCostUsd) throw new Error("Provider cost limit exceeded");
          reservedCost += attemptCost;
          const response = await request("https://api.openai.com/v1/responses", {
            method: "POST", redirect: "error", cache: "no-store",
            headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
            body, signal: controller.signal,
          });
          if (!response.ok) {
            await response.body?.cancel();
            if (!transient.has(response.status) || attempt === settings.maxRetries) throw new Error("Provider request failed");
            // Bounded exponential backoff; the shared deadline includes retries.
            await new Promise<void>((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
            continue;
          }
          const result = envelopeSchema.parse(await readBounded(response));
          const messages = result.output.filter((item) => item.type === "message");
          if (messages.length !== 1) throw new Error("Ambiguous provider output");
          if (result.usage.input_tokens > inputTokenBound || result.usage.output_tokens > settings.maxOutputTokens) throw new Error("Provider usage exceeded reserved bounds");
          return { text: messages[0].content[0].text, model: result.model, provider: "openai" };
        }
        throw new Error("Provider attempts exhausted");
      }
      try { return await Promise.race([run(), timeout]); }
      catch { throw new RouteError("provider_unavailable", "OpenAI could not generate a validated response within configured limits"); }
      finally { clearTimeout(timer); controller.abort(); }
    },
  };
}
