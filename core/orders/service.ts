import type { ClinicianContext } from "@/core/auth/clinician";
import type { ChartWriteResult, CreateOrderDraftRequest, DataClassification, OrderCatalog, OrderDecisionRequest, OrderDraft, OrderDraftSummary, OrderLine, OrderNoMatch } from "@/shared/contracts";
import { createOrderDraftRequestSchema, orderDecisionRequestSchema, orderDraftSchema } from "@/shared/schemas";
import type { ModelProvider } from "@/core/agent/providers/types";
import type { SafetyGuard } from "@/core/agent/safety/guard";
import type { ClinicalDataAdapter } from "@/core/tools/connector";
import { RESOURCE_OF, type ChartWriteItem, type ClinicalWriteAdapter } from "@/core/tools/chart-writer";
import type { ChartWriteLedger } from "@/core/scribe/repository";
import { loadVerifiedChart } from "@/core/consultation/chart";
import { RouteError } from "@/core/errors";
import { MAX_ORDER_ATTEMPTS, ORDERS_PROMPT_VERSION, ORDER_INSTRUCTIONS, buildOrderInput, orderFormat, validateOrders, type OrderAuthoringContext, type ValidatedOrders } from "./authoring";
import { MIN_OVERRIDE_REASON, flagsFor, requiredAcknowledgements } from "./flags";
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
  /** What may be, and was, created in the EHR. Without it nothing can be written, and the approved orders are only listed. */
  ledger?: ChartWriteLedger;
  /** The EHR's write port, or null when this session or EHR takes no writes: the approved orders are then offered as text to enter. */
  writer?: ClinicalWriteAdapter | null;
  audit?: (event: { action: "chart.write"; tenantId: string; clinicianId: string; draftId: string; itemKey: string; resourceType: string; status: string; resourceId?: string }) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND_LABEL = { lab: "Laboratory", imaging: "Imaging", nursing: "Nursing", medication: "Medication" } as const;
/** The key under which an approved line is written to the EHR (and recorded in the ledger): one per line, so a repeat creates nothing more. */
export const orderItemKey = (lineId: string) => `sl-ord-${lineId.replaceAll("-", "")}`;

