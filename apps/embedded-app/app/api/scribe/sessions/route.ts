import { contractResponse, errorResponse, handleRouteError, readJson, requireClinician } from "@/apps/embedded-app/server";
import { getScribe } from "@/apps/embedded-app/server/scribe";
import { scribeSessionListSchema, scribeSessionViewSchema, startScribeRequestSchema } from "@/shared/schemas";

/** Starts a recorded visit. Refused unless the clinician states that the patient agreed. */
export async function POST(req: Request) {
  try {
    const session = await requireClinician();
    const input = startScribeRequestSchema.safeParse(await readJson(req));
    if (!input.success) return errorResponse("invalid_request", "Confirm that the patient agreed to the recording before it starts");
    return contractResponse(scribeSessionViewSchema, await getScribe(session).start(input.data), 201);
  } catch (error) { return handleRouteError(error); }
}
export async function GET() {
  try {
    const session = await requireClinician();
    return contractResponse(scribeSessionListSchema, await getScribe(session).list());
  } catch (error) { return handleRouteError(error); }
}
