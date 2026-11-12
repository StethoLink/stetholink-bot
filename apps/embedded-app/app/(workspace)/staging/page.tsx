import { notFound } from "next/navigation";
import { getEnv, syntheticStagingEnabled } from "@/platform/tenants/env";
import { StagingLaunch } from "./StagingLaunch";

export const dynamic = "force-dynamic";

/** Preview-only entry point for the fixed synthetic charts. It does not exist anywhere else. */
export default function StagingPage() {
  const env = getEnv();
  if (!syntheticStagingEnabled(env) || !env.STAGING_LAUNCH_SECRET) notFound();
  return (
    <main className="mx-auto w-full max-w-md p-4">
      <StagingLaunch />
    </main>
  );
}
