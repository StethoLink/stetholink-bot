import type { ClinicianContext } from "@/core/auth/clinician";
import type { CreateOrderDraftRequest, DataClassification, OrderCatalog, OrderDraft, OrderDraftSummary, OrderLine, OrderNoMatch } from "@/shared/contracts";
import { createOrderDraftRequestSchema, orderDraftSchema } from "@/shared/schemas";
import type { ModelProvider } from "@/core/agent/providers/types";
import type { SafetyGuard } from "@/core/agent/safety/guard";
import type { ClinicalDataAdapter } from "@/core/tools/connector";
import { loadVerifiedChart } from "@/core/consultation/chart";
import { RouteError } from "@/core/errors";
import { MAX_ORDER_ATTEMPTS, ORDERS_PROMPT_VERSION, ORDER_INSTRUCTIONS, buildOrderInput, orderFormat, validateOrders, type OrderAuthoringContext, type ValidatedOrders } from "./authoring";
import { flagsFor } from "./flags";
import type { OrderRepository } from "./repository";

export interface OrderServiceDeps {
  repository: OrderRepository;
  provider: ModelProvider;
  safety: SafetyGuard;
  adapter: ClinicalDataAdapter;
  /** Classification of the verified session this service acts for. The chart, the request to the model and the stored draft all carry it. */
  dataClassification: DataClassification;
  /** The hospital's approved orders. The only source of what a draft may contain. */
  catalog: OrderCatalog;
}

/**
 * Order drafting. The physician's words and the verified chart go to the model, which chooses entries of the hospital's
 * catalog; what it chose is checked against the catalog, the request and the chart, and the code, product and dose are
 * copied from the catalog. Every line is stored pending: nothing here approves, signs, sends or writes anything.
 */
export function createOrderService(deps: OrderServiceDeps) {
  const classification = deps.dataClassification;

  function requireDrafting(actor: ClinicianContext) {
    if (actor.authorization !== "active" || actor.expiresAt <= Date.now() || actor.dataClassification !== classification ||
        !actor.scopes.includes("order:draft") || !actor.encounterId) {
      throw new RouteError("forbidden", "Order drafting is not allowed for this session");
    }
    return { patientId: actor.patientId, encounterId: actor.encounterId };
  }

  async function assertSafe(parts: readonly string[]) {
    const text = parts.filter(Boolean).join("\n");
    if (!text) return;
    if ((await deps.safety.assess(text)).level === "blocked") throw new RouteError("safety_blocked", "Draft withheld by safety check");
  }

  /** One or two model calls. A selection that cannot be read is asked for again, never patched by hand. */
  async function choose(context: OrderAuthoringContext): Promise<{ validated: ValidatedOrders; provider: string; model: string }> {
    let failure: unknown;
    for (let attempt = 0; attempt < MAX_ORDER_ATTEMPTS; attempt++) {
      const result = await deps.provider.generate({
        instructions: ORDER_INSTRUCTIONS,
        // The request, age and sex, the visit reason, the chart's facts and the catalog's names. No name, birth date, identifier, code, product or dose.
        messages: [{ role: "user", content: buildOrderInput(context) }],
        dataClassification: classification,
        structuredOutput: orderFormat,
      });
      try {
        if (result.text.length > 32_000) throw new RouteError("provider_unavailable", "Model response exceeds the draft limit");
        return { validated: validateOrders(result.text, context), provider: result.provider, model: result.model };
      } catch (error) { failure = error; }
    }
    throw failure;
  }

  return {
    /**
     * A stored draft (every line pending), or `no_match` when nothing could be drafted (nothing is stored then).
     * The same idempotency key with the same request returns the stored draft without asking the model again.
     */
    async create(input: CreateOrderDraftRequest, actor: ClinicianContext): Promise<OrderDraft | OrderNoMatch> {
      const chart = requireDrafting(actor);
      const parsed = createOrderDraftRequestSchema.safeParse(input);
      if (!parsed.success) throw new RouteError("invalid_request", "Describe the orders you want prepared");
      const { request, idempotencyKey } = parsed.data;
      const fingerprint = { ...chart, request };
      const replayed = await deps.repository.replay(idempotencyKey, fingerprint);
      if (replayed) return replayed;

      const { encounter, grounded, demographics, chartNotes } = await loadVerifiedChart(deps.adapter, classification, chart);
      const context: OrderAuthoringContext = {
        request, demographics, reasonForVisit: encounter?.reasonForVisit?.trim() || null,
        facts: grounded.facts, eligibleFacts: grounded.eligibleFacts, catalog: deps.catalog,
      };
      const { validated, provider, model } = await choose(context);
      await assertSafe([...validated.lines.map((line) => line.reason), ...validated.unmatched]);
      if (validated.mode === "unclear" || !validated.lines.length) {
        return { outcome: "no_match", request, unmatched: validated.unmatched, rejectedLines: validated.rejected };
      }

      const existing = await deps.repository.existing();
      const lines: OrderLine[] = validated.lines.map(({ item, basis, requestedText, reason, evidenceIds }) => ({
        id: crypto.randomUUID(), catalogItemId: item.id, kind: item.kind, display: item.display,
        // Copied from the catalog, never from the model.
        ...(item.code ? { code: item.code } : {}), ...(item.medication ? { medication: item.medication } : {}),
        basis, ...(requestedText ? { requestedText } : {}), reason, evidenceIds,
        flags: flagsFor(item, validated.lines.filter((other) => other.item.id !== item.id).map((other) => other.item), { catalog: deps.catalog, facts: grounded.facts, existing }),
        status: "pending" as const,
      }));
      // The facts the lines and their flags rest on, so the physician reads the citations beside the order.
      const cited = new Set(lines.flatMap((line) => [...line.evidenceIds, ...line.flags.flatMap((flag) => flag.evidenceIds)]));
      const now = new Date().toISOString();
      const draft = orderDraftSchema.safeParse({
        id: crypto.randomUUID(), patientId: chart.patientId, encounterId: chart.encounterId, mode: validated.mode, request, catalogVersion: deps.catalog.version,
        lines, unmatched: validated.unmatched, clinicalFacts: grounded.facts.filter((fact) => cited.has(fact.id)), missingInformation: grounded.missing, notes: chartNotes,
        provenance: { provider, model, promptVersion: ORDERS_PROMPT_VERSION, dataClassification: classification, rejectedLines: validated.rejected },
        version: 1, createdAt: now, updatedAt: now,
      });
      if (!draft.success) throw new RouteError("provider_unavailable", "Draft could not be validated");
      return orderDraftSchema.parse(await deps.repository.create(draft.data, { key: idempotencyKey, request: fingerprint }));
    },

    async get(id: string, actor: ClinicianContext): Promise<OrderDraft | null> {
      requireDrafting(actor);
      const stored = await deps.repository.get(id);
      return stored ? orderDraftSchema.parse(stored) : null;
    },

    async list(actor: ClinicianContext): Promise<OrderDraftSummary[]> {
      requireDrafting(actor);
      return deps.repository.list();
    },
  };
}
