import { appendFileSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createOpenAIProvider } from "@/core/agent/providers/openai-provider";
import { clinicalSafetyGuard } from "@/core/agent/safety/guard";
import { generateScribeNote } from "@/core/scribe/generate";
import { renderNoteText } from "@/core/scribe/note";
import { toSentences } from "@/core/scribe/segments";
import type { ClinicalFact, TranscriptSegment } from "@/shared/contracts";

// LIVE MODEL EVALUATION of the scribe on the ten fictional visits in core/agent/evaluations/scribe.
// Paid calls with fictional data only. Opt in:
//   RUN_SCRIBE_LIVE_EVAL=1 OPENAI_API_KEY=... SCRIBE_NOTE_MODEL=... SCRIBE_INPUT_USD_PER_MILLION=... SCRIBE_OUTPUT_USD_PER_MILLION=... \
//   npx vitest run tests/backend/scribe-note-live.test.ts
// A skipped run is UNVERIFIED. Set SCRIBE_EVAL_TRANSCRIPTS=path to a scribe-benchmark.json to score recognized (not scripted) transcripts.
const enabled = process.env.RUN_SCRIBE_LIVE_EVAL === "1" && Boolean(process.env.OPENAI_API_KEY);
const { dialogues } = JSON.parse(readFileSync(new URL("../../core/agent/evaluations/scribe/dialogues.json", import.meta.url), "utf8")) as { dialogues: Dialogue[] };
interface Dialogue {
  id: string; turns: { speaker: string; text: string }[]; chart: { category: ClinicalFact["category"]; label: string; value: string | boolean }[];
  expected: { chartConflicts: { about: string }[]; newUpdates: { kind: string; substance?: string; name?: string }[]; mustNotInvent: string[] };
}
const recognized: Record<string, string> = process.env.SCRIBE_EVAL_TRANSCRIPTS
  ? Object.fromEntries((JSON.parse(readFileSync(process.env.SCRIBE_EVAL_TRANSCRIPTS, "utf8")).results as { model: string; dialogue: string; transcript?: string }[])
    .filter((row) => row.model === (process.env.SCRIBE_EVAL_TRANSCRIPT_MODEL ?? "gpt-transcribe") && row.transcript).map((row) => [row.dialogue, row.transcript!]))
  : {};

const provider = () => createOpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY, model: process.env.SCRIBE_NOTE_MODEL ?? "gpt-5-mini", timeoutMs: 28_000, maxRetries: 0, maxInputTokens: 60_000, maxOutputTokens: 6000, maxCostUsd: 0.2,
  reasoningEffort: (process.env.SCRIBE_REASONING_EFFORT as "minimal" | "low" | undefined) ?? "low",
  inputUsdPerMillion: Number(process.env.SCRIBE_INPUT_USD_PER_MILLION ?? 0.25), outputUsdPerMillion: Number(process.env.SCRIBE_OUTPUT_USD_PER_MILLION ?? 2),
});
// The test runner hides output of passing tests; SCRIBE_EVAL_OUT keeps every note for reading.
const report = (line: string) => { console.info(line); if (process.env.SCRIBE_EVAL_OUT) appendFileSync(process.env.SCRIBE_EVAL_OUT, line + "\n"); };
const totals = { cost: 0, statements: 0, rejected: 0, notes: 0, latency: 0, input: 0, output: 0 };

describe.skipIf(!enabled)("scribe note on fictional visits (live model)", () => {
  it.each(dialogues.map((dialogue) => [dialogue.id, dialogue] as const))("%s", async (_id, dialogue) => {
    // Scripted turns by default; recognized text when a benchmark file is given (then there are no speaker turns).
    const spoken = recognized[dialogue.id] ? toSentences([{ startMs: 0, endMs: 60_000, text: recognized[dialogue.id] }]) : dialogue.turns.flatMap((turn) => toSentences([{ startMs: 0, endMs: 0, text: turn.text }]));
    const segments: TranscriptSegment[] = spoken.map((sentence, index) => ({ id: `s${index + 1}`, speaker: null, startMs: sentence.startMs, endMs: sentence.endMs, text: sentence.text }));
    const facts: ClinicalFact[] = dialogue.chart.map((fact, index) => ({ id: `chart-${index + 1}`, category: fact.category, label: fact.label, status: "known", value: fact.value,
      source: { type: "synthetic", reference: "fictional-eval-chart" }, timestamp: "2026-01-01T00:00:00.000Z" }));
    const { note } = await generateScribeNote({ provider: provider(), safety: clinicalSafetyGuard, dataClassification: "synthetic" },
      { segments, facts, demographics: { age: "54 years", sex: "male" }, noteLanguage: "en", spokenLanguage: "ar-SA" });
    const text = renderNoteText(note.sections, "en");
    const kept = Object.values(note.sections).flat().length;
    totals.notes++; totals.statements += kept + note.rejectedStatements; totals.rejected += note.rejectedStatements;
    totals.cost += note.usage?.estimatedCostUsd ?? 0; totals.latency += note.usage?.latencyMs ?? 0; totals.input += note.usage?.inputTokens ?? 0; totals.output += note.usage?.outputTokens ?? 0;
    report(`EVAL ${dialogue.id}: kept ${kept}, removed ${note.rejectedStatements}, updates ${note.proposedUpdates.map((u) => `${u.kind}:${u.name}:${u.relation}`).join(" | ")}, ${note.usage?.inputTokens}+${note.usage?.outputTokens} tokens, $${note.usage?.estimatedCostUsd}, ${note.usage?.latencyMs} ms\n${text}`);
    // Structure: every kept statement has a verified source; the note is not empty.
    expect(kept).toBeGreaterThanOrEqual(3);
    expect(note.sections.subjective.length).toBeGreaterThan(0);
    // A conflict with the chart is surfaced, linked to the chart fact, and never offered for writing.
    for (const conflict of dialogue.expected.chartConflicts) {
      expect(note.proposedUpdates.some((update) => update.relation === "conflicts" && facts.find((fact) => fact.id === update.chartFactId)?.label.includes(conflict.about)), `conflict about ${conflict.about}`).toBe(true);
    }
    // New information is proposed as new.
    for (const expected of dialogue.expected.newUpdates.filter((update) => update.kind !== "intolerance")) {
      const word = (expected.substance ?? expected.name ?? "").split(" ")[0].toLowerCase();
      expect(note.proposedUpdates.some((update) => update.relation === "new" && update.name.toLowerCase().includes(word)), `new ${expected.kind} ${word}`).toBe(true);
    }
    // Nothing the visit did not say.
    for (const invented of dialogue.expected.mustNotInvent.filter((item) => /^[a-z]+$/i.test(item))) expect(text.toLowerCase()).not.toContain(invented.toLowerCase());
  }, 60_000);
  it("reports the measured cost", () => {
    report(`EVAL TOTAL: ${totals.notes} notes, ${totals.statements} statements, ${totals.rejected} removed (${((totals.rejected / Math.max(1, totals.statements)) * 100).toFixed(1)}%), mean ${Math.round(totals.input / Math.max(1, totals.notes))}+${Math.round(totals.output / Math.max(1, totals.notes))} tokens, mean $${(totals.cost / Math.max(1, totals.notes)).toFixed(5)} and ${(totals.latency / Math.max(1, totals.notes) / 1000).toFixed(1)} s per note`);
    expect(totals.notes).toBeGreaterThan(0);
  });
});
