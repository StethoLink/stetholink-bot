import { patientContextSchema } from "@/shared/schemas";
import { contractResponse, errorResponse, getClinicalServices, handleRouteError, requireClinician } from "@/apps/embedded-app/server";

export async function GET(_req: Request, { params }: { params: Promise<{ patientId: string }> }) {
  try {
    const session = await requireClinician();
    const { patientId } = await params;
    const patient = await (await getClinicalServices(session)).patientContext.getContext(patientId);
    if (!patient) return errorResponse("not_found", "Patient not found");
    return contractResponse(patientContextSchema, patient);
  } catch (err) {
    return handleRouteError(err);
  }
}
