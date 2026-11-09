import { contractResponse, errorResponse, getConsultations, handleRouteError, requireClinician } from "@/server";
import { consultationDraftSchema, createConsultationDraftRequestSchema } from "@/shared/schemas";

/** Generate a recommendation and persist it under the verified clinician's ownership. */
export async function POST(req: Request) {
  try {
    const session = await requireClinician();
    const input = createConsultationDraftRequestSchema.safeParse(await req.json().catch(() => null));
    if (!input.success) return errorResponse("invalid_request", "Invalid draft request");
    return contractResponse(consultationDraftSchema, await getConsultations(session).create(input.data, session.clinicianId), 201);
  } catch (err) {
    return handleRouteError(err);
  }
}
