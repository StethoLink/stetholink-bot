import { ChatPanel } from "@/features/assistant";
import { EncounterSummary, PatientContextCard } from "@/features/ehr-panel";

type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

/**
 * Compact, single-column assistant panel for an EHR sidebar iframe (~360 px).
 * Usage: /embed?patientId=syn-pt-001&encounterId=syn-enc-001
 * Patient identifiers here are for display context only; the server authorizes every request.
 */
export default async function EmbedPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const patientId = first(params.patientId);
  const encounterId = first(params.encounterId);

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
          <ChatPanel patientId={patientId} encounterId={encounterId} />
        </>
      )}
    </main>
  );
}
