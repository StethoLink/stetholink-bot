import { SpecialistInbox, SpecialistSignIn } from "@/apps/embedded-app/features/specialist/SpecialistInbox";
import { AuthError } from "@/platform/auth/session";
import { requireSpecialist } from "@/platform/auth/specialist-session";
import { getEnv } from "@/platform/tenants/env";

export const dynamic = "force-dynamic";
/** The receiving specialist's inbox. It needs a specialist session; a clinician's chart session does not open it. */
export default async function InboxPage() {
  const specialist = await requireSpecialist({ navigation: true }).catch((error: unknown) => {
    if (error instanceof AuthError) return undefined;
    throw error;
  });
  return specialist ? <SpecialistInbox /> : <SpecialistSignIn emailEnabled={getEnv().EMAIL_PROVIDER !== "none"} />;
}
