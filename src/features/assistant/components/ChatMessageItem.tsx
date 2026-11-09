import type { ChatEntry } from "../hooks/chatState";
import styles from "../styles/chat.module.css";
import { SafetyBadge } from "./SafetyBadge";

export function ChatMessageItem({ entry }: { entry: ChatEntry }) {
  const { message, safety, requiresClinicianReview, failed } = entry;
  const isAssistant = message.role === "assistant";
  return (
    <li className={isAssistant ? styles.assistant : styles.clinician}>
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-700">
        <span className="font-semibold">{isAssistant ? "Assistant" : "You"}</span>
        {isAssistant && (
          <span className="rounded border border-sky-800 bg-white px-1.5 py-0.5 font-medium text-sky-900">
            AI-generated
          </span>
        )}
        {safety && <SafetyBadge level={safety.level} />}
      </div>
      <p className={styles.content}>{message.content}</p>
      {safety && safety.reasons.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-xs text-slate-700">
          {safety.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {isAssistant && requiresClinicianReview && (
        <p className="mt-1 text-xs font-medium text-amber-900">
          <span aria-hidden="true">⚠ </span>Needs clinician review before use.
        </p>
      )}
      {failed && (
        <p className="mt-1 text-xs font-medium text-red-800">
          <span aria-hidden="true">✕ </span>Not sent
        </p>
      )}
    </li>
  );
}
