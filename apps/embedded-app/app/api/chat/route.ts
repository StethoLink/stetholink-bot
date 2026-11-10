import { chatRequestSchema, chatResponseSchema } from "@/shared/schemas";
import { contractResponse, errorResponse, getChat, handleRouteError, requireClinician } from "@/apps/embedded-app/server";

export async function POST(req: Request) {
  try {
    await requireClinician();
    const parsed = chatRequestSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse("invalid_request", "Invalid chat request");
    const result = await getChat().handle(parsed.data);
    return contractResponse(chatResponseSchema, result);
  } catch (err) {
    return handleRouteError(err);
  }
}
