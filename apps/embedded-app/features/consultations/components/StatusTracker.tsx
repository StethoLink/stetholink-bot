"use client";
import type { ConsultationStatus, DeliveryAttemptStatus } from "@/shared/contracts";
import { useT } from "@/apps/embedded-app/i18n/client";
import { consultationTracker } from "../hooks/statusTracker";

const DOT = {
  done: "border-emerald-700 bg-emerald-700",
  current: "border-sky-700 bg-white ring-2 ring-sky-200",
  upcoming: "border-slate-400 bg-white",
} as const;
const TEXT = { done: "text-slate-800", current: "font-semibold text-sky-900", upcoming: "text-slate-600" } as const;

/** Where the consultation is, as recorded by the server. */
export function StatusTracker({ status, latestAttempt }: { status: ConsultationStatus; latestAttempt?: DeliveryAttemptStatus }) {
  const { t } = useT();
  const tracker = consultationTracker(status, latestAttempt, t.work.tracker);
  return (
    <div aria-label={t.work.tracker.label} className="space-y-2">
      <ol className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {tracker.steps.map((step) => (
          <li key={step.key} aria-current={step.state === "current" ? "step" : undefined} className={`inline-flex items-center gap-1.5 ${TEXT[step.state]}`}>
            <span aria-hidden="true" className={`size-2 rounded-full border ${DOT[step.state]}`} />
            {step.label}
            <span className="sr-only">: {t.work.tracker.state[step.state === "done" ? "done" : step.state === "current" ? "current" : "upcoming"]}</span>
          </li>
        ))}
      </ol>
      {tracker.stopped && (
        <p role="status" className="alert alert-danger">
          <span className="font-semibold">{tracker.stopped.label}.</span> {tracker.stopped.detail}
        </p>
      )}
    </div>
  );
}
