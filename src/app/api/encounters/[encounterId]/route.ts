import { encounterContextSchema } from "@/shared/schemas";
import { contractResponse, errorResponse, getServices, handleRouteError, requireClinician } from "@/server";

export async function GET(_req: Request, { params }: { params: Promise<{ encounterId: string }> }) {
  try {
    await requireClinician();
    const { encounterId } = await params;
    const encounter = await getServices().adapter.getEncounter(encounterId);
    if (!encounter) return errorResponse("not_found", "Encounter not found");
    return contractResponse(encounterContextSchema, encounter);
  } catch (err) {
    return handleRouteError(err);
  }
}
