import { contractResponse, handleRouteError } from "@/apps/embedded-app/server/http/respond";
import { getSpecialistInbox } from "@/apps/embedded-app/server/specialist";
import { requireSpecialist } from "@/platform/auth/specialist-session";
import { specialistRequestListSchema } from "@/shared/schemas";

/** Consultation requests sent to the signed-in specialist's own service. */
export async function GET() {
  try {
    return contractResponse(specialistRequestListSchema, await getSpecialistInbox(await requireSpecialist()).list());
  } catch (error) { return handleRouteError(error); }
}
