/**
 * Zod schemas for every contract. Each one is checked with `satisfies z.ZodType<Interface>`,
 * so a schema that drifts from its interface fails `npm run typecheck`.
 */
import { z } from "zod";
import {
  ADMINISTRATIVE_SEXES,
  API_ERROR_CODES,
  APPROVAL_DECISIONS,
  CONSULTATION_STATUSES,
  DATA_SOURCES,
  ENCOUNTER_STATUSES,
  ENCOUNTER_TYPES,
  MESSAGE_ROLES,
  SAFETY_LEVELS,
} from "@/shared/constants";
import type {
  ApiError,
  ApprovalRequest,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ConsultationDraft,
  EncounterContext,
  PatientContext,
  SafetyAssessment,
} from "@/shared/contracts";
import { attachmentReferenceSchema, clinicalFactSchema, missingInformationSchema } from "./clinical-data";

export * from "./clinical-data";
export * from "./provider";

const id = z.string().min(1).max(128);
const isoDateTime = z.string().datetime({ offset: true });

export const consultationStatusSchema = z.enum(CONSULTATION_STATUSES);

export const patientContextSchema = z.object({
  patientId: id,
  displayName: z.string().min(1),
  birthDate: z.string().date().optional(),
  sex: z.enum(ADMINISTRATIVE_SEXES),
  allergies: z.array(z.string()),
  activeProblems: z.array(z.string()),
  medications: z.array(z.string()),
  source: z.enum(DATA_SOURCES),
  clinicalFacts: z.array(clinicalFactSchema).optional(),
}) satisfies z.ZodType<PatientContext>;

export const encounterContextSchema = z.object({
  encounterId: id,
  patientId: id,
  type: z.enum(ENCOUNTER_TYPES),
  status: z.enum(ENCOUNTER_STATUSES),
  startedAt: isoDateTime,
  location: z.string().optional(),
  reasonForVisit: z.string().optional(),
  clinicalFacts: z.array(clinicalFactSchema).optional(),
}) satisfies z.ZodType<EncounterContext>;

export const chatMessageSchema = z.object({
  id,
  role: z.enum(MESSAGE_ROLES),
  content: z.string(),
  createdAt: isoDateTime,
}) satisfies z.ZodType<ChatMessage>;

export const safetyAssessmentSchema = z.object({
  level: z.enum(SAFETY_LEVELS),
  reasons: z.array(z.string()),
}) satisfies z.ZodType<SafetyAssessment>;

export const chatRequestSchema = z.object({
  conversationId: id.optional(),
  patientId: id.optional(),
  encounterId: id.optional(),
  message: z.string().trim().min(1).max(8000),
}) satisfies z.ZodType<ChatRequest>;

export const chatResponseSchema = z.object({
  conversationId: id,
  message: chatMessageSchema,
  safety: safetyAssessmentSchema,
  requiresClinicianReview: z.boolean(),
}) satisfies z.ZodType<ChatResponse>;

export const consultationGroundingSchema = z.object({
  reason: z.string().min(1).max(4000).nullable(),
  question: z.string().min(1).max(4000).nullable(),
  specialty: z.string().min(1).max(4000).nullable(),
  evidenceIds: z.array(id).max(64),
  gaps: z.array(z.string().max(5000)).max(80),
  conflicts: z.array(z.array(id).max(64)).max(64),
  safetyFlags: z.array(z.enum(["clinician_review_required", "conflicting_facts", "missing_investigations", "incomplete_referral", "insufficient_clinical_data"])).max(5),
  provenance: z.object({
    provider: z.string().min(1).max(128), model: z.string().min(1).max(256),
    promptVersion: z.string().min(1).max(128), contextVersion: z.string().min(1).max(128),
    syntheticOnly: z.literal(true), encounterReference: id.nullable(),
  }).strict(),
}).strict() satisfies z.ZodType<import("@/shared/contracts/consultation").ConsultationGrounding>;

export const consultationDraftSchema = z.object({
  id,
  patientId: id,
  encounterId: id.optional(),
  status: consultationStatusSchema,
  summary: z.string(),
  assessment: z.string(),
  plan: z.array(z.string()),
  generatedBy: z.literal("ai"),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  reviewedBy: z.string().optional(),
  reviewedAt: isoDateTime.optional(),
  clinicalFacts: z.array(clinicalFactSchema).optional(),
  missingInformation: z.array(missingInformationSchema).optional(),
  attachments: z.array(attachmentReferenceSchema).optional(),
  grounding: consultationGroundingSchema.optional(),
  tenantId: id.optional(),
  version: z.number().int().positive().optional(),
  lifecycleStatus: consultationStatusSchema.optional(),
}) satisfies z.ZodType<ConsultationDraft>;

export const approvalRequestSchema = z.object({
  draftId: id,
  decision: z.enum(APPROVAL_DECISIONS),
  comment: z.string().max(4000).optional(),
  expectedVersion: z.number().int().positive().optional(),
  idempotencyKey: id.optional(),
}) satisfies z.ZodType<ApprovalRequest>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
    requestId: z.string().optional(),
  }),
}) satisfies z.ZodType<ApiError>;

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  contractVersion: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const createConsultationDraftRequestSchema = z.object({
  patientId: id,
  encounterId: id.optional(),
  conversationId: id.optional(),
  idempotencyKey: id.optional(),
  specialty: z.string().trim().min(1).max(200).optional(),
  clinicalQuestion: z.string().trim().min(1).max(4000).optional(),
}).refine((v) => (v.specialty === undefined) === (v.clinicalQuestion === undefined), "Provide the specialty and clinical question together") satisfies z.ZodType<import("@/shared/contracts").CreateConsultationDraftRequest>;


export const revisionRequestSchema = z.object({
  expectedVersion: z.number().int().positive(), idempotencyKey: id,
  summary: z.string().min(1).max(16000), assessment: z.string().max(16000),
  plan: z.array(z.string().max(5000)).max(80),
}).strict() satisfies z.ZodType<import("@/shared/contracts/consultation").RevisionRequest>;

export const transitionRequestSchema = z.object({
  expectedVersion: z.number().int().positive(), idempotencyKey: id,
  action: z.enum(["submit", "cancel"]),
}).strict() satisfies z.ZodType<import("@/shared/contracts/consultation").TransitionRequest>;

export const consultationHistorySchema = z.object({
  revisions: z.array(z.object({ version: z.number().int().positive(), draft: consultationDraftSchema })),
  events: z.array(z.object({ version: z.number().int().positive(), type: z.string(),
    fromStatus: consultationStatusSchema.nullable(), toStatus: consultationStatusSchema, at: isoDateTime })),
  attempts: z.array(z.object({ id: z.string(), number: z.number().int().positive(), recipientId: id,
    status: z.enum(["queued", "sent", "accepted", "responded", "failed", "cancelled", "rejected"]),
    createdAt: isoDateTime, updatedAt: isoDateTime, transport: z.literal("mock") })),
  nextBeforeVersion: z.number().int().positive().nullable(),
});
