"use client";

import { useCallback, useReducer, useRef } from "react";
import { getApiClient, type StethoLinkApiClient } from "@/shared/api-client";
import { chatReducer, initialChatState, lastFailedEntry, sendChat } from "./chatState";

export function useChat(options: { patientId?: string; encounterId?: string; client?: StethoLinkApiClient } = {}) {
  const client = options.client ?? getApiClient();
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const send = useCallback(
    (text: string) =>
      sendChat(client, dispatch, {
        text,
        conversationId: stateRef.current.conversationId,
        patientId: options.patientId,
        encounterId: options.encounterId,
      }),
    [client, options.patientId, options.encounterId],
  );

  const retry = useCallback(() => {
    const failed = lastFailedEntry(stateRef.current);
    if (!failed) return Promise.resolve();
    return sendChat(client, dispatch, {
      text: failed.message.content,
      retryOf: failed.message.id,
      conversationId: stateRef.current.conversationId,
      patientId: options.patientId,
      encounterId: options.encounterId,
    });
  }, [client, options.patientId, options.encounterId]);

  return {
    entries: state.entries,
    status: state.status,
    error: state.error,
    canRetry: Boolean(lastFailedEntry(state)),
    send,
    retry,
  };
}
