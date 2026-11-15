import type { ReactNode } from "react";

export type AlertTone = "info" | "success" | "warning" | "danger" | "ai";
/**
 * `danger` and `warning` announce themselves (role="alert"); the others are notes.
 * An error says what happened and, in `action`, what to do next.
 */
export function Alert({ tone = "info", title, children, action, role, className = "", label }: {
  tone?: AlertTone; title?: ReactNode; children?: ReactNode; action?: ReactNode; role?: "alert" | "status" | "note"; className?: string; label?: string;
}) {
  return (
    <div role={role ?? (tone === "danger" ? "alert" : "note")} aria-label={label} className={`alert alert-${tone} ${className}`.trim()}>
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className="break-words">{children}</div>}
      {action && <div className="mt-2 flex flex-wrap gap-2">{action}</div>}
    </div>
  );
}
