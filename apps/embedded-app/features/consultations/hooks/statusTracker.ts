import type { ConsultationStatus, DeliveryAttemptStatus } from "@/shared/contracts";

export type StepState = "done" | "current" | "upcoming";
export interface TrackerStep { key: string; label: string; state: StepState }
export interface Tracker {
  steps: TrackerStep[];
  /** Set when the consultation left the normal path. */
  stopped?: { label: string; detail: string };
}

const STEPS = [
  { key: "prepared", label: "Prepared" },
  { key: "approved", label: "Approved" },
  { key: "sending", label: "Sending" },
  { key: "delivered", label: "Delivered" },
  { key: "accepted", label: "Accepted" },
  { key: "responded", label: "Responded" },
] as const;

// The step each stored status corresponds to.
const POSITION: Partial<Record<ConsultationStatus, number>> = {
  draft: 0, pending_review: 0, pending_approval: 0, approved: 1, queued: 2, sent: 3, accepted: 4, responded: 5,
};

/**
 * Progress of a consultation, derived only from the status the server stored and the latest
 * delivery attempt it recorded. Nothing here advances a status.
 */
export function consultationTracker(status: ConsultationStatus, latestAttempt?: DeliveryAttemptStatus): Tracker {
  const terminal: Partial<Record<ConsultationStatus, Tracker["stopped"]>> = {
    rejected: { label: "Rejected", detail: "The physician rejected this draft. Nothing was sent." },
    cancelled: { label: "Cancelled", detail: latestAttempt ? "The consultation was cancelled." : "The consultation was cancelled before it was sent." },
    archived: { label: "Archived", detail: "This consultation is archived." },
    failed: latestAttempt === "rejected"
      ? { label: "Declined", detail: "The provider declined this consultation." }
      : { label: "Not delivered", detail: "The provider did not receive this consultation." },
  };
  const stopped = terminal[status];
  if (stopped) {
    // Keep only the steps the record proves: a send is always preceded by approval, and a decline by delivery.
    const proven = status === "rejected" || (status === "cancelled" && !latestAttempt) ? 0 : latestAttempt === "rejected" ? 3 : 1;
    return { steps: STEPS.map((step, index) => ({ ...step, state: index <= proven ? "done" : "upcoming" })), stopped };
  }
  const position = POSITION[status] ?? 0;
  return {
    steps: STEPS.map((step, index) => ({ ...step, state: index < position || status === "responded" ? "done" : index === position ? "current" : "upcoming" })),
  };
}
