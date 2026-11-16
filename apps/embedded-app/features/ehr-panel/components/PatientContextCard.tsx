"use client";

import type { StethoLinkApiClient } from "@/shared/api-client";
import { useT } from "@/apps/embedded-app/i18n/client";
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
  const { t } = useT();
  const { state, reload } = usePatientContext(patientId, client);
  if (state.status === "ready") return <PatientContextView patient={state.data} compact={compact} />;
  return (
    <section aria-label={t.patient.contextLabel} className="card card-pad">
      {state.status === "loading" ? (
        <SkeletonBlock label={t.patient.loadingContext} lines={4} />
      ) : (
        <ErrorWithRetry message={state.message} code={state.code} reference={state.reference} onRetry={reload} />
      )}
    </section>
  );
}
