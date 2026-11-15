import "server-only";
import { RouteError } from "@/core/errors";
import { createProviderResponseService } from "@/core/routing/responses";
import { auditConsultation } from "@/platform/audit";
import type { SpecialistContext } from "@/platform/auth/specialist-session";
import { database } from "@/platform/persistence/database";
import { createProviderResponseSink } from "@/platform/persistence";
import { getTenant } from "@/platform/tenants";
import type { ProviderCallback, SpecialistRequestSummary, SpecialistRequestView } from "@/shared/contracts";
import { storedConsultationEnvelopeSchema, storedProviderCallbackSchema } from "@/shared/schemas";

/**
 * The inbox of one receiving specialist service. Every read is scoped in the database to the
 * signed-in specialist's tenant, service and data classification. A reply is a provider callback
 * like any other: same validation, same correlation, same state machine. Only the way the sender
 * is authenticated differs (a verified session instead of a signature).
 */
export function getSpecialistInbox(specialist: SpecialistContext) {
  const tenant = getTenant();
  const service = tenant.directory.find((provider) => provider.id === specialist.providerId && provider.active && provider.transport === "portal");
  if (specialist.tenantId !== tenant.id || specialist.dataClassification !== tenant.dataClassification || !service || !tenant.recipients.has(service.id) || !specialist.scopes.includes("inbox:read")) {
    throw new RouteError("forbidden", "This inbox is not available");
  }
  function scoped<T>(work: (tx: import("postgres").TransactionSql) => Promise<T>) {
    return database().begin(async (tx) => {
      await tx`select set_config('statement_timeout', '10000', true), set_config('stetholink.specialist', ${JSON.stringify(specialist)}, true)`;
      return await work(tx);
    }) as Promise<T>;
  }
  const summarize = (row: { request_id: string; status: SpecialistRequestSummary["status"]; sent_at: Date; envelope: unknown }) => {
    const envelope = storedConsultationEnvelopeSchema.parse(row.envelope);
    return { envelope, summary: { requestId: row.request_id, status: row.status, sentAt: row.sent_at.toISOString(), specialty: envelope.specialty, question: envelope.question } };
  };
  async function request(requestId: string): Promise<SpecialistRequestView> {
    return scoped(async (tx) => {
      const [row] = await tx`select * from public.specialist_inbox(${requestId})`;
      if (!row) throw new RouteError("not_found", "Request not found");
      const { envelope, summary } = summarize(row as never);
      const responses = (await tx`select * from public.specialist_responses(${requestId})`).map((response) => {
        const callback = storedProviderCallbackSchema.parse(response.payload);
        return { kind: callback.kind, receivedAt: response.received_at.toISOString(), reason: callback.reason, report: callback.report };
      });
      return {
        ...summary, reason: envelope.reason, summary: envelope.summary, assessment: envelope.assessment, plan: envelope.plan, responses,
        canAccept: summary.status === "sent", canDecline: ["sent", "accepted"].includes(summary.status), canReport: summary.status === "accepted",
      };
    });
  }
  return {
    identity: () => ({ displayName: specialist.displayName, service: service.displayName, expiresAt: specialist.expiresAt }),
    list: () => scoped(async (tx) => (await tx`select * from public.specialist_inbox()`).map((row) => summarize(row as never).summary)),
    request,
    async respond(requestId: string, reply: { kind: "accepted" } | { kind: "rejected"; reason: string } | { kind: "report"; summary: string; recommendations: string[] }, responseId: string) {
      if (!specialist.scopes.includes("inbox:respond")) throw new RouteError("forbidden", "This session cannot reply");
      // The request must be in this service's own inbox before anything is recorded.
      await request(requestId);
      const callback: ProviderCallback = {
        contractVersion: "1.0", requestId, providerId: specialist.providerId, responseId, kind: reply.kind, sentAt: new Date().toISOString(), dataClassification: specialist.dataClassification,
        ...(reply.kind === "rejected" ? { reason: reply.reason } : {}),
        ...(reply.kind === "report" ? { report: { summary: reply.summary, recommendations: reply.recommendations, responder: specialist.displayName } } : {}),
      };
      const result = await createProviderResponseService({ sink: createProviderResponseSink(tenant.id, tenant.dataClassification), dataClassification: tenant.dataClassification }).ingest(specialist.providerId, callback);
      auditConsultation({ action: "provider.callback_recorded", tenantId: tenant.id, providerId: specialist.providerId, requestId, disposition: result.disposition, clinicianId: specialist.specialistId });
      if (result.disposition === "ignored") throw new RouteError("conflict", "This request can no longer take that reply");
      return request(requestId);
    },
  };
}
