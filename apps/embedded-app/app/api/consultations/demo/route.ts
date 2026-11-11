import { contractResponse, errorResponse, handleRouteError, requireClinician } from "@/apps/embedded-app/server";
import { previewConsultationDemo } from "@/apps/embedded-app/server/consultation-demo";
import { consultationDraftSchema } from "@/shared/schemas";

/** Authenticated staging preview of the fixed Ahmed synthetic case. Accepts no PHI. */
export async function POST(req: Request) {
  try {
    const session = await requireClinician();
    const body = req.body?.getReader();
    // The HTTP runtime can provide an empty stream even when the caller sends no body.
    if (body && !(await body.read()).done) {
      await body.cancel();
      return errorResponse("invalid_request", "The fixed synthetic demo does not accept a request body");
    }
    return contractResponse(consultationDraftSchema, await previewConsultationDemo(session));
  } catch (error) { return handleRouteError(error); }
}
