import type { z } from "zod";
import type { ConsultationDeliveryView, DeliveryFailureCode } from "@/shared/contracts";
import { apiErrorSchema, consultationDeliveryViewSchema, consultationDraftSchema, consultationListSchema, eligibleProvidersSchema } from "@/shared/schemas";

export type EligibleProvider = z.infer<typeof eligibleProvidersSchema>[number];

const FAILURE_TEXT: Record<DeliveryFailureCode, string> = {
  transport_error: "The provider could not be reached. Nothing was delivered. You can retry.",
  transport_timeout: "The provider did not confirm receipt in time. You can retry; a late reply will still be linked to this consultation.",
  invalid_acknowledgement: "The provider's confirmation could not be verified. You can retry.",
  provider_rejected: "The provider declined this consultation. Cancel it and prepare a new consultation for another provider.",
};

const STATE_TEXT: Partial<Record<ConsultationDeliveryView["status"], string>> = {
  approved: "Approved. Not sent yet.",
  queued: "Queued for delivery.",
  sent: "Delivered to the provider. Waiting for it to accept.",
  accepted: "Accepted by the provider. Waiting for the specialist's response.",
  responded: "The specialist has responded.",
  failed: "Not delivered.",
  cancelled: "Cancelled.",
};

/** One plain sentence describing where the consultation is, plus what the clinician can do about a failure. */
export function describeDelivery(view: ConsultationDeliveryView): { state: string; problem?: string } {
  const latest = view.attempts[0];
  const problem = view.status === "failed" && latest?.failureCode ? FAILURE_TEXT[latest.failureCode] : undefined;
  return { state: STATE_TEXT[view.status] ?? "Awaiting physician approval.", problem };
}

/** Whether the panel should keep checking for a provider update. */
export function awaitingProvider(view: ConsultationDeliveryView | null | undefined) {
  return !!view && ["queued", "sent", "accepted"].includes(view.status);
}

export class DeliveryError extends Error {}

async function call<T>(schema: z.ZodType<T>, url: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(url, {
    method: method ?? (body === undefined ? "GET" : "POST"), cache: "no-store", credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => { throw new DeliveryError("The server could not be reached. Check your connection and try again."); });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = apiErrorSchema.safeParse(json);
    throw new DeliveryError(error.success ? error.data.error.message : "The request failed. Try again.");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new DeliveryError("The server returned an unexpected response.");
  return parsed.data;
}

const draftUrl = (draftId: string) => `/api/consultations/drafts/${encodeURIComponent(draftId)}`;

export const deliveryApi = {
  view: (draftId: string) => call(consultationDeliveryViewSchema.nullable(), `${draftUrl(draftId)}/delivery`),
  providers: (draftId: string) => call(eligibleProvidersSchema, `${draftUrl(draftId)}/providers`),
  send: (draftId: string, body: { providerId: string; expectedVersion: number; idempotencyKey: string }) =>
    call(consultationDeliveryViewSchema, `${draftUrl(draftId)}/delivery`, body),
  simulate: (draftId: string) => call(consultationDeliveryViewSchema, `${draftUrl(draftId)}/delivery/simulate`, {}),
  list: () => call(consultationListSchema, "/api/consultations/drafts"),
  revise: (draftId: string, body: { expectedVersion: number; idempotencyKey: string; summary: string; assessment: string; plan: string[] }) =>
    call(consultationDraftSchema, draftUrl(draftId), body, "PATCH"),
  /** Asks the model to reword the draft. The server validates the result and returns it to physician review. */
  reviseWithModel: (draftId: string, body: { instruction: string; expectedVersion: number; idempotencyKey: string }) =>
    call(consultationDraftSchema, `${draftUrl(draftId)}/ai-revision`, body),
  create: (body: { patientId: string; encounterId?: string; request: string; idempotencyKey: string }) =>
    call(consultationDraftSchema, "/api/consultations/drafts", body),
  submit: (draftId: string, body: { expectedVersion: number; idempotencyKey: string }) =>
    call(consultationDraftSchema, `${draftUrl(draftId)}/transitions`, { ...body, action: "submit" }),
};
