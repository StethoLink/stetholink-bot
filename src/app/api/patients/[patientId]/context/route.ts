import { patientContextSchema } from "@/shared/schemas";
import { contractResponse, errorResponse, getServices, handleRouteError, requireClinician } from "@/server";

export async function GET(_req: Request, { params }: { params: Promise<{ patientId: string }> }) {
  try {
    await requireClinician();
    const { patientId } = await params;
    const patient = await getServices().patientContext.getContext(patientId);
    if (!patient) return errorResponse("not_found", "Patient not found");
    return contractResponse(patientContextSchema, patient);
  } catch (err) {
    return handleRouteError(err);
  }
}
