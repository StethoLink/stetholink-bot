import type { z } from "zod";
import { apiRoutes } from "@/shared/contracts";
import {
  apiErrorSchema,
  chatResponseSchema,
  consultationDraftSchema,
  encounterContextSchema,
  healthResponseSchema,
  patientContextSchema,
} from "@/shared/schemas";
import { ApiClientError } from "./errors";
import type { StethoLinkApiClient } from "./types";

type FetchLike = typeof fetch;

/** Calls the real backend. Every response is validated against its contract. */
export function createHttpApiClient(options: { baseUrl?: string; fetch?: FetchLike } = {}): StethoLinkApiClient {
  const baseUrl = options.baseUrl ?? "";
  const doFetch = options.fetch ?? ((...args: Parameters<FetchLike>) => fetch(...args));

  async function request<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
      });
    } catch {
      throw new ApiClientError("provider_unavailable", "Network request failed");
    }
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const parsed = apiErrorSchema.safeParse(json);
      if (parsed.success) {
        const { code, message, requestId } = parsed.data.error;
        throw new ApiClientError(code, message, res.status, requestId);
      }
      throw new ApiClientError("internal_error", `Unexpected ${res.status} response`, res.status);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiClientError("internal_error", "Response did not match contract", res.status);
    }
    return parsed.data;
  }

  return {
    health: () => request("GET", apiRoutes.health.path(), healthResponseSchema),
    sendChatMessage: (body) => request("POST", apiRoutes.chat.path(), chatResponseSchema, body),
    getPatientContext: (id) => request("GET", apiRoutes.patientContext.path(id), patientContextSchema),
    getEncounterContext: (id) => request("GET", apiRoutes.encounterContext.path(id), encounterContextSchema),
    createConsultationDraft: (body) =>
      request("POST", apiRoutes.createConsultationDraft.path(), consultationDraftSchema, body),
    getConsultationDraft: (id) => request("GET", apiRoutes.getConsultationDraft.path(id), consultationDraftSchema),
    submitApproval: ({ draftId, ...body }) =>
      request("POST", apiRoutes.submitApproval.path(draftId), consultationDraftSchema, { draftId, ...body }),
  };
}
