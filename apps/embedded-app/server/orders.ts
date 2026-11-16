import "server-only";
import { clinicalSafetyGuard } from "@/core/agent/safety/guard";
import { RouteError } from "@/core/errors";
import { createOrderService } from "@/core/orders/service";
import { auditConsultation } from "@/platform/audit";
import type { VerifiedLaunch } from "@/platform/auth/identity";
import { createOrderRepository } from "@/platform/persistence/orders";
import { createChartWriteLedger } from "@/platform/persistence/scribe";
import { getTenant } from "@/platform/tenants";
import { getModelProvider } from "@/platform/tenants/model-provider";
import { getOrderCatalog } from "@/platform/tenants/order-catalog";
import { getChartWriter } from "./chart-writer";
import { getClinicalServices, modelPrivacy, requireAssistantData } from "./index";

/**
 * Order drafting for one verified session. The catalog is the hospital's own file; without it nothing is offered.
 * The model call goes through the de-identification layer like every other (`getModelProvider`).
 */
export function getOrders(session: VerifiedLaunch) {
  const actor = session.context;
  const tenant = getTenant();
  if (actor.tenantId !== tenant.id || !actor.encounterId || !actor.scopes.includes("chart:read")) throw new RouteError("forbidden", "An authorized tenant encounter is required");
  const catalog = getOrderCatalog();
  if (!catalog) throw new RouteError("not_implemented", "Order drafting is not set up for this hospital. Ask your StethoLink administrator.");
  const { adapter } = getClinicalServices(session);
  requireAssistantData(session, adapter);
  const service = createOrderService({
    repository: createOrderRepository(actor), provider: getModelProvider(modelPrivacy(session, adapter), "order_drafting"), safety: clinicalSafetyGuard,
    adapter, dataClassification: actor.dataClassification, catalog,
    // Writing to the EHR: the ledger opens a row only for a line this physician approved; the writer exists only for a session the EHR granted writes to.
    ledger: createChartWriteLedger(actor), writer: getChartWriter(session), audit: auditConsultation,
  });
  return {
    async create(input: Parameters<typeof service.create>[0]) {
      const result = await service.create(input, actor);
      // Identifiers and counts only: never the request, an order or the chart.
      auditConsultation({ action: "outcome" in result ? "orders.draft_no_match" : "orders.draft_created", tenantId: tenant.id, clinicianId: actor.clinicianId,
        ...("outcome" in result ? {} : { draftId: result.id }) });
      return result;
    },
    get: (id: string) => service.get(id, actor),
    list: () => service.list(actor),
    /** The physician's decision on lines. Counts only in the log: never an order, a reason or the chart. */
    async decide(input: Parameters<typeof service.decide>[0]) {
      const draft = await service.decide(input, actor);
      auditConsultation({ action: "orders.decided", tenantId: tenant.id, clinicianId: actor.clinicianId, draftId: draft.id,
        approved: input.decisions.filter((entry) => entry.decision === "approve").length, rejected: input.decisions.filter((entry) => entry.decision === "reject").length });
      return draft;
    },
    /** The approved orders and what of them is in the chart; the text to enter for the rest. Reads only. */
    chart: (draftId: string) => service.chart(draftId, actor),
    /** The physician creates each approved order in the EHR once. Create only; where the EHR takes no write the order comes back as text. */
    writeToChart: (draftId: string) => service.chart(draftId, actor, { write: true }),
  };
}
