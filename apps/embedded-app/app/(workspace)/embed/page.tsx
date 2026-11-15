import { Workspace } from "@/apps/embedded-app/features/workspace";
import { Alert } from "@/apps/embedded-app/components/ui";
import { AuthError, requireClinician } from "@/platform/auth/session";
import { getEnv, syntheticStagingEnabled } from "@/platform/tenants/env";
import { getTenant } from "@/platform/tenants";
import { describeAssistant } from "@/platform/tenants/model-provider";
import { classificationOfSource } from "@/shared/schemas";

export default async function EmbedPage() {
  const session = await requireClinician({ navigation: true }).catch((error: unknown) => {
    if (error instanceof AuthError) return undefined;
    throw error;
  });
  if (!session) {
    return (
      <main className="mx-auto w-full max-w-md p-4">
        <h1 className="sr-only">StethoLink</h1>
        <Alert tone="warning" role="alert" title="Open StethoLink from the patient chart">
          <p>StethoLink opens from the active patient chart in your EHR. If it was open, your session has ended: reopen it from the chart.</p>
          {syntheticStagingEnabled(getEnv()) && <p className="mt-2"><a className="font-medium underline" href="/staging">Synthetic staging launch</a></p>}
        </Alert>
      </main>
    );
  }
  // Presentation only: the server re-checks role, scope and chart on every command.
  const physician = session.context.roles.includes("physician");
  const canReview = physician && session.context.scopes.includes("consultation:approve");
  const canRoute = physician && session.context.scopes.includes("consultation:route");
  // The assistant works on a chart only when the session, the tenant and the chart source share one
  // data classification. An EHR launch on a tenant left in synthetic mode can read the chart and nothing else.
  const tenant = getTenant();
  const assistantEnabled = session.context.dataClassification === tenant.dataClassification &&
    classificationOfSource(tenant.connector) === tenant.dataClassification && session.context.scopes.includes("consultation:draft");
  return (
    <Workspace patientId={session.context.patientId} encounterId={session.context.encounterId} classification={session.context.dataClassification}
      canReview={canReview} canRoute={canRoute} assistantEnabled={assistantEnabled} assistant={describeAssistant()} expiresAt={session.context.expiresAt} />
  );
}
