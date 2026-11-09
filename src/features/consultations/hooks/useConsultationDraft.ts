"use client";

import { useCallback, useEffect, useState } from "react";
import { getApiClient, type StethoLinkApiClient } from "@/shared/api-client";
import type { ApprovalDecision, ConsultationDraft } from "@/shared/contracts";

/** Loads a draft and submits the clinician's decision. Approval is always an explicit user action. */
export function useConsultationDraft(draftId: string, client: StethoLinkApiClient = getApiClient()) {
  const [draft, setDraft] = useState<ConsultationDraft>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    client.getConsultationDraft(draftId).then(setDraft, () => setError("Could not load draft"));
  }, [draftId, client]);

  const decide = useCallback(
    async (decision: ApprovalDecision, comment?: string) => {
      try {
        setDraft(await client.submitApproval({ draftId, decision, comment }));
      } catch {
        setError("Could not submit decision");
      }
    },
    [client, draftId],
  );

  return { draft, error, decide };
}
