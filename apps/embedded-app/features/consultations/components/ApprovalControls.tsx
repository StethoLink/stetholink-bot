"use client";

import { useEffect, useId, useState } from "react";
import type { ApprovalDecision, ConsultationStatus } from "@/shared/contracts";
import { isFinalStatus } from "../hooks/draftState";
import styles from "../styles/approval.module.css";

const ACTION_LABEL: Record<ApprovalDecision, string> = {
  approve: "Approve",
  reject: "Reject",
  request_changes: "Request changes",
};

export interface ApprovalControlsProps {
  status: ConsultationStatus;
  submitting: boolean;
  error?: string;
  onDecide: (decision: ApprovalDecision, comment?: string) => void;
}

/** Explicit, two-step clinician decision. Request changes requires a comment. */
export function ApprovalControls({ status, submitting, error, onDecide }: ApprovalControlsProps) {
  const [pending, setPending] = useState<ApprovalDecision>();
  const [comment, setComment] = useState("");
  const id = useId();

  // A recorded decision changes the status; close the confirm step and clear the comment.
  useEffect(() => {
    setPending(undefined);
    setComment("");
  }, [status]);
  const final = isFinalStatus(status);
  const needsComment = pending === "request_changes";
  const canConfirm = !submitting && (!needsComment || comment.trim().length > 0);

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
            <button key={d} type="button" className={styles[d]} disabled={submitting} onClick={() => setPending(d)}>
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
            onDecide(pending, comment.trim() || undefined);
          }}
        >
          <p className="text-sm font-medium" id={`${id}-confirm`}>
            Confirm: {ACTION_LABEL[pending].toLowerCase()} this draft?
          </p>
          <label htmlFor={`${id}-comment`} className="block text-sm">
            Comment {needsComment ? "(required)" : "(optional)"}
          </label>
          <textarea
            id={`${id}-comment`}
            rows={3}
            required={needsComment}
            aria-required={needsComment}
            className={styles.input}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
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
