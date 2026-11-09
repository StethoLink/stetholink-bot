import "server-only";
import { createChatOrchestrator } from "@/server/ai/orchestrator/orchestrator";
import { getModelProvider } from "@/server/ai/providers";
import { createPatientContextService } from "@/server/clinical/patient-context/service";
import { getClinicalDataAdapter } from "@/server/integrations/fhir";
import { passthroughSafetyGuard } from "@/server/safety/guard";

/** Composition root. API routes import from here; nothing else creates concrete dependencies. */
export function getServices() {
  const adapter = getClinicalDataAdapter();
  const patientContext = createPatientContextService(adapter);
  const chat = createChatOrchestrator({
    provider: getModelProvider(),
    safety: passthroughSafetyGuard,
    loadPatientContext: (id) => patientContext.getContext(id),
  });
  return { adapter, patientContext, chat };
}

export { requireClinician } from "@/server/auth/session";
export { contractResponse, errorResponse, handleRouteError } from "@/server/http/respond";
