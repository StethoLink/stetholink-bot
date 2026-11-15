import { z } from "zod";
import type { SpecialistIdentity, SpecialistRequestSummary, SpecialistRequestView } from "@/shared/contracts";
import { providerReportSchema } from "./provider";

const isoDateTime = z.string().datetime({ offset: true });
const status = z.enum(["queued", "sent", "accepted", "responded", "failed", "cancelled", "rejected"]);
const summary = { requestId: z.uuid(), status, sentAt: isoDateTime, specialty: z.string().min(1).max(4000), question: z.string().min(1).max(4000) };
export const specialistRequestListSchema = z.array(z.object(summary).strict() satisfies z.ZodType<SpecialistRequestSummary>);
export const specialistRequestViewSchema = z.object({
  ...summary, reason: z.string().nullable(), summary: z.string().max(16000), assessment: z.string().max(16000), plan: z.array(z.string().max(5000)).max(80),
  responses: z.array(z.object({ kind: z.enum(["accepted", "rejected", "report"]), receivedAt: isoDateTime, reason: z.string().optional(), report: providerReportSchema.optional() }).strict()),
  canAccept: z.boolean(), canDecline: z.boolean(), canReport: z.boolean(),
}).strict() satisfies z.ZodType<SpecialistRequestView>;
export const specialistIdentitySchema = z.object({ displayName: z.string(), service: z.string(), expiresAt: z.number().int() }).strict() satisfies z.ZodType<SpecialistIdentity>;
/** The specialist's reply. Who replies comes from the session, never from this body. */
export const specialistResponseRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted"), idempotencyKey: z.uuid() }).strict(),
  z.object({ kind: z.literal("rejected"), reason: z.string().trim().min(3).max(2000), idempotencyKey: z.uuid() }).strict(),
  z.object({ kind: z.literal("report"), summary: z.string().trim().min(3).max(8000), recommendations: z.array(z.string().trim().min(1).max(2000)).max(20), idempotencyKey: z.uuid() }).strict(),
]);
export const specialistCodeRequestSchema = z.object({ email: z.email().max(254) }).strict();
export const specialistCodeRedeemSchema = z.object({ email: z.email().max(254), code: z.string().trim().min(10).max(12) }).strict();
