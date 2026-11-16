"use client";

import { useEffect, useId, useState } from "react";
import type { ApprovalDecision, ConsultationStatus } from "@/shared/contracts";
import { Alert, Button, ConfirmDialog, type ButtonVariant } from "@/apps/embedded-app/components/ui";
import { useT } from "@/apps/embedded-app/i18n/client";
import { isFinalStatus } from "../hooks/draftState";

const VARIANT: Record<ApprovalDecision, ButtonVariant> = { approve: "success", reject: "danger", request_changes: "secondary" };

export interface ApprovalControlsProps {
  status: ConsultationStatus;
  submitting: boolean;
  error?: string;
  /** Tenant-allowed destinations offering the requested specialty. */
  destinations?: readonly { id: string; displayName: string }[];
  /** True until the allowed destinations have been read from the server. */
  destinationsLoading?: boolean;
  onDecide: (decision: ApprovalDecision, recipientId?: string) => void;
}

/** The physician's decision. Each one is confirmed in a dialog that states exactly what it does. */
export function ApprovalControls({ status, submitting, error, destinations = [], destinationsLoading = false, onDecide }: ApprovalControlsProps) {
  const { t } = useT();
  const [pending, setPending] = useState<ApprovalDecision>();
  const [recipient, setRecipient] = useState("");
  const id = useId();
  // A recorded decision changes the status; close the confirm step and clear the destination.
  useEffect(() => {
    setPending(undefined);
    setRecipient("");
  }, [status]);

  const final = isFinalStatus(status);
  const chosen = destinations.find((d) => d.id === recipient);
  const canConfirm = !submitting && (pending !== "approve" || !!chosen);

  if (final) {
    return (
      <p className="text-sm text-slate-700" role="status">
        {status === "rejected" ? t.work.approval.rejectedFinal : t.work.approval.decided}
      </p>
    );
  }

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-2 border-t border-slate-200 pt-3" aria-busy={submitting}>
      <h3 id={`${id}-title`} className="text-sm font-semibold">{t.work.approval.heading}</h3>
      {!destinationsLoading && destinations.length === 0 && (
        <Alert tone="warning">{t.work.approval.noProvider}</Alert>
      )}
      <div className="flex flex-wrap gap-2">
        {(Object.keys(t.work.approval.actions) as ApprovalDecision[]).map((d) => (
          <Button key={d} variant={VARIANT[d]} disabled={submitting || (d === "approve" && destinations.length === 0)} onClick={() => setPending(d)}>
            {t.work.approval.actions[d]}
          </Button>
        ))}
      </div>
      <ConfirmDialog open={!!pending} onClose={() => setPending(undefined)} title={pending ? t.work.approval.titles[pending] : ""} variant={pending ? VARIANT[pending] : "primary"}
        confirmLabel={pending ? t.work.approval.confirm[pending] : t.work.approval.confirmDefault} busy={submitting} canConfirm={canConfirm} error={error}
        onConfirm={() => { if (pending && canConfirm) onDecide(pending, pending === "approve" ? recipient : undefined); }}>
        {pending === "approve" && (
          <>
            <div>
              <label className="field-label" htmlFor={`${id}-destination`}>{t.work.approval.destination}</label>
              <select id={`${id}-destination`} className="field" value={recipient} required onChange={(e) => setRecipient(e.target.value)}>
                <option value="">{t.work.approval.chooseDestination}</option>
                {destinations.map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}
              </select>
            </div>
            <div>
              <p className="font-medium">{t.work.approval.whatHappens}</p>
              <ul className="mt-1 list-disc space-y-0.5 ps-5 text-slate-800">
                {t.work.approval.approveBullets.map((line) => <li key={line}>{line}</li>)}
              </ul>
            </div>
          </>
        )}
        {pending === "reject" && <p>{t.work.approval.rejectText}</p>}
        {pending === "request_changes" && <p>{t.work.approval.changesText}</p>}
      </ConfirmDialog>
      {error && !pending && <Alert tone="danger">{error}</Alert>}
    </section>
  );
}
