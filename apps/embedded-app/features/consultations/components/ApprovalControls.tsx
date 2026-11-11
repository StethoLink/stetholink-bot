"use client";

import { useEffect, useId, useState } from "react";
import type { ApprovalDecision, ConsultationStatus } from "@/shared/contracts";
import { isFinalStatus } from "../hooks/draftState";
import styles from "../styles/approval.module.css";

const ACTION_LABEL: Record<ApprovalDecision, string> = {
  approve: "Approve",
  reject: "Reject",
  request_changes: "Edit",
};

export interface ApprovalControlsProps {
  status: ConsultationStatus;
  submitting: boolean;
  error?: string;
  recipientIds?: readonly string[];
  onDecide: (decision: ApprovalDecision, recipientId?: string) => void;
}

/** Explicit, two-step clinician decision. */
export function ApprovalControls({ status, submitting, error, recipientIds = [], onDecide }: ApprovalControlsProps) {
  const [pending, setPending] = useState<ApprovalDecision>();
  const [recipient, setRecipient] = useState("");
  const id = useId();

  // A recorded decision changes the status; close the confirm step and clear the destination.
  useEffect(() => {
    setPending(undefined);
    setRecipient("");
  }, [status]);
  const final = isFinalStatus(status);
  const canConfirm = !submitting && (pending !== "approve" || recipientIds.includes(recipient));

  if (final) {
    return (
      <p className="text-sm text-slate-700" role="status">
        A decision has been recorded. No further action is available.
      </p>
    );
  }

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-2" aria-busy={submitting}>
      <h3 id={`${id}-title`} className="text-sm font-semibold">
        Clinician decision
      </h3>

      {!pending ? (
        <div className="flex flex-wrap gap-2">
          {(Object.keys(ACTION_LABEL) as ApprovalDecision[]).map((d) => (
            <button key={d} type="button" className={styles[d]} disabled={submitting || (d === "approve" && recipientIds.length === 0)} onClick={() => setPending(d)}>
              {ACTION_LABEL[d]}
            </button>
          ))}
        </div>
      ) : (
        <form
          className="space-y-2 rounded border border-slate-400 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canConfirm) return;
            onDecide(pending, pending === "approve" ? recipient : undefined);
          }}
        >
          <p className="text-sm font-medium" id={`${id}-confirm`}>
            {ACTION_LABEL[pending]} this draft?
          </p>
          {pending === "approve" && (
            <label className="block text-sm">
              Destination
              <select className={styles.input} value={recipient} required onChange={(e) => setRecipient(e.target.value)}>
                <option value="">Choose a destination</option>
                {recipientIds.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={styles[pending]} disabled={!canConfirm} aria-describedby={`${id}-confirm`}>
              {submitting ? "Submitting…" : `Confirm ${ACTION_LABEL[pending].toLowerCase()}`}
            </button>
            <button type="button" className={styles.cancel} disabled={submitting} onClick={() => setPending(undefined)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-800">
          {error}
        </p>
      )}
    </section>
  );
}
