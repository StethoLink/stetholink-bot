import { ConsultationComposer } from "@/apps/embedded-app/features/consultations";
import { ChatPanel } from "@/apps/embedded-app/features/assistant";
import { EncounterSummary, PatientContextCard } from "@/apps/embedded-app/features/ehr-panel";

import { getTenant } from "@/platform/tenants";
import { getSmartGrant } from "@/platform/auth/smart-session";
import { requireClinician } from "@/platform/auth/session";

type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

/**
 * Compact, single-column assistant panel for an EHR sidebar iframe (~360 px).
 * Usage: /embed?patientId=syn-pt-001&encounterId=syn-enc-001
 * Query parameters select synthetic fixtures. SMART mode uses the server-held launch grant.
 */
export default async function EmbedPage({ searchParams }: { searchParams: Promise<Params> }) {
  const synthetic = getTenant().connector === "synthetic";
  const params = await searchParams;
  const grant = synthetic ? undefined : await requireClinician({ navigation: true }).then(getSmartGrant).catch(() => undefined);
  const patientId = synthetic ? first(params.patientId) : grant?.patientId;
  const encounterId = synthetic ? first(params.encounterId) : grant?.encounterId;

  return (
    <main className="mx-auto flex w-full max-w-xl min-w-0 flex-col gap-3 p-2 sm:p-3">
      <h1 className="sr-only">StethoLink assistant</h1>
      {!patientId ? (
        <p role="alert" className="rounded border border-red-700 bg-red-50 p-3 text-sm text-red-800">
          No patient selected. Open the assistant from a patient chart in the EHR.
        </p>
      ) : (
        <>
          <PatientContextCard patientId={patientId} compact />
          {encounterId && <EncounterSummary encounterId={encounterId} />}
          {synthetic && <>
            <ConsultationComposer key={patientId + ":" + (encounterId ?? "")} patientId={patientId} encounterId={encounterId} />
            <ChatPanel patientId={patientId} encounterId={encounterId} />
          </>}
        </>
      )}
    </main>
  );
}
