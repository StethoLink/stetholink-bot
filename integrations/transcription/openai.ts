import { RouteError } from "@/core/errors";
import type { SpendingLimiter, SpendingReservation } from "@/core/agent/providers/types";
import { responsesEndpoint } from "@/core/agent/providers/openai-provider";
import type { TranscriptionProvider } from "@/core/scribe/ports";

export interface OpenAITranscriptionConfig {
  apiKey?: string;
  model: string;
  /** Operator-verified list price per audio minute. No price is assumed. */
  usdPerMinute?: number;
  baseUrl?: string;
  allowLoopbackHttp?: boolean;
  /** TRANSCRIPTION_LIVE_DATA_APPROVED: this deployment may receive real patients' speech. */
  liveDataApproved?: boolean;
  timeoutMs?: number;
}
export interface TranscriptionEvent { provider: string; model: string; outcome: "ok" | "error"; reason?: string; httpStatus?: number; audioSeconds: number; latencyMs: number; estimatedCostUsd?: number }

/**
 * OpenAI speech to text for one chunk. The audio goes from memory to the provider and is not
 * kept. Metrics only are observed: never audio, text or keys.
 */
export function createOpenAITranscription(config: OpenAITranscriptionConfig, request: typeof fetch = fetch, options: { budget?: SpendingLimiter; observe?(event: TranscriptionEvent): void } = {}): TranscriptionProvider {
  return {
    name: "openai", model: config.model, live: true,
    async transcribe(input) {
      const base = responsesEndpoint(config.baseUrl ?? "https://api.openai.com/v1", config.allowLoopbackHttp ?? false)?.replace(/\/responses$/, "");
      if (!config.apiKey || !base || !config.usdPerMinute) throw new RouteError("provider_unavailable", "Transcription is not configured");
      if (input.dataClassification === "live" && !config.liveDataApproved) {
        throw new RouteError("provider_unavailable", "The transcription provider is not approved for live clinical data (TRANSCRIPTION_LIVE_DATA_APPROVED)");
      }
      const cost = (input.durationSeconds / 60) * config.usdPerMinute;
      let reservation: SpendingReservation | undefined;
      try { reservation = await options.budget?.reserve(cost, "transcription"); }
      catch { throw new RouteError("provider_unavailable", "The transcription spending limit has been reached"); }
      const form = new FormData();
      form.append("file", new Blob([input.audio as BlobPart], { type: input.mimeType }), `chunk.${input.mimeType.includes("mp4") ? "mp4" : input.mimeType.includes("ogg") ? "ogg" : input.mimeType.includes("wav") ? "wav" : "webm"}`);
      form.append("model", config.model);
      form.append("language", input.language.split("-")[0]);
      form.append("response_format", "json");
      // Names from the chart help the recognizer spell medicines; the prompt is capped and carries no identifiers.
      const prompt = input.hints.join(", ").slice(0, 600);
      if (prompt) form.append("prompt", prompt);
      const started = Date.now();
      const event = { provider: "openai", model: config.model, audioSeconds: input.durationSeconds };
      let response: Response;
      try {
        response = await request(`${base}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${config.apiKey}` }, body: form, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(config.timeoutMs ?? 25_000) });
      } catch {
        options.observe?.({ ...event, outcome: "error", reason: "network_error", latencyMs: Date.now() - started });
        throw new RouteError("provider_unavailable", "The transcription service could not be reached");
      }
      if (!response.ok) {
        await response.body?.cancel();
        options.observe?.({ ...event, outcome: "error", reason: "http_error", httpStatus: response.status, latencyMs: Date.now() - started });
        throw new RouteError("provider_unavailable", "The transcription service could not process this recording");
      }
      const body = await response.json().catch(() => null) as { text?: unknown } | null;
      if (!body || typeof body.text !== "string" || body.text.length > 20_000) {
        options.observe?.({ ...event, outcome: "error", reason: "invalid_response", latencyMs: Date.now() - started });
        throw new RouteError("provider_unavailable", "The transcription service returned an unusable result");
      }
      await reservation?.settle(cost);
      const latencyMs = Date.now() - started;
      options.observe?.({ ...event, outcome: "ok", latencyMs, estimatedCostUsd: Number(cost.toFixed(6)) });
      const text = body.text.trim();
      return {
        segments: text ? [{ startMs: 0, endMs: Math.round(input.durationSeconds * 1000), text }] : [],
        provider: "openai", model: config.model, audioSeconds: input.durationSeconds, estimatedCostUsd: Number(cost.toFixed(6)), latencyMs,
      };
    },
  };
}
