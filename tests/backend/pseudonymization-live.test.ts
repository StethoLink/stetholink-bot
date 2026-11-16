import { describe, expect, it, vi } from "vitest";
import { createOpenAIProvider } from "@/core/agent/providers/openai-provider";
import { clinicalSafetyGuard } from "@/core/agent/safety/guard";
import type { SurrogateState } from "@/core/privacy/pseudonymizer";
import { generateScribeNote } from "@/core/scribe/generate";
import type { NoteContext } from "@/core/scribe/note";
import { FORBIDDEN_IN_MODEL_REQUESTS, fictionalIdentity, fictionalTranscript } from "../fixtures/identities";
import { deidentified, testVault } from "../helpers/privacy";

vi.mock("server-only", () => ({}));

/**
 * Opt-in: a real model on a fictional visit, through the de-identification layer.
 * RUN_PRIVACY_LIVE_EVAL=1 OPENAI_API_KEY=... (and NODE_USE_ENV_PROXY=1 behind a proxy).
 * Shows that a real model keeps the stand-ins and day offsets well enough for its answer to be
 * mapped back and to pass the note validation. It is not run by `npm run check`.
 */
const enabled = process.env.RUN_PRIVACY_LIVE_EVAL === "1" && Boolean(process.env.OPENAI_API_KEY);

describe.skipIf(!enabled)("de-identified scribe note (live model, fictional visit)", () => {
  it("sends no identifier and returns a note with the real names", async () => {
    const bodies: string[] = [];
    const capture: typeof fetch = (url, init) => { bodies.push(String(init?.body)); return fetch(url, init); };
    const vault = testVault();
    const provider = deidentified(createOpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY, model: process.env.SCRIBE_NOTE_MODEL ?? "gpt-5-mini", timeoutMs: 28_000, maxRetries: 0, maxInputTokens: 60_000, maxOutputTokens: 6000, maxCostUsd: 0.2,
      reasoningEffort: "low", inputUsdPerMillion: 0.25, outputUsdPerMillion: 2,
    }, capture), fictionalIdentity, vault);
    const context: NoteContext = {
      segments: fictionalTranscript.map((segment, index) => ({ ...segment, speaker: null, startMs: index * 5000, endMs: index * 5000 + 4000 })),
      facts: [], demographics: { age: "58 years", sex: "male" }, noteLanguage: "en", spokenLanguage: "ar",
    };
    const { note } = await generateScribeNote({ provider, safety: clinicalSafetyGuard, dataClassification: "synthetic" }, context);
    for (const body of bodies) for (const forbidden of FORBIDDEN_IN_MODEL_REQUESTS) expect(body.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
    const text = JSON.stringify(note.sections);
    const standIns = (vault.state as SurrogateState).entries.flatMap((entry) => [entry.ar, entry.la]);
    console.info(JSON.stringify({ calls: bodies.length, statements: Object.values(note.sections).flat().length, rejected: note.rejectedStatements, text }, null, 1));
    // No stand-in and no token is left in what the physician reads.
    for (const standIn of standIns) expect(text, standIn).not.toContain(standIn);
    expect(text).not.toMatch(/\b(?:ID|PHONE|EMAIL|URL|DATE)-[A-Z]\b|T[+-]\d+d/);
    expect(Object.values(note.sections).flat().length).toBeGreaterThanOrEqual(3);
    expect(text).toMatch(/150/);
  }, 60_000);
});
