/**
 * HTTP API contract — the ONLY coupling point between frontend (CLAUDE)
 * and backend (CODEX). Frontend calls these routes; backend implements them.
 * Changes require a PR touching docs/api-contracts/ and approval from both owners.
 */
import {
  assistantRequestSchema,
  assistantResponseSchema,
  patientContextSchema,
} from "@/shared/schemas";
import { z } from "zod";

export const apiRoutes = {
  health: {
    method: "GET",
    path: "/api/health",
    response: z.object({ status: z.literal("ok"), version: z.string() }),
  },
  assistantMessage: {
    method: "POST",
    path: "/api/assistant",
    request: assistantRequestSchema,
    response: assistantResponseSchema,
  },
  patientContext: {
    method: "GET",
    path: "/api/patients/:patientId/context",
    response: patientContextSchema,
  },
} as const;

export type ApiRoutes = typeof apiRoutes;
