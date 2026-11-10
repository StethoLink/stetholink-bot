"use client";

import { useId, useState, type KeyboardEvent } from "react";
import type { StethoLinkApiClient } from "@/shared/api-client";
import { useChat } from "../hooks/useChat";
import styles from "../styles/chat.module.css";
import { ChatMessageItem } from "./ChatMessageItem";

export interface ChatPanelProps {
  patientId?: string;
  encounterId?: string;
  client?: StethoLinkApiClient;
}

export function ChatPanel({ patientId, encounterId, client }: ChatPanelProps) {
  const { entries, status, error, canRetry, send, retry } = useChat({ patientId, encounterId, client });
  const [draft, setDraft] = useState("");
  const id = useId();
  const sending = status === "sending";

  const submit = () => {
    const text = draft.trim();
    if (!text || sending) return;
    void send(text);
    setDraft("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <section aria-labelledby={`${id}-title`} className={styles.panel}>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          Assistant
        </h2>
        <p className="text-xs text-slate-700">AI output needs clinician review before use.</p>
      </header>

      <div className={styles.log} aria-busy={sending}>
        {entries.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-700">
            No messages yet. Ask about this patient, for example &ldquo;Summarize active problems&rdquo;.
          </p>
        ) : (
          <ol aria-live="polite" aria-relevant="additions" aria-label="Conversation" className="space-y-2">
            {entries.map((e) => (
              <ChatMessageItem key={e.message.id} entry={e} />
            ))}
          </ol>
        )}
        {sending && (
          <p className="mt-2 text-sm text-slate-700" role="status">
            Assistant is responding…
          </p>
        )}
      </div>

      {error && (
        <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 rounded border border-red-700 bg-red-50 p-2 text-sm text-red-800">
          <span>{error}</span>
          {canRetry && (
            <button type="button" onClick={() => void retry()} disabled={sending} className={styles.secondaryButton}>
              Retry
            </button>
          )}
        </div>
      )}

      <form
        className="mt-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor={id} className="mb-1 block text-sm font-medium">
          Message the assistant
        </label>
        <textarea
          id={id}
          rows={3}
          aria-describedby={`${id}-hint`}
          className={styles.input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p id={`${id}-hint`} className="text-xs text-slate-700">
            Enter to send, Shift+Enter for a new line.
          </p>
          <button type="submit" disabled={sending || !draft.trim()} className={styles.primaryButton}>
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </form>
    </section>
  );
}
