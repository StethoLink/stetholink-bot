import "server-only";
import { createChatOrchestrator } from "@/server/ai/orchestrator/orchestrator";
import { getModelProvider } from "@/server/ai/providers";
import { createPatientContextService } from "@/server/clinical/patient-context/service";
import { getClinicalDataAdapter } from "@/server/integrations/fhir";
import { passthroughSafetyGuard } from "@/server/safety/guard";
import { createConsultationRepository } from "@/server/database";
import { createConsultationService } from "@/server/clinical/consultation/service";
import type { ClinicianSession } from "@/server/auth/session";
import { RouteError } from "@/server/http/respond";

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
export * as authRoutes from "@/server/auth/routes";

export function getConsultations(session: ClinicianSession) {
  if (!session.accessToken) throw new RouteError("unauthenticated", "Sign in with Supabase to save consultations");
  return createConsultationService({
    repository: createConsultationRepository(session.accessToken), provider: getModelProvider(),
    safety: passthroughSafetyGuard, adapter: getClinicalDataAdapter(),
  });
}
