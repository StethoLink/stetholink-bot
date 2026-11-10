import { ConsultationReview } from "@/apps/embedded-app/features/consultations";

export default async function ConsultationPage({ params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params;
  return (
    <main className="mx-auto w-full max-w-3xl p-4 md:p-6">
      <h1 className="mb-4 text-2xl font-semibold">Review consultation</h1>
      <ConsultationReview draftId={draftId} />
    </main>
  );
}
