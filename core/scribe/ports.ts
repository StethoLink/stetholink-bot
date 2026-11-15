import type { DataClassification } from "@/shared/contracts";

/** One piece of recognized speech inside an audio chunk. Times are relative to the start of the chunk. */
export interface RecognizedSegment {
  startMs: number;
  endMs: number;
  text: string;
  /** Anonymous speaker label from the provider, when it separates voices. Not a role. */
  speakerLabel?: string;
  /** 0 to 1, when the provider reports it. */
  confidence?: number;
}

export interface TranscriptionRequest {
  audio: Uint8Array;
  /** Position of this chunk in the visit, from 0. */
  sequence: number;
  mimeType: string;
  /** Length of the chunk as measured by the recorder, in seconds. Billing is checked against it before the call. */
  durationSeconds: number;
  /** BCP 47 language of the conversation, e.g. "ar-SA". */
  language: string;
  /** Medicine and problem names from the chart that help recognition. Never identifiers or free text. */
  hints: readonly string[];
  /** From the verified session. A provider refuses a classification it is not approved for. */
  dataClassification: DataClassification;
}
export interface TranscriptionResult {
  segments: RecognizedSegment[];
  provider: string;
  model: string;
  audioSeconds: number;
  estimatedCostUsd: number;
  latencyMs: number;
}
/**
 * Speech to text for one audio chunk. Implementations live in `integrations/transcription`.
 * The audio is held in memory for the call and never written anywhere.
 */
export interface TranscriptionProvider {
  readonly name: string;
  readonly model: string;
  /** False for the deterministic stand-in used in development and tests. */
  readonly live: boolean;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}
