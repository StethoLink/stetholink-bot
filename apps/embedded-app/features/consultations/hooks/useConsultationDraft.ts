"use client";

import { useCallback, useEffect, useReducer, useState } from "react";
import { getApiClient, type StethoLinkApiClient } from "@/shared/api-client";
import type { ApprovalDecision, CreateConsultationDraftRequest } from "@/shared/contracts";
import { createDraft, decideDraft, draftReducer, initialDraftState, loadDraft } from "./draftState";

/**
 * Loads or generates a consultation draft and submits the clinician's decision.
 * Approval is always an explicit user action; nothing here approves automatically.
 */
export function useConsultationDraft(draftId?: string, options: { client?: StethoLinkApiClient } = {}) {
  const client = options.client ?? getApiClient();
  const [state, dispatch] = useReducer(draftReducer, initialDraftState);
  const [currentId, setCurrentId] = useState(draftId);

  useEffect(() => setCurrentId(draftId), [draftId]);

  useEffect(() => {
    if (!currentId) return;
    let active = true;
    void loadDraft(client, (a) => active && dispatch(a), currentId);
    return () => {
      active = false;
    };
  }, [client, currentId]);

  const reload = useCallback(() => {
    if (currentId) void loadDraft(client, dispatch, currentId);
  }, [client, currentId]);

  /** Re-reads the draft without replacing the screen with a loading state. */
  const refresh = useCallback(() => {
    if (!currentId) return;
    void client.getConsultationDraft(currentId).then((draft) => dispatch({ type: "loaded", draft })).catch(() => undefined);
  }, [client, currentId]);

  const generate = useCallback(
    async (request: CreateConsultationDraftRequest) => {
      const draft = await createDraft(client, dispatch, request);
      if (draft) setCurrentId(draft.id);
      return draft;
    },
    [client],
  );

  const decide = useCallback(
    (decision: ApprovalDecision, comment?: string) => {
      if (state.status !== "ready") return Promise.resolve();
      return decideDraft(client, dispatch, { draftId: state.draft.id, decision, comment });
    },
    [client, state],
  );

  return { state, reload, refresh, generate, decide };
}
