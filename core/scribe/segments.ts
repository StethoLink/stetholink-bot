import type { RecognizedSegment } from "./ports";

/**
 * Splits recognized speech into sentences so that a statement of the note can point at a few
 * words, not at half a minute of conversation. Times inside a provider segment are apportioned
 * by length. The words themselves are never changed.
 */
export function toSentences(segments: readonly RecognizedSegment[]): Array<{ startMs: number; endMs: number; text: string }> {
  const sentences: Array<{ startMs: number; endMs: number; text: string }> = [];
  for (const segment of segments) {
    const text = segment.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const parts = text.split(/(?<=[.!?؟…])\s+/u).map((part) => part.trim()).filter(Boolean);
    // A very short piece ("إيه.", "لا.") stays with what follows it when that is part of the same answer.
    const merged: string[] = [];
    for (const part of parts) {
      const previous = merged.at(-1);
      if (previous !== undefined && previous.split(" ").length < 3 && !/[?؟]$/.test(previous)) merged[merged.length - 1] = `${previous} ${part}`;
      else merged.push(part);
    }
    const span = Math.max(0, segment.endMs - segment.startMs);
    let offset = 0;
    for (const part of merged) {
      const startMs = Math.round(segment.startMs + (offset / text.length) * span);
      offset += part.length + 1;
      sentences.push({ startMs, endMs: Math.round(segment.startMs + (Math.min(offset, text.length) / text.length) * span), text: part.slice(0, 4000) });
    }
  }
  return sentences;
}
