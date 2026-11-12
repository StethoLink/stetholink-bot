import { ConsultationComposer } from "@/apps/embedded-app/features/consultations";
import { EncounterSummary, PatientContextCard } from "@/apps/embedded-app/features/ehr-panel";
import { AuthError, requireClinician } from "@/platform/auth/session";
import { getEnv, syntheticStagingEnabled } from "@/platform/tenants/env";
import { describeAssistant } from "@/platform/tenants/model-provider";

export default async function EmbedPage() {
  const session = await requireClinician({ navigation: true }).catch((error: unknown) => {
    if (error instanceof AuthError) return undefined;
    throw error;
  });
  // Presentation only: the server re-checks role, scope and chart on every command.
  const physician = !!session?.context.roles.includes("physician");
  const canReview = physician && !!session?.context.scopes.includes("consultation:approve");
  const canRoute = physician && !!session?.context.scopes.includes("consultation:route");

  return (
    <main className="mx-auto flex w-full max-w-2xl min-w-0 flex-col gap-3 p-2 sm:p-3">
      <h1 className="sr-only">StethoLink assistant</h1>
      {session ? (
        <>
          <PatientContextCard patientId={session.context.patientId} compact />
          {session.context.encounterId && <EncounterSummary encounterId={session.context.encounterId} />}
          {session.source === "synthetic" && (
            <ConsultationComposer patientId={session.context.patientId} encounterId={session.context.encounterId}
              canReview={canReview} canRoute={canRoute} assistant={describeAssistant()} />
          )}
          {session.source === "synthetic" && !canReview && (
            <p className="text-xs text-slate-700">
              This session can prepare drafts only. Approving and sending need a verified physician session.
            </p>
          )}
        </>
      ) : (
        <div role="alert" className="space-y-2 rounded border border-red-700 bg-red-50 p-3 text-sm text-red-800">
          <p>Open StethoLink from the active patient chart in your EHR.</p>
          {syntheticStagingEnabled(getEnv()) && <p><a className="underline" href="/staging">Synthetic staging launch</a></p>}
        </div>
      )}
    </main>
  );
}
