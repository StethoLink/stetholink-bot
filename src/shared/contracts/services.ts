/**
 * Server-side service interfaces. CODEX implements these under src/server/.
 * Route handlers depend on these interfaces, never on concrete providers.
 */
import type {
  AssistantRequest,
  AssistantResponse,
  ChatMessage,
  PatientContext,
  SafetyAssessment,
} from "@/shared/types";

export interface AiProvider {
  readonly name: string;
  complete(input: { system: string; messages: ChatMessage[] }): Promise<string>;
}

export interface AssistantOrchestrator {
  handle(request: AssistantRequest): Promise<AssistantResponse>;
}

export interface PatientContextService {
  getContext(patientId: string): Promise<PatientContext | null>;
}

export interface SafetyGuard {
  assess(text: string): Promise<SafetyAssessment>;
}
