import { encounterContextSchema } from "@/shared/schemas";
import { contractResponse, errorResponse, getClinicalServices, handleRouteError, requireClinician } from "@/apps/embedded-app/server";

export async function GET(_req: Request, { params }: { params: Promise<{ encounterId: string }> }) {
  try {
    const session = await requireClinician();
    const { encounterId } = await params;
    const encounter = await (await getClinicalServices(session)).adapter.getEncounter(encounterId);
    if (!encounter) return errorResponse("not_found", "Encounter not found");
    return contractResponse(encounterContextSchema, encounter);
  } catch (err) {
    return handleRouteError(err);
  }
}
