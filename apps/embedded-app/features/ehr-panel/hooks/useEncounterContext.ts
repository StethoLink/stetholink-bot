"use client";

import { getApiClient, type StethoLinkApiClient } from "@/shared/api-client";
import type { EncounterContext } from "@/shared/contracts";
import { useT } from "@/apps/embedded-app/i18n/client";
import { useResource } from "./useResource";

export function useEncounterContext(encounterId: string, client: StethoLinkApiClient = getApiClient()) {
  const { t } = useT();
  return useResource<EncounterContext>(
    encounterId,
    (id) => client.getEncounterContext(id),
    t.chart.loadEncounterError,
  );
}
