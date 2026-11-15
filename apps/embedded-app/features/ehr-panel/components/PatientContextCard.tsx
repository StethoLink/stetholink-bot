"use client";

import type { StethoLinkApiClient } from "@/shared/api-client";
import { usePatientContext } from "../hooks/usePatientContext";
import { PatientContextView } from "./PatientContextView";
import { ErrorWithRetry, SkeletonBlock } from "./StateViews";

export function PatientContextCard({
  patientId,
  compact,
  client,
}: {
  patientId: string;
  compact?: boolean;
  client?: StethoLinkApiClient;
}) {
  const { state, reload } = usePatientContext(patientId, client);
  if (state.status === "ready") return <PatientContextView patient={state.data} compact={compact} />;
  return (
    <section aria-label="Patient context" className="card card-pad">
      {state.status === "loading" ? (
        <SkeletonBlock label="Loading patient context…" lines={4} />
      ) : (
        <ErrorWithRetry message={state.message} onRetry={reload} />
      )}
    </section>
  );
}
