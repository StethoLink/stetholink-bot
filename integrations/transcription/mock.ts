import { RouteError } from "@/core/errors";
import type { TranscriptionProvider } from "@/core/scribe/ports";

/** A FICTIONAL visit in Saudi Arabic with English clinical terms. Nobody said this; no recording exists. */
export const MOCK_VISIT = [
  "هلا بك. كيف السكر معك هالفترة؟ والله يا دكتور القراءات الصبح بين مية وستين ومية وثمانين.",
  "تاخذ metformin بانتظام؟ إيه، خمسمية ملي مرتين في اليوم مع الأكل.",
  "عندك حساسية من أدوية؟ الشهر اللي فات أخذت مضاد حيوي فيه sulfa وطلع لي طفح جلدي قوي وحكة، والطوارئ قالوا لي عندك حساسية منه.",
  "مهم هذا، بسجله. وآخر HbA1c كان ثمانية فاصلة واحد. بزيد لك metformin إلى ألف ملي مرتين في اليوم، وبنعيد HbA1c بعد ثلاث شهور.",
];

/**
 * Deterministic stand-in for development, tests and demos: each audio chunk "says" the next part
 * of one fixed fictional visit, whatever was recorded. It performs no recognition, makes no
 * network call and never accepts live clinical data. The interface labels it as not real transcription.
 */
export const mockTranscription: TranscriptionProvider = {
  name: "mock", model: "mock-transcription-1", live: false,
  async transcribe(input) {
    if (input.dataClassification === "live") throw new RouteError("provider_unavailable", "The transcription stand-in cannot be used with live clinical data");
    const text = MOCK_VISIT[input.sequence];
    return {
      segments: text ? [{ startMs: 0, endMs: Math.round(input.durationSeconds * 1000), text }] : [],
      provider: "mock", model: "mock-transcription-1", audioSeconds: input.durationSeconds, estimatedCostUsd: 0, latencyMs: 0,
    };
  },
};
