import "server-only";

/** Structured operational events. Identifiers only: never clinical content, secrets or callback bodies. */
export function auditConsultation(event: {
  action: "consultation.dispatched" | "consultation.dispatch_failed" | "provider.callback_recorded" | "provider.callback_refused";
  tenantId: string;
  clinicianId?: string;
  draftId?: string;
  requestId?: string;
  providerId?: string;
  failureCode?: string;
  disposition?: string;
  reason?: string;
}) {
  console.info(JSON.stringify({ ...event, at: new Date().toISOString() }));
}
