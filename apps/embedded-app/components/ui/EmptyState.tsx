import type { ReactNode } from "react";

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center">
      <p className="text-sm font-medium text-slate-900">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-sm text-xs text-slate-700">{children}</p>}
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  );
}
