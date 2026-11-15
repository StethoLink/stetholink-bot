import { contractResponse, handleRouteError, requireClinician } from "@/apps/embedded-app/server";
import { getScribe, scribeConfig } from "@/apps/embedded-app/server/scribe";
import { scribeCapabilitiesSchema } from "@/shared/schemas";

/** What the scribe can do in this session. Read before the microphone is ever requested. */
export async function GET() {
  try {
    const session = await requireClinician();
    try {
      return contractResponse(scribeCapabilitiesSchema, getScribe(session).capabilities());
    } catch {
      // No encounter, or the assistant is not enabled for this chart: the scribe is simply off.
      const config = scribeConfig();
      return contractResponse(scribeCapabilitiesSchema, { enabled: false, reason: "The scribe is not available for this chart.", spokenLanguage: config.spokenLanguage, noteLanguage: config.noteLanguage,
        maxMinutes: config.maxVisitMinutes, chunkSeconds: config.chunkSeconds, transcriptRetentionDays: config.transcriptRetentionDays, liveTranscription: false, canApprove: false });
    }
  } catch (error) { return handleRouteError(error); }
}
