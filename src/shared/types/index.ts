import type { z } from "zod";
import type {
  apiErrorSchema,
  assistantRequestSchema,
  assistantResponseSchema,
  chatMessageSchema,
  consultationSchema,
  patientContextSchema,
  safetyAssessmentSchema,
} from "@/shared/schemas";

export type PatientContext = z.infer<typeof patientContextSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type SafetyAssessment = z.infer<typeof safetyAssessmentSchema>;
export type Consultation = z.infer<typeof consultationSchema>;
export type AssistantRequest = z.infer<typeof assistantRequestSchema>;
export type AssistantResponse = z.infer<typeof assistantResponseSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
