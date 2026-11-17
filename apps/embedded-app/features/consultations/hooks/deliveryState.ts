import { z } from "zod";
import type { ConsultationClarification, ConsultationDeliveryView } from "@/shared/contracts";
import { currentLocale, currentMessages } from "@/apps/embedded-app/i18n/client";
import { messages, type Locale } from "@/apps/embedded-app/i18n/messages";
import { workEn, type Work } from "@/apps/embedded-app/i18n/work";
import { apiErrorSchema, chartWriteResultSchema, consultationDeliveryViewSchema, consultationDraftSchema, consultationListSchema, createConsultationResultSchema, eligibleProvidersSchema } from "@/shared/schemas";

export type EligibleProvider = z.infer<typeof eligibleProvidersSchema>[number];

/** One plain sentence describing where the consultation is, plus what the clinician can do about a failure. */
export function describeDelivery(view: ConsultationDeliveryView, texts: Work["delivery"] = workEn.delivery): { state: string; problem?: string } {
  const latest = view.attempts[0];
  const problem = view.status === "failed" && latest?.failureCode ? texts.failure[latest.failureCode] : undefined;
  const known = texts.state as Record<string, string>;
  return { state: view.status !== ("fallback" as string) && known[view.status] ? known[view.status] : texts.state.fallback, problem };
}

/** Whether the panel should keep checking for a provider update. */
export function awaitingProvider(view: ConsultationDeliveryView | null | undefined) {
  return !!view && ["queued", "sent", "accepted"].includes(view.status);
}

/** A failed request, in words for the clinician. `status` and `code` are set when the server answered, so a screen can treat 501 or 409 in its own way. */
export class DeliveryError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) { super(message); }
}
/**
 * A failure in words a clinician can act on: what happened and what to do next. In English the server's own
 * explanation is used where it has one; in another language the text for the case, because the server writes English.
 */
export function describeFailure(status: number, error?: { code: string; message: string; requestId?: string }, locale: Locale = currentLocale()): string {
  const t = messages[locale].work.failures;
  // A failure on the server's side carries the reference of its log line.
  return `${failureText(status, t, locale === "en", error)}${error?.requestId ? ` ${t.reference(error.requestId)}` : ""}`;
}
function failureText(status: number, t: Work["failures"], english: boolean, error?: { code: string; message: string }): string {
  const server = english ? error?.message : undefined;
  if (status === 401) return t.sessionEnded;
  if (status === 503) return t.unavailable;
  if (status === 501) return server && !/not configured|not implemented/i.test(server) ? server : t.notSetUp;
  if (status === 409) return t.changed;
  if (status === 403) return server ?? t.noPermission;
  if (status === 422 && error?.code === "safety_blocked") return t.safety;
  if (status >= 500) return t.server;
  return server ?? t.generic;
}

/** Thrown when the clinician stops waiting. The server may still finish; the same idempotency key then returns its result. */
export class CancelledError extends DeliveryError {}
export async function call<T>(schema: z.ZodType<T>, url: string, body?: unknown, method?: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal,
    method: method ?? (body === undefined ? "GET" : "POST"), cache: "no-store", credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => {
    if (signal?.aborted) throw new CancelledError(currentMessages().work.failures.stopped);
    throw new DeliveryError(currentMessages().work.failures.unreachable);
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = apiErrorSchema.safeParse(json);
    throw new DeliveryError(describeFailure(response.status, error.success ? error.data.error : undefined), response.status, error.success ? error.data.error.code : undefined);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new DeliveryError(currentMessages().work.failures.unexpected);
  return parsed.data;
}

const draftUrl = (draftId: string) => `/api/consultations/drafts/${encodeURIComponent(draftId)}`;

export const deliveryApi = {
  view: (draftId: string) => call(consultationDeliveryViewSchema.nullable(), `${draftUrl(draftId)}/delivery`),
  providers: (draftId: string) => call(eligibleProvidersSchema, `${draftUrl(draftId)}/providers`),
  send: (draftId: string, body: { providerId: string; expectedVersion: number; idempotencyKey: string }) =>
    call(consultationDeliveryViewSchema, `${draftUrl(draftId)}/delivery`, body),
  list: () => call(consultationListSchema, "/api/consultations/drafts"),
  chart: (draftId: string) => call(z.array(chartWriteResultSchema), `${draftUrl(draftId)}/chart`),
  writeToChart: (draftId: string, items: ("consultation" | "report")[]) => call(z.array(chartWriteResultSchema), `${draftUrl(draftId)}/chart`, { items }),
  revise: (draftId: string, body: { expectedVersion: number; idempotencyKey: string; summary: string; assessment: string; plan: string[] }) =>
    call(consultationDraftSchema, draftUrl(draftId), body, "PATCH"),
  /** Asks the model to reword the draft. The server validates the result and returns it to physician review. */
  reviseWithModel: (draftId: string, body: { instruction: string; expectedVersion: number; idempotencyKey: string }, signal?: AbortSignal) =>
    call(consultationDraftSchema, `${draftUrl(draftId)}/ai-revision`, body, undefined, signal),
  /** A draft, or the assistant's questions about the request; answer them or proceed by calling again. */
  create: (body: { patientId: string; encounterId?: string; request: string; idempotencyKey: string; clarifications?: ConsultationClarification[]; proceed?: boolean }, signal?: AbortSignal) =>
    call(createConsultationResultSchema, "/api/consultations/drafts", body, undefined, signal),
  submit: (draftId: string, body: { expectedVersion: number; idempotencyKey: string }) =>
    call(consultationDraftSchema, `${draftUrl(draftId)}/transitions`, { ...body, action: "submit" }),
};
