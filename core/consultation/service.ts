import type { ClinicianContext } from "@/core/auth/clinician";
import type { ApprovalRequest, CreateConsultationDraftRequest } from "@/shared/contracts";
import { consultationDraftSchema } from "@/shared/schemas";
import { z } from "zod";
import type { ConsultationRepository } from "@/core/consultation/repository";
import type { ModelProvider } from "@/core/agent/providers/types";
import type { SafetyGuard } from "@/core/agent/safety/guard";
import type { ClinicalDataAdapter } from "@/core/tools/connector";
import { PROMPT_VERSION, SYSTEM_INSTRUCTIONS } from "@/core/agent/prompts/system";
import { RouteError } from "@/core/errors";

const generatedSchema = z.strictObject({
  summary: z.string().trim().min(1).max(16000), assessment: z.string().trim().min(1).max(16000),
  plan: z.array(z.string().trim().min(1).max(4000)).min(1).max(100),
});

export function createConsultationService(deps: { repository: ConsultationRepository; provider: ModelProvider; safety: SafetyGuard; adapter: ClinicalDataAdapter }) {
  return {
    get: deps.repository.get,
    async approve(input: ApprovalRequest, actor: ClinicianContext) {
      if (actor.authorization !== "active" || actor.expiresAt <= Date.now() ||
          !actor.roles.includes("physician") || !actor.scopes.includes("consultation:approve")) {
        throw new RouteError("forbidden", "Physician approval is required");
      }
      return deps.repository.approve(input);
    },
    async create(input: CreateConsultationDraftRequest, actor: ClinicianContext) {
      if (actor.authorization !== "active" || actor.expiresAt <= Date.now() || !actor.scopes.includes("consultation:draft") ||
          input.patientId !== actor.patientId || (input.encounterId !== undefined && input.encounterId !== actor.encounterId)) {
        throw new RouteError("forbidden", "Draft context does not match the active chart");
      }
      if (input.conversationId) throw new RouteError("invalid_request", "Conversation-based drafts are not supported yet");
      const patient = await deps.adapter.getPatient(actor.patientId);
      if (!patient) throw new RouteError("not_found", "Patient not found");
      if (patient.source !== "synthetic") throw new RouteError("forbidden", "Only synthetic patient data is supported");
      const encounter = actor.encounterId ? await deps.adapter.getEncounter(actor.encounterId) : null;
      if (actor.encounterId && (!encounter || encounter.patientId !== patient.patientId)) {
        throw new RouteError("forbidden", "Encounter does not belong to this patient");
      }

      const result = await deps.provider.generate({
        instructions: SYSTEM_INSTRUCTIONS + ' Return only a JSON object with summary, assessment, and plan (an array of strings). Summarize relevant documented findings, identify missing information in the plan, and state what the recipient is being asked to review. Do not invent findings or give treatment orders. Never claim clinician approval.',
        messages: [{ role: "user", content: JSON.stringify({ patient, encounter }) }],
      });
      let content: z.infer<typeof generatedSchema>;
      if (result.provider === "mock") {
        content = {
          summary: `Synthetic consultation for ${patient.displayName}.`, assessment: "Synthetic recommendation; clinician review required.",
          plan: ["Verify the reason and urgency of the request before sending.", "Request the recipient’s review of the documented synthetic findings."],
        };
      } else {
        if (result.text.length > 32_000) throw new RouteError("safety_blocked", "Draft withheld by safety check");
        try { content = generatedSchema.parse(JSON.parse(result.text)); }
        catch { throw new RouteError("provider_unavailable", "Model returned an invalid draft"); }
      }
      const safety = await deps.safety.assess([content.summary, content.assessment, ...content.plan].join("\n"));
      if (safety.level === "blocked") throw new RouteError("safety_blocked", "Draft withheld by safety check");
      const now = new Date().toISOString();
      const draft = consultationDraftSchema.parse({
        ...content, id: crypto.randomUUID(), patientId: actor.patientId, encounterId: actor.encounterId,
        status: "pending_approval", generatedBy: "ai", createdAt: now, updatedAt: now,
      });
      return deps.repository.create(draft, actor.clinicianId, { provider: result.provider, model: result.model, promptVersion: PROMPT_VERSION });
    },
  };
}
