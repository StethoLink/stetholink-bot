import { useId, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

interface FieldProps { label: ReactNode; hint?: ReactNode; hideLabel?: boolean }

export function Textarea({ label, hint, hideLabel, id, className = "", ...rest }: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <div>
      <label htmlFor={fieldId} className={hideLabel ? "sr-only" : "field-label"}>{label}</label>
      <textarea id={fieldId} className={`field ${className}`.trim()} aria-describedby={hint ? `${fieldId}-hint` : undefined} {...rest} />
      {hint && <span id={`${fieldId}-hint`} className="field-hint">{hint}</span>}
    </div>
  );
}
export function Select({ label, hint, hideLabel, id, className = "", children, ...rest }: FieldProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <div>
      <label htmlFor={fieldId} className={hideLabel ? "sr-only" : "field-label"}>{label}</label>
      <select id={fieldId} className={`field ${className}`.trim()} aria-describedby={hint ? `${fieldId}-hint` : undefined} {...rest}>{children}</select>
      {hint && <span id={`${fieldId}-hint`} className="field-hint">{hint}</span>}
    </div>
  );
}
