import { z } from "zod";
import { DATA_SOURCES } from "@/shared/constants";
import type {
  AttachmentReference,
  ClinicalFact,
  ClinicalSource,
  ClinicianIdentity,
  ConsultationRequest,
  MissingInformation,
  ProviderId,
} from "@/shared/contracts";

const id = z.string().min(1).max(128).regex(/\S/);
const text = z.string().min(1).max(4000).regex(/\S/);
const timestamp = z.string().datetime({ offset: true });

export const clinicalSourceSchema = z.object({
  type: z.enum(DATA_SOURCES),
  reference: id,
}).strict() satisfies z.ZodType<ClinicalSource>;

const clinicalFactFields = {
  id,
  category: z.enum(["problem", "medication", "allergy", "symptom", "vital_sign", "investigation", "history"]),
  label: text,
  source: clinicalSourceSchema,
  timestamp,
};

export const missingInformationSchema = z.object({
  ...clinicalFactFields,
  status: z.literal("unknown"),
  reason: z.enum(["not_recorded", "not_provided", "not_performed", "pending"]),
}).strict() satisfies z.ZodType<MissingInformation>;

export const clinicalFactSchema = z.discriminatedUnion("status", [
  z.object({
    ...clinicalFactFields,
    status: z.literal("known"),
    value: z.union([text, z.number().finite(), z.boolean()]),
    unit: z.string().min(1).max(64).regex(/\S/).optional(),
  }).strict(),
  missingInformationSchema,
]) satisfies z.ZodType<ClinicalFact>;

export const providerIdSchema = id satisfies z.ZodType<ProviderId>;

/** Internal session projection only; never use this parser as an authentication check. */
export const clinicianIdentitySchema = z.object({
  clinicianId: id,
  roles: z.array(z.enum(["clinician", "admin"])).min(1),
  providerId: providerIdSchema.optional(),
}).strict() satisfies z.ZodType<ClinicianIdentity>;

export const attachmentReferenceSchema = z.object({
  id,
  contentType: z.string().max(255).regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/),
  description: text.optional(),
  source: clinicalSourceSchema,
  timestamp,
}).strict() satisfies z.ZodType<AttachmentReference>;

export const consultationRequestSchema = z.object({
  patientId: id,
  encounterId: id.optional(),
  specialty: text,
  clinicalQuestion: text,
  attachments: z.array(attachmentReferenceSchema).optional(),
}).strict() satisfies z.ZodType<ConsultationRequest>;
