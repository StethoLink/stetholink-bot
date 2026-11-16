import { Workspace } from "@/apps/embedded-app/features/workspace";
import { Alert } from "@/apps/embedded-app/components/ui";
import { AuthError, requireClinician } from "@/platform/auth/session";
import { getTenant } from "@/platform/tenants";
import { describeAssistant } from "@/platform/tenants/model-provider";
import { classificationOfSource } from "@/shared/schemas";
import { messages } from "@/apps/embedded-app/i18n/messages";
import { getLocale } from "@/apps/embedded-app/i18n/server";

export default async function EmbedPage() {
  const session = await requireClinician({ navigation: true }).catch((error: unknown) => {
    if (error instanceof AuthError) return undefined;
    throw error;
  });
  if (!session) {
    const t = messages[await getLocale()];
    return (
      <main className="mx-auto w-full max-w-md p-4">
        <h1 className="sr-only">{t.appName}</h1>
        <Alert tone="warning" role="alert" title={t.session.noneTitle}>
          <p>{t.session.noneText}</p>
        </Alert>
      </main>
    );
  }
  // Presentation only: the server re-checks role, scope and chart on every command.
  const physician = session.context.roles.includes("physician");
  const canReview = physician && session.context.scopes.includes("consultation:approve");
  const canRoute = physician && session.context.scopes.includes("consultation:route");
  // The assistant works on a chart only when the session, the tenant and the chart source share one data classification.
  const tenant = getTenant();
  const assistantEnabled = session.context.dataClassification === tenant.dataClassification &&
    classificationOfSource(tenant.connector) === tenant.dataClassification && session.context.scopes.includes("consultation:draft");
  return (
    <Workspace patientId={session.context.patientId} encounterId={session.context.encounterId} classification={session.context.dataClassification}
      canReview={canReview} canRoute={canRoute} assistantEnabled={assistantEnabled} assistant={describeAssistant()} expiresAt={session.context.expiresAt} />
  );
}
