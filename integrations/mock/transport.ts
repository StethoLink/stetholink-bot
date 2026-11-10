import type { ConsultationDelivery, ConsultationTransport } from "../../core/tools/connector.ts";

export function createMockConsultationTransport(): ConsultationTransport {
  const deliveries = new Map<string, ConsultationDelivery>();
  return {
    async send(draft, recipientId) {
      const existing = deliveries.get(draft.id);
      if (existing) return existing;
      const delivery = {
        draftId: draft.id,
        recipientId,
        status: "responded",
        response: "Synthetic recipient acknowledged the consultation.",
      } satisfies ConsultationDelivery;
      deliveries.set(draft.id, delivery);
      return delivery;
    },
    async status(draftId) {
      return deliveries.get(draftId) ?? null;
    },
  };
}
