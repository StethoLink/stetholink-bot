"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiClientError, getApiClient, type StethoLinkApiClient } from "@/shared/api-client";
import type { ApprovalDecision, ConsultationDraft } from "@/shared/contracts";

export type DraftLoadState =
  | { status: "loading" }
  | { status: "ready"; draft: ConsultationDraft }
  | { status: "error"; message: string };

/** Decisions that must carry a reason, so the author of the draft knows what to fix. */
export const DECISIONS_REQUIRING_COMMENT: ReadonlySet<ApprovalDecision> = new Set(["reject", "request_changes"]);

/** A decision can only be made while the draft is still awaiting review (mirrors the server lifecycle). */
export function canReview(draft: ConsultationDraft): boolean {
  return draft.status === "pending_approval" || draft.status === "draft";
}

export function describeDecisionError(err: unknown): string {
  if (err instanceof ApiClientError) {
    if (err.code === "conflict") return "This draft was already reviewed. Reload to see the latest version.";
    if (err.code === "forbidden") return "You are not allowed to review this draft.";
    if (err.code === "unauthenticated") return "Your session has expired. Sign in again.";
  }
  return "Could not submit your decision. Try again.";
}

/**
 * Loads a draft and submits the clinician's decision.
 * Approval is always an explicit user action: this hook never decides on its own.
 */
export function useConsultationDraft(draftId: string, client: StethoLinkApiClient = getApiClient()) {
  const [state, setState] = useState<DraftLoadState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [submitting, setSubmitting] = useState<ApprovalDecision>();
  const [submitError, setSubmitError] = useState<string>();

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    client
      .getConsultationDraft(draftId)
      .then((draft) => active && setState({ status: "ready", draft }))
      .catch((err: unknown) => {
        if (!active) return;
        const notFound = err instanceof ApiClientError && err.code === "not_found";
        setState({ status: "error", message: notFound ? "This draft no longer exists." : "Could not load the draft." });
      });
    return () => {
      active = false;
    };
  }, [draftId, client, reloadKey]);

  const reload = useCallback(() => {
    setSubmitError(undefined);
    setReloadKey((k) => k + 1);
  }, []);

  const decide = useCallback(
    async (decision: ApprovalDecision, comment?: string): Promise<boolean> => {
      const trimmed = comment?.trim() || undefined;
      if (DECISIONS_REQUIRING_COMMENT.has(decision) && !trimmed) {
        setSubmitError("Add a reason before rejecting or requesting changes.");
        return false;
      }
      setSubmitting(decision);
      setSubmitError(undefined);
      try {
        const draft = await client.submitApproval({ draftId, decision, comment: trimmed });
        setState({ status: "ready", draft });
        return true;
      } catch (err) {
        setSubmitError(describeDecisionError(err));
        return false;
      } finally {
        setSubmitting(undefined);
      }
    },
    [client, draftId],
  );

  return { state, submitting, submitError, decide, reload };
}
