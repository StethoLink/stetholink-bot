import { contractResponse, errorResponse, getConsultations, handleRouteError, readJson, requireClinician } from "@/apps/embedded-app/server";
import { consultationClarificationNeededSchema, consultationDraftSchema, consultationListSchema, createConsultationDraftRequestSchema } from "@/shared/schemas";

/**
 * Generate a recommendation and persist it under the verified clinician's ownership (201), or
 * return the assistant's questions about the request (200) when it needs clarifying first.
 */
export async function POST(req: Request) {
  try {
    const session = await requireClinician();
    const input = createConsultationDraftRequestSchema.safeParse(await readJson(req));
    if (!input.success) return errorResponse("invalid_request", "Invalid draft request");
    const result = await getConsultations(session).create(input.data);
    return "outcome" in result
      ? contractResponse(consultationClarificationNeededSchema, result, 200)
      : contractResponse(consultationDraftSchema, result, 201);
  } catch (err) {
    return handleRouteError(err);
  }
}

/** Recent consultations for the verified chart, so a physician can return to them later. */
export async function GET() {
  try {
    const session = await requireClinician();
    return contractResponse(consultationListSchema, await getConsultations(session).list());
  } catch (err) {
    return handleRouteError(err);
  }
}
