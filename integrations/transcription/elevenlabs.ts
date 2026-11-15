import { RouteError } from "@/core/errors";
import type { SpendingLimiter, SpendingReservation } from "@/core/agent/providers/types";
import type { RecognizedSegment, TranscriptionProvider } from "@/core/scribe/ports";
import type { TranscriptionEvent } from "./openai";

export interface ElevenLabsTranscriptionConfig {
  apiKey?: string;
  model: string;
  usdPerMinute?: number;
  liveDataApproved?: boolean;
  timeoutMs?: number;
}
const LANGUAGE: Record<string, string> = { ar: "ara", en: "eng" };
interface Word { text?: string; start?: number; end?: number; type?: string; speaker_id?: string }

/** ElevenLabs Scribe for one chunk. It separates voices; the labels are anonymous, not roles. */
export function createElevenLabsTranscription(config: ElevenLabsTranscriptionConfig, request: typeof fetch = fetch, options: { budget?: SpendingLimiter; observe?(event: TranscriptionEvent): void } = {}): TranscriptionProvider {
  return {
    name: "elevenlabs", model: config.model, live: true,
    async transcribe(input) {
      if (!config.apiKey || !config.usdPerMinute) throw new RouteError("provider_unavailable", "Transcription is not configured");
      if (input.dataClassification === "live" && !config.liveDataApproved) {
        throw new RouteError("provider_unavailable", "The transcription provider is not approved for live clinical data (TRANSCRIPTION_LIVE_DATA_APPROVED)");
      }
      const cost = (input.durationSeconds / 60) * config.usdPerMinute;
      let reservation: SpendingReservation | undefined;
      try { reservation = await options.budget?.reserve(cost, "transcription"); }
      catch { throw new RouteError("provider_unavailable", "The transcription spending limit has been reached"); }
      const form = new FormData();
      form.append("file", new Blob([input.audio as BlobPart], { type: input.mimeType }), "chunk.webm");
      form.append("model_id", config.model);
      form.append("language_code", LANGUAGE[input.language.split("-")[0]] ?? input.language.split("-")[0]);
      form.append("diarize", "true");
      form.append("tag_audio_events", "false");
      const started = Date.now();
      const event = { provider: "elevenlabs", model: config.model, audioSeconds: input.durationSeconds };
      let response: Response;
      try {
        response = await request("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": config.apiKey }, body: form, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(config.timeoutMs ?? 25_000) });
      } catch {
        options.observe?.({ ...event, outcome: "error", reason: "network_error", latencyMs: Date.now() - started });
        throw new RouteError("provider_unavailable", "The transcription service could not be reached");
      }
      if (!response.ok) {
        await response.body?.cancel();
        options.observe?.({ ...event, outcome: "error", reason: "http_error", httpStatus: response.status, latencyMs: Date.now() - started });
        throw new RouteError("provider_unavailable", "The transcription service could not process this recording");
      }
      const body = await response.json().catch(() => null) as { text?: unknown; words?: Word[] } | null;
      if (!body || typeof body.text !== "string") {
        options.observe?.({ ...event, outcome: "error", reason: "invalid_response", latencyMs: Date.now() - started });
        throw new RouteError("provider_unavailable", "The transcription service returned an unusable result");
      }
      // Consecutive words of one voice form a segment.
      const segments: RecognizedSegment[] = [];
      for (const word of Array.isArray(body.words) ? body.words : []) {
        if (typeof word.text !== "string" || !word.text) continue;
        const last = segments.at(-1);
        if (last && (word.type === "spacing" || last.speakerLabel === word.speaker_id)) { last.text += word.text; if (typeof word.end === "number") last.endMs = Math.round(word.end * 1000); }
        else if (word.type !== "spacing") segments.push({ startMs: Math.round((word.start ?? 0) * 1000), endMs: Math.round((word.end ?? word.start ?? 0) * 1000), text: word.text, speakerLabel: word.speaker_id });
      }
      const text = body.text.trim();
      await reservation?.settle(cost);
      const latencyMs = Date.now() - started;
      options.observe?.({ ...event, outcome: "ok", latencyMs, estimatedCostUsd: Number(cost.toFixed(6)) });
      return {
        segments: segments.length ? segments.map((segment) => ({ ...segment, text: segment.text.trim() })).filter((segment) => segment.text) : text ? [{ startMs: 0, endMs: Math.round(input.durationSeconds * 1000), text }] : [],
        provider: "elevenlabs", model: config.model, audioSeconds: input.durationSeconds, estimatedCostUsd: Number(cost.toFixed(6)), latencyMs,
      };
    },
  };
}
