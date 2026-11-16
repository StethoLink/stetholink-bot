import "server-only";

/** Structured operational events. Identifiers only: never clinical content, secrets or callback bodies. */
export function auditConsultation(event: {
  action: "scribe.chart_write" | "chart.write" | "consultation.dispatched" | "consultation.dispatch_failed" | "consultation.model_revised" | "provider.callback_recorded" | "provider.callback_refused"
    | "orders.draft_created" | "orders.draft_no_match";
  tenantId: string;
  clinicianId?: string;
  draftId?: string;
  requestId?: string;
  providerId?: string;
  failureCode?: string;
  disposition?: string;
  reason?: string;
  sessionId?: string;
  itemKey?: string;
  resourceType?: string;
  status?: string;
  resourceId?: string;
}) {
  console.info(JSON.stringify({ ...event, at: new Date().toISOString() }));
}
