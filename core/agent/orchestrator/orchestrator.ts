import type { ChatRequest, ChatResponse, DataClassification, PatientContext } from "@/shared/contracts";
import { createId, nowIso } from "@/shared/utils";
import { SYSTEM_INSTRUCTIONS } from "@/core/agent/prompts/system";
import type { ModelProvider } from "@/core/agent/providers/types";
import type { SafetyGuard } from "@/core/agent/safety/guard";
import { RouteError } from "@/core/errors";
import { classificationOfSource } from "@/shared/schemas";

export interface OrchestratorDeps {
  provider: ModelProvider;
  safety: SafetyGuard;
  /** Classification of the verified session; passed to the provider with every request. */
  dataClassification: DataClassification;
  loadPatientContext: (patientId: string) => Promise<PatientContext | null>;
}

/** Turns a chat request into a safety-checked recommendation. It has no UI or database dependencies. */
export function createChatOrchestrator(deps: OrchestratorDeps) {
  return {
    async handle(request: ChatRequest): Promise<ChatResponse> {
      const patient = request.patientId ? await deps.loadPatientContext(request.patientId) : null;
      if (patient && classificationOfSource(patient.source) !== deps.dataClassification) {
        throw new RouteError("forbidden", "Clinical data does not belong to this session's data classification");
      }
      const contextNote = patient ? `\n\nPatient context (JSON): ${JSON.stringify(patient)}` : "";

      const result = await deps.provider.generate({
        instructions: SYSTEM_INSTRUCTIONS + contextNote,
        messages: [{ role: "user", content: request.message }],
        dataClassification: deps.dataClassification,
      });
      const safety = await deps.safety.assess(result.text);

      return {
        conversationId: request.conversationId ?? createId("conv"),
        message: {
          id: createId("msg"),
          role: "assistant",
          content: safety.level === "blocked" ? "This response was withheld by the safety check." : result.text,
          createdAt: nowIso(),
        },
        safety,
        requiresClinicianReview: true,
      };
    },
  };
}
