import type { ConsultationStatus } from "@/shared/contracts";

const LABELS: Record<ConsultationStatus, { icon: string; text: string; className: string }> = {
  draft: { icon: "✎", text: "Draft (changes requested)", className: "border-slate-600 text-slate-800 bg-slate-50" },
  pending_approval: { icon: "…", text: "Awaiting clinician review", className: "border-amber-700 text-amber-900 bg-amber-50" },
  pending_review: { icon: "…", text: "Awaiting clinician review", className: "border-amber-700 text-amber-900 bg-amber-50" },
  queued: { icon: "…", text: "Queued for delivery", className: "border-slate-600 text-slate-800 bg-slate-50" },
  sent: { icon: "✓", text: "Delivered to provider", className: "border-slate-600 text-slate-800 bg-slate-50" },
  accepted: { icon: "✓", text: "Accepted by provider", className: "border-slate-600 text-slate-800 bg-slate-50" },
  responded: { icon: "✓", text: "Specialist responded", className: "border-emerald-700 text-emerald-800 bg-emerald-50" },
  failed: { icon: "✕", text: "Not delivered", className: "border-red-700 text-red-800 bg-red-50" },
  cancelled: { icon: "✕", text: "Cancelled", className: "border-slate-600 text-slate-800 bg-slate-50" },
  approved: { icon: "✓", text: "Approved", className: "border-emerald-700 text-emerald-800 bg-emerald-50" },
  rejected: { icon: "✕", text: "Rejected", className: "border-red-700 text-red-800 bg-red-50" },
  archived: { icon: "▣", text: "Archived", className: "border-slate-600 text-slate-800 bg-slate-100" },
};

export function DraftStatusBadge({ status }: { status: ConsultationStatus }) {
  const l = LABELS[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium ${l.className}`}>
      <span aria-hidden="true">{l.icon}</span>
      Status: {l.text}
    </span>
  );
}
