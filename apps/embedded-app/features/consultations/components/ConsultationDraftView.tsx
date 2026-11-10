import type { ConsultationDraft } from "@/shared/contracts";
import { DraftStatusBadge } from "./DraftStatusBadge";

function formatDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Presentational view of an AI-generated consultation draft. */
export function ConsultationDraftView({ draft }: { draft: ConsultationDraft }) {
  return (
    <article aria-labelledby={`draft-${draft.id}-title`} className="space-y-3">
      <header className="space-y-2">
        <h2 id={`draft-${draft.id}-title`} className="text-lg font-semibold">
          Consultation draft
        </h2>
        <div className="flex flex-wrap gap-2">
          <span className="rounded border border-sky-800 bg-sky-50 px-1.5 py-0.5 text-xs font-medium text-sky-900">
            AI-generated
          </span>
          <DraftStatusBadge status={draft.status} />
        </div>
        <p className="text-xs text-slate-700">
          AI-generated content. A clinician must review it before it is used in care.
        </p>
      </header>

      <section>
        <h3 className="text-sm font-semibold">Summary</h3>
        <p className="whitespace-pre-wrap text-sm">{draft.summary || "No summary provided."}</p>
      </section>
      <section>
        <h3 className="text-sm font-semibold">Assessment</h3>
        <p className="whitespace-pre-wrap text-sm">{draft.assessment || "No assessment provided."}</p>
      </section>
      <section>
        <h3 className="text-sm font-semibold">Plan</h3>
        {draft.plan.length ? (
          <ol className="list-decimal pl-5 text-sm">
            {draft.plan.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ol>
        ) : (
          <p className="text-sm">No plan items.</p>
        )}
      </section>

      <footer className="text-xs text-slate-700">
        <p>Generated {formatDate(draft.createdAt)}</p>
        {draft.reviewedBy && draft.reviewedAt && (
          <p className="font-medium text-slate-900">
            Reviewed by {draft.reviewedBy} on {formatDate(draft.reviewedAt)}
          </p>
        )}
      </footer>
    </article>
  );
}
