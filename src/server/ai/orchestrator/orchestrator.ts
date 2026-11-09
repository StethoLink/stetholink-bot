import type { AiProvider, AssistantOrchestrator, SafetyGuard } from "@/shared/contracts";
import { createId, nowIso } from "@/shared/utils";
import { SYSTEM_PROMPT } from "@/server/ai/prompts/system";

export function createOrchestrator(deps: {
  provider: AiProvider;
  safety: SafetyGuard;
}): AssistantOrchestrator {
  return {
    async handle(request) {
      const consultationId = request.consultationId ?? createId("cons");
      const text = await deps.provider.complete({
        system: SYSTEM_PROMPT,
        messages: [{ id: createId("msg"), role: "clinician", content: request.message, createdAt: nowIso() }],
      });
      const safety = await deps.safety.assess(text);
      return {
        consultationId,
        reply: { id: createId("msg"), role: "assistant", content: text, createdAt: nowIso() },
        safety,
      };
    },
  };
}
