import type { ClinicalFact, ConsultationDraft } from "@/shared/contracts";
import { MISSING_INFORMATION_TITLE, SUGGESTION_PREFIX, citedEvidenceIds, parseReferralText, parseStatement } from "@/shared/utils/referral-text";
import { DraftStatusBadge } from "./DraftStatusBadge";

function formatDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
const UNAVAILABLE: Record<string, string> = { not_recorded: "not recorded", not_provided: "not provided", not_performed: "not performed", pending: "result pending" };
function factValue(fact: ClinicalFact) {
  if (fact.status === "unknown") return UNAVAILABLE[fact.reason] ?? "not available";
  if (typeof fact.value === "boolean") return "documented";
  return `${String(fact.value)}${fact.unit ? ` ${fact.unit}` : ""}`;
}
const anchor = (draftId: string, factId: string) => `source-${draftId}-${factId}`;
const tag = "rounded border px-1.5 py-0.5 text-xs font-medium";

function SourceLinks({ draftId, ids, facts }: { draftId: string; ids: string[]; facts: Map<string, ClinicalFact> }) {
  if (!ids.length) return <span className={`${tag} border-amber-700 bg-amber-50 text-amber-900`}>No chart source</span>;
  return (
    <>
      {ids.map((id) => facts.has(id) ? (
        <a key={id} href={`#${anchor(draftId, id)}`} title={`${facts.get(id)!.label}: ${factValue(facts.get(id)!)}`}
          className={`${tag} border-sky-800 bg-sky-50 text-sky-900 underline-offset-2 hover:underline`}>
          Source: {facts.get(id)!.label}
        </a>
      ) : (
        <span key={id} className={`${tag} border-red-700 bg-red-50 text-red-800`}>Unknown source {id}</span>
      ))}
    </>
  );
}

function Provenance({ draft }: { draft: ConsultationDraft }) {
  const grounding = draft.grounding;
  const authoring = grounding?.authoring;
  if (!grounding || !authoring) return <p className="text-xs text-slate-700">AI-generated content. A clinician must review it before it is used in care.</p>;
  if (!authoring.liveInference) {
    return (
      <p role="note" className="rounded border border-amber-700 bg-amber-50 p-2 text-xs text-amber-900">
        <span className="font-semibold">Demo fallback, not AI.</span> No language model is configured, so the chart record was copied into the
        sections without any model inference. Revision instructions are not interpreted in this mode.
      </p>
    );
  }
  const usage = authoring.usage;
  return (
    <p className="text-xs text-slate-700">
      Drafted by {grounding.provenance.provider} model <span className="font-medium">{grounding.provenance.model}</span>
      {usage && <> · {usage.inputTokens + usage.outputTokens} tokens{usage.estimatedCostUsd !== null && <> · est. ${usage.estimatedCostUsd.toFixed(4)}</>} · {(usage.latencyMs / 1000).toFixed(1)} s</>}.
      {" "}Every statement was checked against the chart facts it cites. A physician must review it before it is used in care.
    </p>
  );
}

