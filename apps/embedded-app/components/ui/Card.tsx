import type { HTMLAttributes, ReactNode } from "react";

export function Card({ className = "", padded = true, ...rest }: HTMLAttributes<HTMLElement> & { padded?: boolean }) {
  return <section className={`card${padded ? " card-pad" : ""} ${className}`.trim()} {...rest} />;
}
export function CardHeader({ title, description, actions, level = 2, id }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; level?: 2 | 3; id?: string }) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <header className="mb-2 flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <Heading id={id} className="text-[0.9375rem] font-semibold break-words text-slate-900">{title}</Heading>
        {description && <p className="mt-0.5 text-xs text-slate-700">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}
