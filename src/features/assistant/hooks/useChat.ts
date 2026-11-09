"use client";

import { useCallback, useState } from "react";
import { ApiClientError, getApiClient, type StethoLinkApiClient } from "@/shared/api-client";
import type { ChatMessage, ChatRequest } from "@/shared/contracts";
import { createId, nowIso } from "@/shared/utils";

type Status = "idle" | "sending" | "error";

export function useChat(options: { patientId?: string; client?: StethoLinkApiClient } = {}) {
  const client = options.client ?? getApiClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string>();
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string>();

  const send = useCallback(
    async (text: string) => {
      const request: ChatRequest = { message: text, conversationId, patientId: options.patientId };
      setMessages((m) => [...m, { id: createId("local"), role: "clinician", content: text, createdAt: nowIso() }]);
      setStatus("sending");
      setError(undefined);
      try {
        const res = await client.sendChatMessage(request);
        setConversationId(res.conversationId);
        setMessages((m) => [...m, res.message]);
        setStatus("idle");
      } catch (e) {
        setError(e instanceof ApiClientError ? e.message : "Something went wrong");
        setStatus("error");
      }
    },
    [client, conversationId, options.patientId],
  );

  return { messages, status, error, send };
}
