"use client";

import { getApiClient, type StethoLinkApiClient } from "@/shared/api-client";
import type { PatientContext } from "@/shared/contracts";
import { useResource } from "./useResource";

export function usePatientContext(patientId: string, client: StethoLinkApiClient = getApiClient()) {
  return useResource<PatientContext>(patientId, (id) => client.getPatientContext(id), "Could not load patient context.");
}
