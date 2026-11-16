import { ApiClientError, type StethoLinkApiClient } from "@/shared/api-client";
import type { ApprovalRequest, ConsultationDraft, CreateConsultationDraftRequest } from "@/shared/contracts";
import { currentLocale, currentMessages } from "@/apps/embedded-app/i18n/client";

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

/** The server's explanation, with the reference it logged when the failure was on its side. */
const message = (e: unknown, fallback: string) => {
  if (!(e instanceof ApiClientError)) return fallback;
  const t = currentMessages();
  // In English the server's own explanation; in another language the text for the error code, because the server writes English.
  const text = currentLocale() === "en" ? e.message : t.errors[e.code];
  return e.requestId ? t.work.failures.withReference(text, e.requestId) : text;
};

/** True when no further clinician decision can be recorded. */
export function isFinalStatus(status: ConsultationDraft["status"]): boolean {
  return !["draft", "pending_approval", "pending_review"].includes(status);
}

export async function loadDraft(client: StethoLinkApiClient, dispatch: (a: DraftAction) => void, draftId: string) {
  dispatch({ type: "load" });
  try {
    dispatch({ type: "loaded", draft: await client.getConsultationDraft(draftId) });
  } catch (e) {
    dispatch({ type: "loadFailed", error: message(e, currentMessages().work.draftErrors.load) });
  }
}

export async function createDraft(
  client: StethoLinkApiClient,
  dispatch: (a: DraftAction) => void,
  request: CreateConsultationDraftRequest,
): Promise<ConsultationDraft | undefined> {
  dispatch({ type: "load" });
  try {
    const result = await client.createConsultationDraft(request);
    if ("outcome" in result) {
      dispatch({ type: "loadFailed", error: currentMessages().work.draftErrors.questions(result.concerns.map((entry) => entry.question).join(" ")) });
      return undefined;
    }
    dispatch({ type: "loaded", draft: result });
    return result;
  } catch (e) {
    dispatch({ type: "loadFailed", error: message(e, currentMessages().work.draftErrors.generate) });
    return undefined;
  }
}

export async function decideDraft(
  client: StethoLinkApiClient,
  dispatch: (a: DraftAction) => void,
  args: ApprovalRequest,
) {
  dispatch({ type: "submit" });
  try {
    dispatch({ type: "submitted", draft: await client.submitApproval(args) });
  } catch (e) {
    dispatch({ type: "submitFailed", error: message(e, currentMessages().work.draftErrors.submit) });
  }
}
