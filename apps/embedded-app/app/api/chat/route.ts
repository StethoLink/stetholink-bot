import { chatRequestSchema, chatResponseSchema } from "@/shared/schemas";
import { contractResponse, errorResponse, getChat, handleRouteError, requireClinician } from "@/apps/embedded-app/server";

export async function POST(req: Request) {
  try {
    const session = await requireClinician();
    const parsed = chatRequestSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse("invalid_request", "Invalid chat request");
    const { patientId, encounterId } = session.context;
    if ((parsed.data.patientId !== undefined && parsed.data.patientId !== patientId) ||
        (parsed.data.encounterId !== undefined && parsed.data.encounterId !== encounterId)) {
      return errorResponse("forbidden", "Chat context does not match the active chart");
    }
    const result = await getChat(session).handle({ ...parsed.data, patientId, encounterId });
    return contractResponse(chatResponseSchema, result);
  } catch (err) {
    return handleRouteError(err);
  }
}
