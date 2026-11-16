"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { useT } from "@/apps/embedded-app/i18n/client";
import { Button, type ButtonVariant } from "./Button";

/**
 * Modal dialog on the native <dialog> element: focus is trapped, Escape closes it and focus
 * returns to the control that opened it.
 */
export function Dialog({ open, onClose, title, children, footer }: { open: boolean; onClose(): void; title: string; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" aria-labelledby={`${id}-title`} onClose={onClose}
      onClick={(event) => { if (event.target === ref.current) onClose(); }}>
      {open && (
        <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
          <h2 id={`${id}-title`} className="border-b border-slate-200 px-4 py-3 text-[0.9375rem] font-semibold">{title}</h2>
          <div className="space-y-3 overflow-y-auto px-4 py-3 text-sm">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 px-4 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

/**
 * Asked before anything that cannot be undone (approving, sending, writing to the chart).
 * The body states exactly what will happen; nothing happens until the named action is pressed.
 */
export function ConfirmDialog({ open, onClose, onConfirm, title, confirmLabel, variant = "primary", busy = false, canConfirm = true, error, children }: {
  open: boolean; onClose(): void; onConfirm(): void; title: string; confirmLabel: string; variant?: ButtonVariant; busy?: boolean; canConfirm?: boolean; error?: string; children: ReactNode;
}) {
  const { t } = useT();
  return (
    <Dialog open={open} onClose={() => { if (!busy) onClose(); }} title={title} footer={
      <>
        <Button onClick={onClose} disabled={busy}>{t.common.cancel}</Button>
        <Button variant={variant} onClick={onConfirm} busy={busy} busyLabel={t.common.working} disabled={!canConfirm}>{confirmLabel}</Button>
      </>
    }>
      {children}
      {error && <p role="alert" className="alert alert-danger">{error}</p>}
    </Dialog>
  );
}
