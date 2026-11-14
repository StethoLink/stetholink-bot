import type { ConsultationClarificationNeeded, ConsultationDraft } from "@/shared/contracts";

/** Awaits a consultation create/author call that the test expects to produce a draft, not a clarification. */
export async function drafted(pending: Promise<ConsultationDraft | ConsultationClarificationNeeded>): Promise<ConsultationDraft> {
  const result = await pending;
  if ("outcome" in result) throw new Error(`Expected a draft, got a clarification: ${result.concerns.map((entry) => entry.concern).join(" | ")}`);
  return result;
}
