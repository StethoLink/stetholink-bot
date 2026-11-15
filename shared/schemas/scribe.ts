import { z } from "zod";
import type {
  ChartWriteResult, NoteStatement, ProposedChartUpdate, ScribeApproval, ScribeCapabilities, ScribeNote, ScribeSessionSummary, ScribeSessionView, TranscriptSegment,
} from "@/shared/contracts";
import { dataClassificationSchema } from "./classification";

const id = z.string().min(1).max(128).regex(/\S/);
const isoDateTime = z.string().datetime({ offset: true });
const speaker = z.enum(["clinician", "patient", "other"]);
export const scribeStatusSchema = z.enum(["recording", "transcribed", "note_ready", "approved", "written", "discarded"]);

export const transcriptSegmentSchema = z.object({
  id: z.string().regex(/^s\d{1,4}$/), speaker: speaker.nullable(), startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative(), text: z.string().min(1).max(4000),
}).strict() satisfies z.ZodType<TranscriptSegment>;

export const noteStatementSchema = z.object({
  id: z.string().regex(/^[soap]\d{1,3}$/), text: z.string().min(1).max(800),
  sources: z.array(z.object({ kind: z.enum(["transcript", "chart"]), id, quote: z.string().min(1).max(600).optional() }).strict()).max(6),
  editedByClinician: z.boolean().optional(),
}).strict() satisfies z.ZodType<NoteStatement>;

export const proposedChartUpdateSchema = z.object({
  id: z.string().regex(/^u\d{1,2}$/), kind: z.enum(["allergy", "condition", "medication", "vital_sign"]),
  name: z.string().min(1).max(160), detail: z.string().min(1).max(300).nullable(), relation: z.enum(["new", "already_in_chart", "conflicts"]),
  chartFactId: id.optional(), explanation: z.string().min(1).max(300).optional(),
  source: z.object({ segmentId: z.string().regex(/^s\d{1,4}$/), quote: z.string().min(1).max(600) }).strict(),
}).strict() satisfies z.ZodType<ProposedChartUpdate>;

const statements = z.array(noteStatementSchema).max(40);
export const scribeNoteSchema = z.object({
  language: z.enum(["en", "ar"]),
  sections: z.object({ subjective: statements, objective: statements, assessment: statements, plan: statements }).strict(),
  proposedUpdates: z.array(proposedChartUpdateSchema).max(40),
  rejectedStatements: z.number().int().nonnegative().max(1000), rejectedUpdates: z.number().int().nonnegative().max(1000),
  provenance: z.object({ provider: z.string().min(1).max(128), model: z.string().min(1).max(256), promptVersion: z.string().min(1).max(128), dataClassification: dataClassificationSchema, liveInference: z.boolean() }).strict(),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), estimatedCostUsd: z.number().nonnegative().nullable(),
    latencyMs: z.number().int().nonnegative(), attempts: z.number().int().positive() }).strict().nullable(),
  generatedAt: isoDateTime,
}).strict() satisfies z.ZodType<ScribeNote>;

export const scribeSelectionSchema = z.object({ note: z.boolean(), updates: z.array(z.string().regex(/^u\d{1,2}$/)).max(40), confirmedAllergies: z.array(z.string().regex(/^u\d{1,2}$/)).max(40).optional() }).strict()
  .refine((value) => (value.confirmedAllergies ?? []).every((id) => value.updates.includes(id)), "Only a selected item can be confirmed");
export const scribeApprovalSchema = z.object({ noteVersion: z.number().int().positive(), selection: scribeSelectionSchema }).strict() satisfies z.ZodType<ScribeApproval>;

export const chartWriteResultSchema = z.object({
  itemKey: z.string().min(8).max(64), item: z.string().min(1).max(64), resourceType: z.string().min(1).max(64),
  status: z.enum(["pending", "created", "existing", "failed", "unsupported"]), resourceId: z.string().max(128).optional(),
  failure: z.string().max(300).optional(), copyText: z.string().max(20000).optional(),
}).strict() satisfies z.ZodType<ChartWriteResult>;

export const scribeSessionViewSchema = z.object({
  id: z.uuid(), status: scribeStatusSchema, consentConfirmedAt: isoDateTime, spokenLanguage: z.string().min(2).max(20), noteLanguage: z.enum(["en", "ar"]),
  segments: z.array(transcriptSegmentSchema).max(4000), transcriptDeleted: z.boolean(), transcriptExpiresAt: isoDateTime,
  note: scribeNoteSchema.nullable(), noteVersion: z.number().int().nonnegative(), approval: scribeApprovalSchema.nullable(), approvedAt: isoDateTime.optional(),
  audioSeconds: z.number().nonnegative(), spendUsd: z.number().nonnegative(), writes: z.array(chartWriteResultSchema).max(60), createdAt: isoDateTime,
}).strict() satisfies z.ZodType<ScribeSessionView>;

export const scribeSessionListSchema = z.array(z.object({ id: z.uuid(), status: scribeStatusSchema, createdAt: isoDateTime, audioSeconds: z.number().nonnegative() }).strict() satisfies z.ZodType<ScribeSessionSummary>);

export const scribeCapabilitiesSchema = z.object({
  enabled: z.boolean(), reason: z.string().max(300).optional(), spokenLanguage: z.string(), noteLanguage: z.enum(["en", "ar"]), maxMinutes: z.number().int().positive(),
  chunkSeconds: z.number().int().positive(), transcriptRetentionDays: z.number().int().positive(), liveTranscription: z.boolean(), canApprove: z.boolean(),
}).strict() satisfies z.ZodType<ScribeCapabilities>;

/** POST /api/scribe/sessions. The clinician states that the patient agreed; nothing is recorded otherwise. */
export const startScribeRequestSchema = z.object({ patientConsentConfirmed: z.literal(true), idempotencyKey: z.uuid() }).strict();
/** PATCH /api/scribe/sessions/:id/note: the physician's edited sections. Sources are kept by statement id. */
export const editScribeNoteRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  sections: z.object({
    subjective: z.array(z.object({ id: z.string().max(8).optional(), text: z.string().trim().min(1).max(800) }).strict()).max(40),
    objective: z.array(z.object({ id: z.string().max(8).optional(), text: z.string().trim().min(1).max(800) }).strict()).max(40),
    assessment: z.array(z.object({ id: z.string().max(8).optional(), text: z.string().trim().min(1).max(800) }).strict()).max(40),
    plan: z.array(z.object({ id: z.string().max(8).optional(), text: z.string().trim().min(1).max(800) }).strict()).max(40),
  }).strict(),
}).strict();
export const relabelSegmentsRequestSchema = z.object({ speakers: z.array(z.object({ id: z.string().regex(/^s\d{1,4}$/), speaker: speaker.nullable() }).strict()).min(1).max(4000) }).strict();
export const approveScribeRequestSchema = z.object({ expectedVersion: z.number().int().positive(), selection: scribeSelectionSchema }).strict();
