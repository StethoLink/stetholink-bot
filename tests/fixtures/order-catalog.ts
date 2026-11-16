import type { OrderCatalog, OrderCatalogItem } from "@/shared/contracts";

/**
 * FICTIONAL DATA ONLY. A small order catalog for the tests. The product ships no clinical content: a hospital's catalog, its codes,
 * doses and interaction rules are its own. Nothing here is clinical guidance. This file has no imports at run time, so the end-to-end
 * test (plain Node) can write it out as the catalog file a hospital would configure.
 */
export const orderItem = (over: Partial<OrderCatalogItem> & Pick<OrderCatalogItem, "id" | "kind" | "display">): OrderCatalogItem =>
  ({ synonyms: [], matchTerms: [], groups: [], allergyTerms: [], ...over });

export const ORDER_CATALOG: OrderCatalog = {
  version: "test-1",
  items: [
    orderItem({ id: "lab-cbc", kind: "lab", display: "Complete blood count", synonyms: ["CBC", "full blood count", "عد دم كامل"], code: { system: "urn:test", code: "CBC-1" } }),
    orderItem({ id: "img-cxr", kind: "imaging", display: "Chest X-ray, two views", synonyms: ["chest x-ray", "CXR", "أشعة صدر"], code: { system: "urn:test", code: "CXR-2" } }),
    orderItem({ id: "lab-trop", kind: "lab", display: "High-sensitivity troponin", synonyms: ["troponin"] }),
    orderItem({ id: "lab-lipids", kind: "lab", display: "Lipid panel", synonyms: ["lipids"] }),
    orderItem({ id: "nur-obs", kind: "nursing", display: "Vital signs every 4 hours", synonyms: ["observations q4h"] }),
    orderItem({ id: "med-amox", kind: "medication", display: "Amoxicillin 500 mg capsule", synonyms: ["amoxicillin"], matchTerms: ["amoxicillin"], allergyTerms: ["penicillin"],
      medication: { product: "Amoxicillin", dose: "500 mg", route: "oral", frequency: "every 8 hours", duration: "7 days" } }),
    orderItem({ id: "med-ibu", kind: "medication", display: "Ibuprofen 400 mg tablet", synonyms: ["ibuprofen"], matchTerms: ["ibuprofen"], groups: ["nsaid"],
      medication: { product: "Ibuprofen", dose: "400 mg", route: "oral", frequency: "every 8 hours" } }),
    orderItem({ id: "med-warf", kind: "medication", display: "Warfarin 5 mg tablet", synonyms: ["warfarin"], matchTerms: ["warfarin"], groups: ["anticoagulant"],
      medication: { product: "Warfarin", dose: "5 mg", route: "oral", frequency: "once daily" } }),
  ],
  sets: [{ id: "set-chest", name: "Chest pain basics", synonyms: ["basic orders", "الطلبات الأساسية"], itemIds: ["lab-cbc", "img-cxr", "lab-trop", "nur-obs"] }],
  interactions: [{ groups: ["nsaid", "anticoagulant"], severity: "major", text: "An NSAID with an anticoagulant raises the risk of bleeding." }],
};