/** What the EHR is asked to create for an approved line: the catalog's own code and dose, and the physician's acknowledgement and reason as a note. */
export function orderWriteItem(line: OrderLine): Extract<ChartWriteItem, { kind: "service_request" | "medication_request" }> {
  const note = ["Prepared with StethoLink and approved by the ordering physician.",
    ...(line.acknowledged?.length ? [`Acknowledged: ${line.acknowledged.join(", ")}.`] : []), ...(line.overrideReason ? [`Reason: ${line.overrideReason}`] : [])].join(" ");
  const common = { itemKey: orderItemKey(line.id), display: line.display, ...(line.code ? { code: line.code } : {}), physicianNote: note };
  if (line.kind === "medication") {
    if (!line.medication) throw new RouteError("internal_error", "A medication order without its medication");
    return { kind: "medication_request", ...common, medication: line.medication };
  }
  return { kind: "service_request", ...common, orderKind: line.kind };
}
/** The approved order as text, for the clinician to enter where the EHR takes no write. */
export function orderCopyText(line: OrderLine): string {
  const code = line.code ? ` (${line.code.code}, ${line.code.system})` : "";
  if (line.kind === "medication" && line.medication) {
    const { product, dose, route, frequency, duration } = line.medication;
    return `${KIND_LABEL.medication}: ${product}, ${[dose, route, frequency, duration].filter(Boolean).join(", ")}${code}`;
  }
  return `${KIND_LABEL[line.kind]}: ${line.display}${code}`;
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

  /** Approving an order is the physician's: the role, the permission, an active session of the right classification. */
  function requireApproval(actor: ClinicianContext) {
    if (actor.authorization !== "active" || actor.expiresAt <= Date.now() || actor.dataClassification !== classification || !actor.roles.includes("physician") ||
        !actor.scopes.includes("order:approve") || !actor.scopes.includes("order:draft") || !actor.encounterId) {
      throw new RouteError("forbidden", "Physician approval is required");
    }
  }
  /** Writing to the EHR is the physician's too, with the permission to write to the chart. */
  function requireChartWrite(actor: ClinicianContext) {
    requireApproval(actor);
    if (!actor.scopes.includes("chart:write")) throw new RouteError("forbidden", "Only the physician can write to the chart");
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

    /**
     * The physician's decision on lines of a draft: approve or reject each, in one command. Only a mapped physician can decide. An order
     * flagged for an allergy or a major interaction is approved only with that flag acknowledged and a reason. A line that was decided
     * is not decided again, and a retry of the same command returns its first result. Nothing is written to the EHR here.
     */
    async decide(input: OrderDecisionRequest, actor: ClinicianContext): Promise<OrderDraft> {
      requireApproval(actor);
      const parsed = orderDecisionRequestSchema.safeParse(input);
      const lineIds = parsed.success ? parsed.data.decisions.map((decision) => decision.lineId) : [];
      if (!parsed.success || !UUID.test(parsed.data.draftId) || !lineIds.every((id) => UUID.test(id)) || new Set(lineIds).size !== lineIds.length) throw new RouteError("invalid_request", "Invalid order decision");
      const draft = await deps.repository.get(parsed.data.draftId);
      if (!draft) throw new RouteError("not_found", "Order draft not found");
      for (const decision of parsed.data.decisions) {
        const line = draft.lines.find((entry) => entry.id === decision.lineId);
        if (!line) throw new RouteError("not_found", "Order not found");
        // A decided line is the repository's to answer: the retry of a command returns its first result, anything else is refused.
        if (line.status !== "pending" || decision.decision !== "approve") continue;
        const required = requiredAcknowledgements(line.flags);
        if (required.length && (!required.every((kind) => decision.acknowledged?.includes(kind)) || (decision.overrideReason?.trim().length ?? 0) < MIN_OVERRIDE_REASON)) {
          throw new RouteError("invalid_request", `Approving this order needs you to acknowledge ${required.join(" and ")} and to give a reason of at least ${MIN_OVERRIDE_REASON} characters`);
        }
      }
      return orderDraftSchema.parse(await deps.repository.decide(parsed.data));
    },

    /**
     * What of the approved orders of a draft is in the chart, and the text to enter for what is not. With `write`, a physician creates
     * each approved order in the EHR once, as a ServiceRequest or MedicationRequest; a pending or rejected order is never written. Where the EHR takes
     * no such write (OpenEMR 7.0.3 takes neither), the order comes back as "unsupported" with its text.
     */
    async chart(draftId: string, actor: ClinicianContext, options: { write?: boolean } = {}): Promise<ChartWriteResult[]> {
      requireDrafting(actor);
      if (options.write) requireChartWrite(actor);
      if (!UUID.test(draftId)) throw new RouteError("invalid_request", "Invalid draft id");
      const draft = await deps.repository.get(draftId);
      if (!draft) throw new RouteError("not_found", "Order draft not found");
      const ledger = deps.ledger;
      if (!ledger) throw new RouteError("not_implemented", "Writing orders to the chart is not set up");
      const approved = draft.lines.filter((line) => line.status === "approved");
      if (options.write) {
        for (const line of approved) {
          const item = orderWriteItem(line);
          const resourceType = RESOURCE_OF[item.kind];
          // The database opens the ledger row only for a line this physician approved, as the resource its kind needs.
          const opened = await ledger.begin("order", line.id, item.itemKey, resourceType);
          if (opened.status === "created" || opened.status === "existing") continue;
          const outcome = deps.writer ? await deps.writer.create(item) : { status: "unsupported" as const, resourceType, failure: "Writing to the chart is not switched on for this session" };
          await ledger.record(item.itemKey, outcome.status, outcome.resourceId, outcome.failure);
          deps.audit?.({ action: "chart.write", tenantId: actor.tenantId, clinicianId: actor.clinicianId, draftId, itemKey: item.itemKey, resourceType, status: outcome.status, resourceId: outcome.resourceId });
        }
      }
      const results: ChartWriteResult[] = [];
      for (const line of approved) {
        const item = orderWriteItem(line);
        const [row] = await ledger.forOrigin(["order"], line.id);
        const done = row?.status === "created" || row?.status === "existing";
        results.push({
          itemKey: item.itemKey, item: line.id, resourceType: RESOURCE_OF[item.kind], status: row?.status ?? "pending",
          ...(row?.resourceId ? { resourceId: row.resourceId } : {}), ...(row?.failure ? { failure: row.failure } : {}), ...(done ? {} : { copyText: orderCopyText(line) }),
        });
      }
      return results;
    },
  };
}
