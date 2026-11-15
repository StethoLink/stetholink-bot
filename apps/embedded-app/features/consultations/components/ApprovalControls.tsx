"use client";

import { useEffect, useId, useState } from "react";
import type { ApprovalDecision, ConsultationStatus } from "@/shared/contracts";
import { Alert, Button, ConfirmDialog, type ButtonVariant } from "@/apps/embedded-app/components/ui";
import { isFinalStatus } from "../hooks/draftState";

const ACTION_LABEL: Record<ApprovalDecision, string> = { approve: "Approve", reject: "Reject", request_changes: "Edit" };
const VARIANT: Record<ApprovalDecision, ButtonVariant> = { approve: "success", reject: "danger", request_changes: "secondary" };
const TITLE: Record<ApprovalDecision, string> = {
  approve: "Approve this consultation?", reject: "Reject this draft?", request_changes: "Reopen this draft for editing?",
};

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
        {status === "rejected" ? "This draft was rejected. No further action is available." : "The physician's decision has been recorded."}
      </p>
    );
  }

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-2 border-t border-slate-200 pt-3" aria-busy={submitting}>
      <h3 id={`${id}-title`} className="text-sm font-semibold">Clinician decision</h3>
      {!destinationsLoading && destinations.length === 0 && (
        <Alert tone="warning">No allowed provider offers the requested specialty, so this consultation cannot be approved for sending.</Alert>
      )}
      <div className="flex flex-wrap gap-2">
        {(Object.keys(ACTION_LABEL) as ApprovalDecision[]).map((d) => (
          <Button key={d} variant={VARIANT[d]} disabled={submitting || (d === "approve" && destinations.length === 0)} onClick={() => setPending(d)}>
            {ACTION_LABEL[d]}
          </Button>
        ))}
      </div>
      <ConfirmDialog open={!!pending} onClose={() => setPending(undefined)} title={pending ? TITLE[pending] : ""} variant={pending ? VARIANT[pending] : "primary"}
        confirmLabel={pending ? `Confirm ${ACTION_LABEL[pending].toLowerCase()}` : "Confirm"} busy={submitting} canConfirm={canConfirm} error={error}
        onConfirm={() => { if (pending && canConfirm) onDecide(pending, pending === "approve" ? recipient : undefined); }}>
        {pending === "approve" && (
          <>
            <div>
              <label className="field-label" htmlFor={`${id}-destination`}>Destination</label>
              <select id={`${id}-destination`} className="field" value={recipient} required onChange={(e) => setRecipient(e.target.value)}>
                <option value="">Choose a destination</option>
                {destinations.map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}
              </select>
            </div>
            <div>
              <p className="font-medium">What happens when you confirm</p>
              <ul className="mt-1 list-disc space-y-0.5 ps-5 text-slate-800">
                <li>This version of the consultation is recorded as approved by you.</li>
                <li>The approved consultation can only be sent to this provider.</li>
                <li>Nothing is sent yet. Sending is a separate step that you confirm.</li>
                <li>The wording can no longer be changed. To change it, a new consultation is prepared.</li>
              </ul>
            </div>
          </>
        )}
        {pending === "reject" && <p>The draft is closed and marked as rejected by you. Nothing is sent, and it cannot be reopened.</p>}
        {pending === "request_changes" && <p>The draft reopens so you can edit its text. After you save, it returns to review and must be approved again. Nothing is sent.</p>}
      </ConfirmDialog>
      {error && !pending && <Alert tone="danger">{error}</Alert>}
    </section>
  );
}
