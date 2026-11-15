"use client";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

type ToastTone = "success" | "danger" | "info";
interface ToastMessage { id: number; tone: ToastTone; text: string }
const ToastContext = createContext<(text: string, tone?: ToastTone) => void>(() => undefined);

/** Short confirmations in a polite live region. Errors that need action are shown in place, not here. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<ToastMessage[]>([]);
  const next = useRef(0);
  const dismiss = useCallback((id: number) => setMessages((current) => current.filter((message) => message.id !== id)), []);
  const notify = useCallback((text: string, tone: ToastTone = "success") => {
    const id = ++next.current;
    setMessages((current) => [...current.slice(-2), { id, tone, text }]);
    setTimeout(() => dismiss(id), 6000);
  }, [dismiss]);
  const value = useMemo(() => notify, [notify]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite" role="status" className="pointer-events-none fixed inset-x-0 bottom-3 z-50 flex flex-col items-center gap-2 px-3">
        {messages.map((message) => (
          <div key={message.id} className={`alert alert-${message.tone} pointer-events-auto flex w-full max-w-sm items-start justify-between gap-3 shadow-md`}>
            <span>{message.text}</span>
            <button type="button" className="text-xs font-medium underline" onClick={() => dismiss(message.id)}>Dismiss</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
export const useToast = () => useContext(ToastContext);
