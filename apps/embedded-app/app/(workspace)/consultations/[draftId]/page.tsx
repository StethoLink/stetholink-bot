import { AuthError, requireClinician } from "@/platform/auth/session";
import { ConsultationReview } from "@/apps/embedded-app/features/consultations";

export default async function ConsultationPage({ params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params;
  const session = await requireClinician({ navigation: true }).catch((error: unknown) => {
    if (error instanceof AuthError) return null;
    throw error;
  });
  // Presentation only: the server re-checks role, scope and chart on every command.
  const physician = !!session?.context.roles.includes("physician");
  const canReview = physician && !!session?.context.scopes.includes("consultation:approve");
  const canRoute = physician && !!session?.context.scopes.includes("consultation:route");
  return (
    <main className="mx-auto w-full max-w-3xl p-4 md:p-6">
      <h1 className="mb-4 text-2xl font-semibold">Review consultation</h1>
      <ConsultationReview draftId={draftId} canReview={canReview} canRoute={canRoute} />
    </main>
  );
}
