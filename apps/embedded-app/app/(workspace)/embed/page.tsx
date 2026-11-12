import { ConsultationComposer } from "@/apps/embedded-app/features/consultations";
import { ChatPanel } from "@/apps/embedded-app/features/assistant";
import { EncounterSummary, PatientContextCard } from "@/apps/embedded-app/features/ehr-panel";
import { AuthError, requireClinician } from "@/platform/auth/session";

export default async function EmbedPage() {
  const session = await requireClinician({ navigation: true }).catch((error: unknown) => {
    if (error instanceof AuthError) return undefined;
    throw error;
  });

  const physician = !!session?.context.roles.includes("physician");
  const canReview = physician && !!session?.context.scopes.includes("consultation:approve");
  const canRoute = physician && !!session?.context.scopes.includes("consultation:route");

  return (
    <main className="mx-auto flex w-full max-w-xl min-w-0 flex-col gap-3 p-2 sm:p-3">
      <h1 className="sr-only">StethoLink assistant</h1>
      {session ? (
        <>
          <PatientContextCard patientId={session.context.patientId} compact />
          {session.context.encounterId && <EncounterSummary encounterId={session.context.encounterId} />}
          {session.source === "synthetic" && <>
            <ConsultationComposer patientId={session.context.patientId} encounterId={session.context.encounterId} canReview={canReview} canRoute={canRoute} />
            <ChatPanel patientId={session.context.patientId} encounterId={session.context.encounterId} />
          </>}
        </>
      ) : (
        <p role="alert" className="rounded border border-red-700 bg-red-50 p-3 text-sm text-red-800">
          Open StethoLink from the active patient chart in your EHR.
        </p>
      )}
    </main>
  );
}
