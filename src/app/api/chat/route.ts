import { chatRequestSchema, chatResponseSchema } from "@/shared/schemas";
import { contractResponse, errorResponse, getServices, handleRouteError, requireClinician } from "@/server";

export async function POST(req: Request) {
  try {
    await requireClinician();
    const parsed = chatRequestSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse("invalid_request", "Invalid chat request");
    const result = await getServices().chat.handle(parsed.data);
    return contractResponse(chatResponseSchema, result);
  } catch (err) {
    return handleRouteError(err);
  }
}
