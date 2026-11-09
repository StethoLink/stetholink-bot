import type { MESSAGE_ROLES, SAFETY_LEVELS } from "@/shared/constants";
import type { IsoDateTime } from "@/shared/types";

export type MessageRole = (typeof MESSAGE_ROLES)[number];
export type SafetyLevel = (typeof SAFETY_LEVELS)[number];

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: IsoDateTime;
}

export interface SafetyAssessment {
  level: SafetyLevel;
  reasons: string[];
}

export interface ChatRequest {
  conversationId?: string;
  patientId?: string;
  encounterId?: string;
  message: string;
}

/** An AI recommendation. It is never a clinical decision: approval is a separate step. */
export interface ChatResponse {
  conversationId: string;
  message: ChatMessage;
  safety: SafetyAssessment;
  /** True when the output contains content a clinician must review before use. */
  requiresClinicianReview: boolean;
}
