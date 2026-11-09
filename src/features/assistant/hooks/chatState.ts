import { ApiClientError, type StethoLinkApiClient } from "@/shared/api-client";
import type { ChatMessage, ChatRequest, SafetyAssessment } from "@/shared/contracts";
import { createId, nowIso } from "@/shared/utils";

/** A message as shown in the panel. Assistant entries carry the server's safety metadata. */
export interface ChatEntry {
  message: ChatMessage;
  safety?: SafetyAssessment;
  requiresClinicianReview?: boolean;
  failed?: boolean;
}

export interface ChatState {
  entries: ChatEntry[];
  conversationId?: string;
  status: "idle" | "sending" | "error";
  error?: string;
}

export type ChatAction =
  | { type: "sent"; entry: ChatEntry }
  | { type: "retrying"; messageId: string }
  | {
      type: "received";
      conversationId: string;
      message: ChatMessage;
      safety: SafetyAssessment;
      requiresClinicianReview: boolean;
    }
  | { type: "failed"; messageId: string; error: string };

export const initialChatState: ChatState = { entries: [], status: "idle" };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "sent":
      return { ...state, entries: [...state.entries, action.entry], status: "sending", error: undefined };
    case "retrying":
      return {
        ...state,
        status: "sending",
        error: undefined,
        entries: state.entries.map((e) => (e.message.id === action.messageId ? { ...e, failed: false } : e)),
      };
    case "received":
      return {
        ...state,
        conversationId: action.conversationId,
        status: "idle",
        entries: [
          ...state.entries,
          { message: action.message, safety: action.safety, requiresClinicianReview: action.requiresClinicianReview },
        ],
      };
    case "failed":
      return {
        ...state,
        status: "error",
        error: action.error,
        entries: state.entries.map((e) => (e.message.id === action.messageId ? { ...e, failed: true } : e)),
      };
  }
}

export function errorMessage(e: unknown, fallback: string): string {
  return e instanceof ApiClientError ? e.message : fallback;
}

/** Sends one clinician message (or re-sends a failed one) and dispatches the outcome. */
export async function sendChat(
  client: StethoLinkApiClient,
  dispatch: (a: ChatAction) => void,
  args: { text: string; conversationId?: string; patientId?: string; encounterId?: string; retryOf?: string },
): Promise<void> {
  const messageId = args.retryOf ?? createId("local");
  if (args.retryOf) dispatch({ type: "retrying", messageId });
  else dispatch({ type: "sent", entry: { message: { id: messageId, role: "clinician", content: args.text, createdAt: nowIso() } } });

  const request: ChatRequest = {
    message: args.text,
    conversationId: args.conversationId,
    patientId: args.patientId,
    encounterId: args.encounterId,
  };
  try {
    const res = await client.sendChatMessage(request);
    dispatch({
      type: "received",
      conversationId: res.conversationId,
      message: res.message,
      safety: res.safety,
      requiresClinicianReview: res.requiresClinicianReview,
    });
  } catch (e) {
    dispatch({ type: "failed", messageId, error: errorMessage(e, "The assistant could not be reached.") });
  }
}

/** The most recent clinician message that failed to send, if any. */
export function lastFailedEntry(state: ChatState): ChatEntry | undefined {
  return [...state.entries].reverse().find((e) => e.failed && e.message.role === "clinician");
}
