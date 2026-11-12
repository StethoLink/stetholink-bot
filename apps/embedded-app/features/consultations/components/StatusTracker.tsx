import type { ConsultationStatus, DeliveryAttemptStatus } from "@/shared/contracts";
import { consultationTracker } from "../hooks/statusTracker";

const STYLE = {
  done: "border-emerald-700 bg-emerald-50 text-emerald-900",
  current: "border-sky-800 bg-sky-50 text-sky-900 font-semibold",
  upcoming: "border-slate-300 bg-white text-slate-600",
} as const;
const MARK = { done: "✓", current: "●", upcoming: "○" } as const;

/** Where the consultation is, as recorded by the server. */
export function StatusTracker({ status, latestAttempt }: { status: ConsultationStatus; latestAttempt?: DeliveryAttemptStatus }) {
  const tracker = consultationTracker(status, latestAttempt);
  return (
    <div aria-label="Consultation progress" className="space-y-2">
      <ol className="flex flex-wrap gap-1 text-xs">
        {tracker.steps.map((step) => (
          <li key={step.key} aria-current={step.state === "current" ? "step" : undefined}
            className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 ${STYLE[step.state]}`}>
            <span aria-hidden="true">{MARK[step.state]}</span>
            {step.label}
            <span className="sr-only">: {step.state === "done" ? "completed" : step.state === "current" ? "in progress" : "not yet"}</span>
          </li>
        ))}
      </ol>
      {tracker.stopped && (
        <p role="status" className="rounded border border-red-700 bg-red-50 px-2 py-1 text-sm text-red-800">
          <span className="font-semibold">{tracker.stopped.label}.</span> {tracker.stopped.detail}
        </p>
      )}
    </div>
  );
}
