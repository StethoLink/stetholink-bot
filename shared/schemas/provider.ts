import { z } from "zod";
import { CONSULTATION_STATUSES } from "@/shared/constants";
import type {
  ConsultationDeliveryView, ConsultationEnvelope, ConsultationEnvelopeContent, ConsultationListItem,
  DispatchRequest, ProviderCallback, ProviderDescriptor,
} from "@/shared/contracts";
import { dataClassificationSchema, readLegacyClassification } from "./classification";
import { attachmentReferenceSchema, clinicalFactSchema, missingInformationSchema, providerIdSchema } from "./clinical-data";

const id = z.string().min(1).max(128).regex(/\S/);
const isoDateTime = z.string().datetime({ offset: true });
const transportKind = z.enum(["mock", "portal", "partner_api"]);
const attemptStatus = z.enum(["queued", "sent", "accepted", "responded", "failed", "cancelled", "rejected"]);
const failureCode = z.enum(["transport_error", "transport_timeout", "invalid_acknowledgement", "provider_rejected"]);

export const providerDescriptorSchema = z.object({
  id: providerIdSchema,
  displayName: z.string().min(1).max(200),
  specialties: z.array(z.string().min(1).max(100)).min(1).max(20),
  transport: transportKind,
  active: z.boolean(),
  synthetic: z.boolean(),
}).strict() satisfies z.ZodType<ProviderDescriptor>;

const envelopeContent = {
  contractVersion: z.literal("1.0"),
  tenantId: id,
  providerId: providerIdSchema,
  specialty: z.string().min(1).max(4000).regex(/\S/),
  reason: z.string().min(1).max(4000).nullable(),
  question: z.string().min(1).max(4000).regex(/\S/),
  summary: z.string().min(1).max(16000),
  assessment: z.string().max(16000),
  plan: z.array(z.string().max(5000)).max(80),
  clinicalFacts: z.array(clinicalFactSchema).max(128),
  missingInformation: z.array(missingInformationSchema).max(128),
  attachments: z.array(attachmentReferenceSchema).max(32),
  safetyFlags: z.array(z.enum(["clinician_review_required", "conflicting_facts", "missing_investigations", "incomplete_referral", "insufficient_clinical_data"])).max(5),
  approval: z.object({ approvedBy: id, approvedAt: isoDateTime }).strict(),
  dataClassification: dataClassificationSchema,
};

/** Strict: demographics, chart identifiers or credentials can never ride along. */
export const consultationEnvelopeContentSchema = z.object(envelopeContent).strict() satisfies z.ZodType<ConsultationEnvelopeContent>;
export const consultationEnvelopeSchema = z.object({
  ...envelopeContent, requestId: z.uuid(), attempt: z.number().int().positive(),
}).strict() satisfies z.ZodType<ConsultationEnvelope>;
/** For envelopes read back from storage: requests recorded before data classification read as synthetic. */
export const storedConsultationEnvelopeSchema = z.preprocess(readLegacyClassification, consultationEnvelopeSchema) satisfies z.ZodType<ConsultationEnvelope>;

export const providerReportSchema = z.object({
  summary: z.string().min(1).max(8000).regex(/\S/),
  recommendations: z.array(z.string().min(1).max(2000)).max(20),
  responder: z.string().min(1).max(200),
}).strict();

export const providerCallbackSchema = z.object({
  contractVersion: z.literal("1.0"),
  requestId: z.uuid(),
  providerId: providerIdSchema,
  responseId: id,
  kind: z.enum(["accepted", "rejected", "report"]),
  sentAt: isoDateTime,
  reason: z.string().min(1).max(2000).optional(),
  report: providerReportSchema.optional(),
  dataClassification: dataClassificationSchema,
}).strict().refine((v) => (v.kind === "report") === (v.report !== undefined) && (v.kind === "rejected" || v.reason === undefined),
  "A report is required only for report callbacks; a reason only for rejections") satisfies z.ZodType<ProviderCallback>;
/** For callbacks read back from storage only. Inbound callbacks must use `providerCallbackSchema`. */
export const storedProviderCallbackSchema = z.preprocess(readLegacyClassification, providerCallbackSchema) satisfies z.ZodType<ProviderCallback>;

export const callbackResultSchema = z.object({
  requestId: z.uuid(), disposition: z.enum(["applied", "ignored", "duplicate"]),
}).strict();

const responseView = z.object({
  requestId: z.uuid(), responseId: id, providerId: providerIdSchema, kind: z.enum(["accepted", "rejected", "report"]),
  receivedAt: isoDateTime, reason: z.string().optional(), report: providerReportSchema.optional(),
});

export const consultationDeliveryViewSchema = z.object({
  draftId: id,
  version: z.number().int().positive(),
  status: z.enum(CONSULTATION_STATUSES),
  provider: z.object({ id: providerIdSchema, displayName: z.string(), transport: transportKind }).nullable(),
  attempts: z.array(z.object({
    requestId: z.uuid(), number: z.number().int().positive(), providerId: providerIdSchema, status: attemptStatus,
    failureCode: failureCode.optional(), createdAt: isoDateTime, updatedAt: isoDateTime,
  })),
  responses: z.array(responseView),
  report: responseView.nullable(),
  canSend: z.boolean(), canRetry: z.boolean(), canSimulate: z.boolean(),
}) satisfies z.ZodType<ConsultationDeliveryView>;

export const dispatchRequestSchema = z.object({
  providerId: providerIdSchema, expectedVersion: z.number().int().positive().max(2147483647), idempotencyKey: id,
}).strict() satisfies z.ZodType<DispatchRequest>;

export const eligibleProvidersSchema = z.array(providerDescriptorSchema.pick({ id: true, displayName: true, specialties: true, transport: true, synthetic: true }));

export const consultationListSchema = z.array(z.object({
  id, status: z.enum(CONSULTATION_STATUSES), specialty: z.string().nullable(), updatedAt: isoDateTime,
}) satisfies z.ZodType<ConsultationListItem>);
