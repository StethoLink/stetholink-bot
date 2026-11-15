import { useId, type ReactNode } from "react";

/** Supplementary text on hover and keyboard focus. Never the only place a fact is stated. */
export function Tooltip({ text, children }: { text: string; children: ReactNode }) {
  const id = useId();
  return (
    <span className="group relative inline-flex" aria-describedby={id}>
      {children}
      <span id={id} role="tooltip" className="pointer-events-none absolute start-0 top-full z-20 mt-1 hidden w-max max-w-64 rounded bg-slate-900 px-2 py-1 text-xs font-normal text-white shadow-md group-focus-within:block group-hover:block">{text}</span>
    </span>
  );
}
