import type { DataClassification, ModelUsage, ScribeNote } from "@/shared/contracts";
import type { ModelProvider } from "@/core/agent/providers/types";
import type { SafetyGuard } from "@/core/agent/safety/guard";
import { RouteError } from "@/core/errors";
import { MAX_NOTE_ATTEMPTS, SCRIBE_INSTRUCTIONS, SCRIBE_PROMPT_VERSION, buildNoteInput, renderNoteText, scribeNoteFormat, validateNote, type NoteContext, type ValidatedNote } from "./note";

function sumUsage(a: ModelUsage | null, b: ModelUsage | undefined): ModelUsage | null {
  if (!b) return a;
  if (!a) return b;
  return {
    inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
    estimatedCostUsd: a.estimatedCostUsd === null || b.estimatedCostUsd === null ? null : Number((a.estimatedCostUsd + b.estimatedCostUsd).toFixed(6)),
    latencyMs: a.latencyMs + b.latencyMs, attempts: a.attempts + b.attempts,
  };
}

/**
 * One model call for the whole visit (a second only if the first response cannot be used).
 * The model has no tools: it returns one JSON object, which is validated against the transcript
 * and the chart before anything is kept. Nothing is stored, approved or written here.
 */
export async function generateScribeNote(deps: { provider: ModelProvider; safety: SafetyGuard; dataClassification: DataClassification }, context: NoteContext):
  Promise<{ note: ScribeNote; speakers: ValidatedNote["speakers"] }> {
  if (!context.segments.length) throw new RouteError("conflict", "Nothing was recorded, so there is no note to write");
  let usage: ModelUsage | null = null;
  let failure: unknown;
  for (let attempt = 0; attempt < MAX_NOTE_ATTEMPTS; attempt++) {
    const result = await deps.provider.generate({
      instructions: SCRIBE_INSTRUCTIONS,
      messages: [{ role: "user", content: buildNoteInput(context) }],
      dataClassification: deps.dataClassification,
      structuredOutput: scribeNoteFormat,
    });
    usage = sumUsage(usage, result.usage);
    try {
      const validated = validateNote(result.text, context);
      const safety = await deps.safety.assess(renderNoteText(validated.sections, context.noteLanguage));
      if (safety.level === "blocked") throw new RouteError("safety_blocked", "The note was withheld by the safety check");
      return {
        speakers: validated.speakers,
        note: {
          language: context.noteLanguage, sections: validated.sections, proposedUpdates: validated.proposedUpdates,
          rejectedStatements: validated.rejectedStatements, rejectedUpdates: validated.rejectedUpdates,
          provenance: { provider: result.provider, model: result.model, promptVersion: SCRIBE_PROMPT_VERSION, dataClassification: deps.dataClassification, liveInference: result.provider !== "mock" },
          usage, generatedAt: new Date().toISOString(),
        },
      };
    } catch (error) { failure = error; }
  }
  throw failure;
}
