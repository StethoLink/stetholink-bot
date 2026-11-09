import { z } from "zod";
import { CONSULTATION_STATUSES, MESSAGE_ROLES, SAFETY_LEVELS } from "@/shared/constants";

export const patientContextSchema = z.object({
  patientId: z.string().min(1),
  displayName: z.string(),
  ageYears: z.number().int().nonnegative().optional(),
  sex: z.enum(["male", "female", "other", "unknown"]).optional(),
  allergies: z.array(z.string()).default([]),
  activeProblems: z.array(z.string()).default([]),
  medications: z.array(z.string()).default([]),
});

export const chatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(MESSAGE_ROLES),
  content: z.string(),
  createdAt: z.string().datetime(),
});

export const safetyAssessmentSchema = z.object({
  level: z.enum(SAFETY_LEVELS),
  reasons: z.array(z.string()).default([]),
});

export const consultationSchema = z.object({
  id: z.string(),
  patientId: z.string(),
  status: z.enum(CONSULTATION_STATUSES),
  messages: z.array(chatMessageSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const assistantRequestSchema = z.object({
  consultationId: z.string().optional(),
  patientId: z.string().optional(),
  message: z.string().min(1).max(8000),
});

export const assistantResponseSchema = z.object({
  consultationId: z.string(),
  reply: chatMessageSchema,
  safety: safetyAssessmentSchema,
});

export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
