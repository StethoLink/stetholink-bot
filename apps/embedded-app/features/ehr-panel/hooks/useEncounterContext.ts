"use client";

import { getApiClient, type StethoLinkApiClient } from "@/shared/api-client";
import type { EncounterContext } from "@/shared/contracts";
import { useResource } from "./useResource";

export function useEncounterContext(encounterId: string, client: StethoLinkApiClient = getApiClient()) {
  return useResource<EncounterContext>(
    encounterId,
    (id) => client.getEncounterContext(id),
    "Could not load encounter details.",
  );
}
