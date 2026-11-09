"use client";

import { useState } from "react";
import { apiRoutes } from "@/shared/contracts";
import type { AssistantResponse } from "@/shared/types";

export function AssistantPanel() {
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState<AssistantResponse | null>(null);

  async function send() {
    const res = await fetch(apiRoutes.assistantMessage.path, {
      method: apiRoutes.assistantMessage.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (res.ok) setReply(apiRoutes.assistantMessage.response.parse(await res.json()));
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <textarea
        className="w-full rounded border border-slate-300 p-2"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Ask about the current patient…"
      />
      <button className="mt-2 rounded bg-sky-700 px-4 py-2 text-white disabled:opacity-50" disabled={!message} onClick={send}>
        Send
      </button>
      {reply && <p className="mt-4 whitespace-pre-wrap">{reply.reply.content}</p>}
    </section>
  );
}
