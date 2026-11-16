"use client";

import { getApiClient, type StethoLinkApiClient } from "@/shared/api-client";
import type { PatientContext } from "@/shared/contracts";
import { useT } from "@/apps/embedded-app/i18n/client";
import { useResource } from "./useResource";

export function usePatientContext(patientId: string, client: StethoLinkApiClient = getApiClient()) {
  const { t } = useT();
  return useResource<PatientContext>(patientId, (id) => client.getPatientContext(id), t.chart.loadPatientError);
}
