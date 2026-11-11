import { ApiClientError, type StethoLinkApiClient } from "@/shared/api-client";
import type { ApprovalDecision, ConsultationDraft, CreateConsultationDraftRequest } from "@/shared/contracts";

export type DraftState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; draft: ConsultationDraft; submitting: boolean; submitError?: string };

export type DraftAction =
  | { type: "load" }
  | { type: "loaded"; draft: ConsultationDraft }
  | { type: "loadFailed"; error: string }
  | { type: "submit" }
  | { type: "submitted"; draft: ConsultationDraft }
  | { type: "submitFailed"; error: string };

export const initialDraftState: DraftState = { status: "idle" };

export function draftReducer(state: DraftState, action: DraftAction): DraftState {
  switch (action.type) {
    case "load":
      return { status: "loading" };
    case "loaded":
    case "submitted":
      return { status: "ready", draft: action.draft, submitting: false };
    case "loadFailed":
      return { status: "error", error: action.error };
    case "submit":
      return state.status === "ready" ? { ...state, submitting: true, submitError: undefined } : state;
    case "submitFailed":
      return state.status === "ready" ? { ...state, submitting: false, submitError: action.error } : state;
  }
}

const message = (e: unknown, fallback: string) => (e instanceof ApiClientError ? e.message : fallback);

/** True when no further clinician decision can be recorded. */
export function isFinalStatus(status: ConsultationDraft["status"]): boolean {
  return !["draft", "pending_approval", "pending_review"].includes(status);
}

export async function loadDraft(client: StethoLinkApiClient, dispatch: (a: DraftAction) => void, draftId: string) {
  dispatch({ type: "load" });
  try {
    dispatch({ type: "loaded", draft: await client.getConsultationDraft(draftId) });
  } catch (e) {
    dispatch({ type: "loadFailed", error: message(e, "Could not load the consultation draft.") });
  }
}

export async function createDraft(
  client: StethoLinkApiClient,
  dispatch: (a: DraftAction) => void,
  request: CreateConsultationDraftRequest,
): Promise<ConsultationDraft | undefined> {
  dispatch({ type: "load" });
  try {
    const draft = await client.createConsultationDraft(request);
    dispatch({ type: "loaded", draft });
    return draft;
  } catch (e) {
    dispatch({ type: "loadFailed", error: message(e, "Could not generate a consultation draft.") });
    return undefined;
  }
}

export async function decideDraft(
  client: StethoLinkApiClient,
  dispatch: (a: DraftAction) => void,
  args: { draftId: string; decision: ApprovalDecision; comment?: string },
) {
  dispatch({ type: "submit" });
  try {
    dispatch({ type: "submitted", draft: await client.submitApproval(args) });
  } catch (e) {
    dispatch({ type: "submitFailed", error: message(e, "Could not submit your decision.") });
  }
}
