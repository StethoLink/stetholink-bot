"use client";
import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

export interface TabItem<K extends string> { key: K; label: string; badge?: ReactNode }

/** WAI-ARIA tabs with automatic activation: arrow keys, Home and End move and select. */
export function Tabs<K extends string>({ items, value, onChange, label, children }: {
  items: readonly TabItem<K>[]; value: K; onChange(key: K): void; label: string; children: ReactNode;
}) {
  const id = useId();
  const refs = useRef(new Map<string, HTMLButtonElement>());
  function onKeyDown(event: KeyboardEvent) {
    const index = items.findIndex((item) => item.key === value);
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const step = event.key === "ArrowRight" ? (rtl ? -1 : 1) : event.key === "ArrowLeft" ? (rtl ? 1 : -1) : 0;
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : step ? (index + step + items.length) % items.length : -1;
    if (next < 0) return;
    event.preventDefault();
    onChange(items[next].key);
    refs.current.get(items[next].key)?.focus();
  }
  return (
    <>
      <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex gap-1 border-b border-slate-200">
        {items.map((item) => {
          const selected = item.key === value;
          return (
            <button key={item.key} ref={(node) => { if (node) refs.current.set(item.key, node); }} type="button" role="tab" id={`${id}-tab-${item.key}`}
              aria-selected={selected} aria-controls={`${id}-panel-${item.key}`} tabIndex={selected ? 0 : -1} onClick={() => onChange(item.key)}
              className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium ${selected ? "border-sky-700 text-sky-900" : "border-transparent text-slate-700 hover:text-slate-900"}`}>
              {item.label}{item.badge}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`${id}-panel-${value}`} aria-labelledby={`${id}-tab-${value}`} tabIndex={-1} className="outline-none">{children}</div>
    </>
  );
}
