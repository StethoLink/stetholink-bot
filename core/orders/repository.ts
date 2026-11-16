import type { OrderDecisionRequest, OrderDraft, OrderDraftSummary } from "@/shared/contracts";
import type { ExistingOrder } from "./flags";

/** What one create request is: the same idempotency key with any other value here is refused. */
export interface OrderCreateRequest {
  patientId: string;
  encounterId: string;
  request: string;
}

/**
 * Where order drafts are kept. An implementation is bound to one verified session: it reads and writes only the
 * drafts of that clinician, chart and data classification, and a draft is stored only with lines that are still pending.
 * A decision on a line is never made through `create`.
 */
export interface OrderRepository {
  get(id: string): Promise<OrderDraft | null>;
  /** The newest drafts of this visit. */
  list(): Promise<OrderDraftSummary[]>;
  /** Orders of this visit that are pending or approved, by catalog id, whoever drafted them: the input of the duplicate check. */
  existing(): Promise<ExistingOrder[]>;
  /** The draft stored under this key for this request, or null. The key used for another request is a `conflict`. */
  replay(key: string, request: OrderCreateRequest): Promise<OrderDraft | null>;
  /** Stores a new draft once per key: a repeat of the same request returns the stored draft, whatever the new one says. */
  create(draft: OrderDraft, retry: { key: string; request: OrderCreateRequest }): Promise<OrderDraft>;
  /**
   * The physician's decision on lines of a draft, in one command that succeeds or changes nothing. The implementation enforces it again:
   * the physician role and the approving permission, the draft's version, a line decided once, and the acknowledgement of an allergy
   * or a major interaction. The same key and decisions return the draft as it is; the key for other decisions is a `conflict`.
   */
  decide(input: OrderDecisionRequest): Promise<OrderDraft>;
}
