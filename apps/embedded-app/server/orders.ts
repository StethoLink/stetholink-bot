import "server-only";
import { clinicalSafetyGuard } from "@/core/agent/safety/guard";
import { RouteError } from "@/core/errors";
import { createOrderService } from "@/core/orders/service";
import { auditConsultation } from "@/platform/audit";
import type { VerifiedLaunch } from "@/platform/auth/identity";
import { createOrderRepository } from "@/platform/persistence/orders";
import { getTenant } from "@/platform/tenants";
import { getModelProvider } from "@/platform/tenants/model-provider";
import { getOrderCatalog } from "@/platform/tenants/order-catalog";
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
  };
}
