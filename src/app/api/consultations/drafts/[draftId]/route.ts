import { errorResponse, handleRouteError, requireClinician } from "@/server";

/** Contract defined in docs/api-contracts/README.md. Implementation is a Codex task. */
export async function GET() {
  try {
    await requireClinician();
    return errorResponse("not_implemented", "Not implemented yet");
  } catch (err) {
    return handleRouteError(err);
  }
}
