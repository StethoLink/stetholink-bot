import type { CreateConsultationDraftRequest } from "@/shared/contracts";
import { consultationDraftSchema } from "@/shared/schemas";
import { z } from "zod";
import type { ConsultationRepository } from "@/core/consultation/repository";
import type { ModelProvider } from "@/core/agent/providers/types";
import type { SafetyGuard } from "@/core/agent/safety/guard";
import type { ClinicalDataAdapter } from "@/core/tools/connector";
import { PROMPT_VERSION, SYSTEM_INSTRUCTIONS } from "@/core/agent/prompts/system";
import { RouteError } from "@/core/errors";

const generatedSchema = z.object({ summary: z.string().max(16000), assessment: z.string().max(16000), plan: z.array(z.string().max(4000)).max(100) });
export function createConsultationService(deps: { repository: ConsultationRepository; provider: ModelProvider; safety: SafetyGuard; adapter: ClinicalDataAdapter }) {
  return {
    get: deps.repository.get,
    approve: deps.repository.approve,
    async create(input: CreateConsultationDraftRequest, clinicianId: string) {
      if (input.conversationId) throw new RouteError("invalid_request", "Conversation-based drafts are not supported yet; omit conversationId");
      const patient = await deps.adapter.getPatient(input.patientId);
      if (!patient) throw new RouteError("not_found", "Patient not found");
      if (patient.source !== "synthetic") throw new RouteError("forbidden", "Only synthetic patient data is supported");
      const encounter = input.encounterId ? await deps.adapter.getEncounter(input.encounterId) : null;
      if (input.encounterId && (!encounter || encounter.patientId !== patient.patientId)) throw new RouteError("invalid_request", "Encounter does not belong to this patient");
      const result = await deps.provider.generate({
        instructions: SYSTEM_INSTRUCTIONS + ' Return only a JSON object with summary, assessment, and plan (an array of strings). Summarize relevant documented findings, identify missing information in the plan, and state what the recipient is being asked to review. Do not invent findings or give treatment orders. Never claim clinician approval.',
        messages: [{ role: "user", content: JSON.stringify({ patient, encounter }) }],
      });
      const safety = await deps.safety.assess(result.text);
      if (safety.level === "blocked") throw new RouteError("safety_blocked", "Draft withheld by safety check");
      let content: z.infer<typeof generatedSchema>;
      if (result.provider === "mock") content = { summary: `Synthetic consultation for ${patient.displayName}.`, assessment: "Synthetic recommendation; clinician review required.", plan: ["Verify the reason and urgency of the request before sending.", "Request the recipient’s review of the documented synthetic findings."] };
      else {
        try { content = generatedSchema.parse(JSON.parse(result.text)); }
        catch { throw new RouteError("provider_unavailable", "Model returned an invalid draft"); }
      }
      const now = new Date().toISOString();
      const draft = consultationDraftSchema.parse({ ...content, id: crypto.randomUUID(), patientId: input.patientId, encounterId: input.encounterId, status: "pending_approval", generatedBy: "ai", createdAt: now, updatedAt: now });
      return deps.repository.create(draft, clinicianId, { provider: result.provider, model: result.model, promptVersion: PROMPT_VERSION });
    },
  };
}
