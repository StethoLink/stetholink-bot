import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createOpenAITranscription } from "@/integrations/transcription/openai";

// LIVE TRANSCRIPTION TEST with SYNTHETIC speech (TTS of a fictional visit; no human voice).
// Paid call. Opt in after running scripts/scribe-benchmark.mjs once (it creates the audio):
//   RUN_TRANSCRIPTION_LIVE_TEST=1 OPENAI_API_KEY=... TRANSCRIPTION_MODEL=gpt-transcribe TRANSCRIPTION_USD_PER_MINUTE=0.0045 \
//   npx vitest run tests/backend/transcription-live.test.ts
// A skipped run is UNVERIFIED.
const audio = ".cache/scribe-benchmark/scribe-02-diabetes-new-allergy.webm";
const enabled = process.env.RUN_TRANSCRIPTION_LIVE_TEST === "1" && Boolean(process.env.OPENAI_API_KEY) && existsSync(audio);

describe.skipIf(!enabled)("real transcription provider on synthetic Saudi-Arabic speech", () => {
  it("recognizes the medicine, the dose and the reported allergy, through the product adapter", async () => {
    const events: unknown[] = [];
    const provider = createOpenAITranscription({ apiKey: process.env.OPENAI_API_KEY, model: process.env.TRANSCRIPTION_MODEL ?? "gpt-transcribe",
      usdPerMinute: Number(process.env.TRANSCRIPTION_USD_PER_MINUTE ?? 0.0045) }, fetch, { observe: (event) => events.push(event) });
    const result = await provider.transcribe({ audio: new Uint8Array(readFileSync(audio)), sequence: 0, mimeType: "audio/webm", durationSeconds: 56, language: "ar-SA",
      hints: ["Metformin 500 mg oral tablet", "Type 2 diabetes mellitus"], dataClassification: "synthetic" });
    const text = result.segments.map((segment) => segment.text).join(" ");
    console.info("LIVE transcription", JSON.stringify(events), text);
    expect(text.toLowerCase()).toMatch(/metformin|ميتفورمين|متفورمين/);
    expect(text).toMatch(/خمسمية|500/);
    expect(text).toMatch(/حساسية/);
    expect(result.estimatedCostUsd).toBeCloseTo((56 / 60) * 0.0045, 5);
    // Metrics only are observed: no audio, no text.
    expect(JSON.stringify(events)).not.toMatch(/حساسية|metformin/i);
  }, 40_000);
});
