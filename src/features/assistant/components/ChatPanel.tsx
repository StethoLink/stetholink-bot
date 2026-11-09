"use client";

import { useId, useState } from "react";
import { useChat } from "../hooks/useChat";
import styles from "../styles/chat.module.css";

/** Placeholder chat UI. It shows the data flow; it is not the finished design. */
export function ChatPanel({ patientId }: { patientId?: string }) {
  const { messages, status, error, send } = useChat({ patientId });
  const [draft, setDraft] = useState("");
  const inputId = useId();

  return (
    <section aria-labelledby={`${inputId}-title`} className={styles.panel}>
      <h2 id={`${inputId}-title`} className="text-lg font-semibold">
        Assistant
      </h2>
      <p className="text-sm text-slate-600">AI suggestions need clinician review before use.</p>
      <ol aria-live="polite" className="my-3 space-y-2">
        {messages.map((m) => (
          <li key={m.id} className={m.role === "assistant" ? styles.assistant : styles.clinician}>
            <span className="sr-only">{m.role === "assistant" ? "Assistant:" : "You:"}</span>
            {m.content}
          </li>
        ))}
      </ol>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          void send(draft.trim());
          setDraft("");
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          Message the assistant
        </label>
        <textarea
          id={inputId}
          className="w-full rounded border border-slate-300 p-2"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="submit"
          disabled={status === "sending" || !draft.trim()}
          className="mt-2 rounded bg-sky-700 px-4 py-2 text-white disabled:opacity-50"
        >
          {status === "sending" ? "Sending…" : "Send"}
        </button>
      </form>
    </section>
  );
}
