import { z } from "zod";
import { apiRoutes, type OrderDecisionRequest } from "@/shared/contracts";
import { chartWriteResultSchema, createOrderResultSchema, orderDraftListSchema, orderDraftSchema } from "@/shared/schemas";
import { call } from "@/apps/embedded-app/features/consultations/hooks/deliveryState";

const chartResults = z.array(chartWriteResultSchema);

/**
 * The browser's calls to the order routes. Every answer is checked against its contract; a failure is a `DeliveryError` in the
 * clinician's language, carrying the HTTP status so a screen can tell "not set up" (501) from "changed meanwhile" (409).
 */
export const ordersApi = {
  /** The visit's drafts, newest first. Answers 501 when the hospital has no order catalog. */
  list: () => call(orderDraftListSchema, apiRoutes.listOrderDrafts.path()),
  get: (draftId: string) => call(orderDraftSchema, apiRoutes.getOrderDraft.path(draftId)),
  /** A stored draft, or `no_match`. The same key and request return the same draft, so a retry after a timeout drafts nothing twice. */
  create: (body: { request: string; idempotencyKey: string }, signal?: AbortSignal) => call(createOrderResultSchema, apiRoutes.createOrderDraft.path(), body, undefined, signal),
  /** The physician's decisions on lines, in one command that succeeds or changes nothing. */
  decide: (body: OrderDecisionRequest) => call(orderDraftSchema, apiRoutes.decideOrderLines.path(body.draftId), body),
  /** The approved orders and what of them is in the chart. Reads only. */
  chart: (draftId: string) => call(chartResults, apiRoutes.getOrderChart.path(draftId)),
  /** The physician creates each approved order in the EHR, once each. */
  write: (draftId: string) => call(chartResults, apiRoutes.writeOrderChart.path(draftId), {}, "POST"),
};
