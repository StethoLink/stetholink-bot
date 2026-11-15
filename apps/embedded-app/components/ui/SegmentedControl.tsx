"use client";
import { useId } from "react";

/** A small set of mutually exclusive choices, as a radio group. */
export function SegmentedControl<V extends string>({ label, options, value, onChange, disabled }: {
  label: string; options: readonly { value: V; label: string }[]; value: V; onChange(value: V): void; disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset disabled={disabled} className="inline-flex rounded-md border border-slate-400 bg-white p-0.5">
      <legend className="sr-only">{label}</legend>
      {options.map((option) => (
        <label key={option.value} className={`cursor-pointer rounded px-2.5 py-1 text-xs font-medium has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-sky-600 ${option.value === value ? "bg-sky-700 text-white" : "text-slate-800 hover:bg-slate-100"}`}>
          <input type="radio" name={name} value={option.value} checked={option.value === value} onChange={() => onChange(option.value)} className="sr-only" />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}
