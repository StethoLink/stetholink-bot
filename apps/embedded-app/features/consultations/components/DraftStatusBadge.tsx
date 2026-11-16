"use client";
import type { ConsultationStatus } from "@/shared/contracts";
import { Badge, type Tone } from "@/apps/embedded-app/components/ui";
import { useT } from "@/apps/embedded-app/i18n/client";

const TONE: Record<ConsultationStatus, Tone> = {
  draft: "neutral", pending_approval: "warning", pending_review: "warning", queued: "neutral", sent: "primary", accepted: "primary",
  responded: "success", failed: "danger", cancelled: "neutral", approved: "success", rejected: "danger", archived: "neutral",
};

export function DraftStatusBadge({ status }: { status: ConsultationStatus }) {
  const { t } = useT();
  return <Badge tone={TONE[status]} dot><span className="sr-only">{t.work.statusPrefix}</span>{t.work.status[status]}</Badge>;
}
