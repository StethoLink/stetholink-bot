import { AuthError, requireClinician } from "@/platform/auth/session";
import { getTenant } from "@/platform/tenants";
import { getEnv, syntheticStagingEnabled } from "@/platform/tenants/env";
import { ConsultationReview } from "@/apps/embedded-app/features/consultations";

export default async function ConsultationPage({ params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params;
  const session = await requireClinician({ navigation: true }).catch((error: unknown) => {
    if (error instanceof AuthError) return null;
    throw error;
  });
  const env = getEnv();
  const physician = session?.context.roles.includes("physician") && syntheticStagingEnabled(env);
  const canReview = !!physician && !!session?.context.scopes.includes("consultation:approve");
  const canRoute = !!physician && !!session?.context.scopes.includes("consultation:route") && env.AI_PROVIDER === "mock";
  const recipientIds = canReview ? [...getTenant().recipients] : [];
  return (
    <main className="mx-auto w-full max-w-3xl p-4 md:p-6">
      <h1 className="mb-4 text-2xl font-semibold">Review consultation</h1>
      <ConsultationReview draftId={draftId} canReview={canReview} canRoute={canRoute} recipientIds={recipientIds} />
    </main>
  );
}