/** A model-authored consultation request: each statement beside its chart sources, gaps and AI suggestions kept apart. */
function ReferralView({ draft }: { draft: ConsultationDraft }) {
  const facts = new Map((draft.clinicalFacts ?? []).map((fact) => [fact.id, fact]));
  const parsed = parseReferralText(draft.summary);
  const cited = new Set(citedEvidenceIds(draft.summary));
  const question = parsed.header.find((line) => line.label === "Clinical question")?.value ?? draft.grounding?.question;
  const reason = parsed.header.find((line) => line.label === "Reason for visit")?.value;
  const missing = draft.assessment.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("- ")).map(parseStatement);
  const suggestions = draft.plan.filter((item) => item.startsWith(SUGGESTION_PREFIX)).map((item) => item.slice(SUGGESTION_PREFIX.length));
  const notes = draft.plan.filter((item) => !item.startsWith(SUGGESTION_PREFIX));
  const known = [...facts.values()].filter((fact) => fact.status === "known");
  const uncited = known.filter((fact) => !cited.has(fact.id));
  const authoring = draft.grounding!.authoring!;

  return (
    <>
      <section aria-label="Your request" className="rounded border border-slate-300 bg-slate-50 p-2">
        <h3 className="text-xs font-semibold tracking-wide text-slate-700 uppercase">Your request</h3>
        <p className="text-sm break-words">{authoring.physicianRequest}</p>
      </section>

      <section>
        <h3 className="text-sm font-semibold">Clinical question</h3>
        <p className="text-sm break-words">{question}</p>
        <p className="text-xs text-slate-700">Worded by the assistant from your request. Check that it asks what you intend.</p>
        {reason && <p className="mt-1 text-sm"><span className="font-medium">Reason for visit (chart):</span> {reason}</p>}
      </section>

      {authoring.rejectedStatements > 0 && (
        <p role="note" className="rounded border border-amber-700 bg-amber-50 p-2 text-sm text-amber-900">
          {authoring.rejectedStatements} statement{authoring.rejectedStatements === 1 ? " was" : "s were"} removed from the original draft
          because {authoring.rejectedStatements === 1 ? "it was" : "they were"} not supported by the chart facts cited.
        </p>
      )}

      <section aria-label="Documented findings" className="space-y-2">
        <h3 className="text-sm font-semibold">Documented findings <span className="font-normal text-slate-700">(from the chart, with sources)</span></h3>
        {parsed.sections.filter((section) => section.title !== MISSING_INFORMATION_TITLE).map((section) => (
          <div key={section.title}>
            <h4 className="text-xs font-semibold tracking-wide text-slate-700 uppercase">{section.title}</h4>
            {section.statements.length ? (
              <ul className="space-y-1">
                {section.statements.map((statement, index) => (
                  <li key={index} className="text-sm">
                    <span className="break-words">{statement.text}</span>{" "}
                    <span className="inline-flex flex-wrap gap-1 align-middle"><SourceLinks draftId={draft.id} ids={statement.evidenceIds} facts={facts} /></span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-slate-700">Nothing from the chart was included.</p>}
          </div>
        ))}
        {parsed.other.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold tracking-wide text-slate-700 uppercase">Other text</h4>
            <ul className="text-sm">{parsed.other.map((line, index) => <li key={index} className="break-words">{line}</li>)}</ul>
          </div>
        )}
      </section>

      <section aria-label="Missing information" className="rounded border border-amber-700 bg-amber-50 p-2">
        <h3 className="text-sm font-semibold text-amber-950">Missing information <span className="font-normal">(recorded in the chart as not available)</span></h3>
        {missing.length ? (
          <ul className="list-disc pl-5 text-sm text-amber-950">
            {missing.map((item, index) => <li key={index} className="break-words">{item.text}</li>)}
          </ul>
        ) : <p className="text-sm">None recorded.</p>}
        <p className="mt-1 text-xs text-amber-950">Not available does not mean normal or not done.</p>
      </section>

      <section aria-label="AI suggestions" className="rounded border border-violet-800 bg-violet-50 p-2">
        <h3 className="text-sm font-semibold text-violet-950">AI suggestions <span className="font-normal">(not from the chart; for your judgement)</span></h3>
        {suggestions.length ? (
          <ul className="list-disc pl-5 text-sm text-violet-950">
            {suggestions.map((item, index) => <li key={index} className="break-words">{item}</li>)}
          </ul>
        ) : <p className="text-sm text-violet-950">No additional information was suggested.</p>}
      </section>

      {notes.length > 0 && <ul className="text-xs text-slate-700">{notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}

      <details className="rounded border border-slate-300 p-2" open>
        <summary className="cursor-pointer text-sm font-semibold">
          Source evidence ({known.length} documented fact{known.length === 1 ? "" : "s"}, {uncited.length} not used in this draft)
        </summary>
        <ul className="mt-2 space-y-1">
          {[...facts.values()].map((fact) => (
            <li key={fact.id} id={anchor(draft.id, fact.id)} className="scroll-mt-4 rounded px-1 text-sm target:bg-sky-100">
              <span className="font-medium">{fact.label}:</span>{" "}
              <span className={fact.status === "unknown" ? "text-amber-900 italic" : undefined}>{factValue(fact)}</span>{" "}
              {fact.status === "known" && !cited.has(fact.id) && <span className={`${tag} border-slate-500 text-slate-700`}>Not used in this draft</span>}
              <span className="block text-xs text-slate-600">{fact.source.reference} · documented {formatDate(fact.timestamp)} · {fact.id}</span>
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

/** Presentational view of a consultation draft. */
export function ConsultationDraftView({ draft }: { draft: ConsultationDraft }) {
  const authoring = draft.grounding?.authoring;
  return (
    <article aria-labelledby={`draft-${draft.id}-title`} className="space-y-3">
      <header className="space-y-2">
        <h2 id={`draft-${draft.id}-title`} className="text-lg font-semibold">
          {authoring && draft.grounding?.specialty ? `${draft.grounding.specialty} consultation request` : "Consultation draft"}
        </h2>
        <div className="flex flex-wrap gap-2">
          {authoring && !authoring.liveInference ? (
            <span className="rounded border border-amber-800 bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-900">Demo fallback (no AI inference)</span>
          ) : (
            <span className="rounded border border-sky-800 bg-sky-50 px-1.5 py-0.5 text-xs font-medium text-sky-900">AI-generated</span>
          )}
          {draft.grounding?.provenance.syntheticOnly && (
            <span className="rounded border border-amber-800 bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-900">Synthetic patient data</span>
          )}
          <DraftStatusBadge status={draft.status} />
        </div>
        <Provenance draft={draft} />
      </header>

      {authoring ? <ReferralView draft={draft} /> : (
        <>
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
        </>
      )}

      <footer className="text-xs text-slate-700">
        <p>Prepared {formatDate(draft.createdAt)}{draft.updatedAt !== draft.createdAt && <> · last changed {formatDate(draft.updatedAt)}</>}</p>
        {draft.reviewedBy && draft.reviewedAt && (
          <p className="font-medium text-slate-900">
            Reviewed by {draft.reviewedBy} on {formatDate(draft.reviewedAt)}
          </p>
        )}
      </footer>
    </article>
  );
}
