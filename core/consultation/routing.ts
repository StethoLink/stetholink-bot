import type { ConsultationRepository } from "./repository.ts";
import type { ConsultationTransport } from "../tools/connector.ts";

type Result = { code: "not_found" | "forbidden" | "conflict" } | {
  delivery: Awaited<ReturnType<ConsultationTransport["send"]>>;
};

export async function routeConsultation(
  repository: Pick<ConsultationRepository, "get">,
  transport: ConsultationTransport,
  allowedRecipients: ReadonlySet<string>,
  draftId: string,
  recipientId: string,
): Promise<Result> {
  const draft = await repository.get(draftId);
  if (!draft) return { code: "not_found" };
  if (!allowedRecipients.has(recipientId)) return { code: "forbidden" };
  if (draft.status !== "approved" || !draft.reviewedBy || !draft.reviewedAt) return { code: "conflict" };
  const delivery = await transport.send(draft, recipientId);
  if (delivery.recipientId !== recipientId) return { code: "conflict" };
  return { delivery };
}
