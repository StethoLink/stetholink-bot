import type { ConsultationStatus } from "@/shared/contracts";
import { Badge, type Tone } from "@/apps/embedded-app/components/ui";

const LABELS: Record<ConsultationStatus, { text: string; tone: Tone }> = {
  draft: { text: "Draft (changes requested)", tone: "neutral" },
  pending_approval: { text: "Awaiting clinician review", tone: "warning" },
  pending_review: { text: "Awaiting clinician review", tone: "warning" },
  queued: { text: "Queued for delivery", tone: "neutral" },
  sent: { text: "Delivered to provider", tone: "primary" },
  accepted: { text: "Accepted by provider", tone: "primary" },
  responded: { text: "Specialist responded", tone: "success" },
  failed: { text: "Not delivered", tone: "danger" },
  cancelled: { text: "Cancelled", tone: "neutral" },
  approved: { text: "Approved", tone: "success" },
  rejected: { text: "Rejected", tone: "danger" },
  archived: { text: "Archived", tone: "neutral" },
};

export function DraftStatusBadge({ status }: { status: ConsultationStatus }) {
  const label = LABELS[status];
  return <Badge tone={label.tone} dot><span className="sr-only">Status: </span>{label.text}</Badge>;
}
