"use client";

import type { ClinicalFact, ConsultationDraft } from "@/shared/contracts";
import { MISSING_INFORMATION_TITLE, SUGGESTION_PREFIX, citedEvidenceIds, parseReferralText, parseStatement } from "@/shared/utils/referral-text";
import { AiBadge, Badge, DataBadge } from "@/apps/embedded-app/components/ui";
import { useT } from "@/apps/embedded-app/i18n/client";
import { formatDateTime } from "@/apps/embedded-app/i18n/format";
import { ageText, factLabel, factValue, missingLine, planNote } from "@/apps/embedded-app/i18n/chart-text";
import { DraftStatusBadge } from "./DraftStatusBadge";

const anchor = (draftId: string, factId: string) => `source-${draftId}-${factId}`;
const tag = "rounded-full border px-2 py-px text-xs font-medium";

function SourceLinks({ draftId, ids, facts }: { draftId: string; ids: string[]; facts: Map<string, ClinicalFact> }) {
  const { t, locale } = useT();
  if (!ids.length) return <span className={`${tag} border-amber-700 bg-amber-50 text-amber-900`}>{t.work.draft.noChartSource}</span>;
  return (
    <>
      {ids.map((id) => facts.has(id) ? (
        <a key={id} href={`#${anchor(draftId, id)}`} onClick={() => document.getElementById(anchor(draftId, id))?.closest("details")?.setAttribute("open", "")} title={`${factLabel(facts.get(id)!.label, locale)}: ${factValue(facts.get(id)!, t.chart)}`}
          className={`${tag} border-sky-800 bg-sky-50 text-sky-900 underline-offset-2 hover:underline`}>
          <bdi>{t.work.draft.source(factLabel(facts.get(id)!.label, locale))}</bdi>
        </a>
      ) : (
        <span key={id} className={`${tag} border-red-700 bg-red-50 text-red-800`}><bdi dir="ltr">{t.work.draft.unknownSource(id)}</bdi></span>
      ))}
    </>
  );
}

function Provenance({ draft }: { draft: ConsultationDraft }) {
  const { t } = useT();
  const w = t.work.draft;
  const grounding = draft.grounding;
  const authoring = grounding?.authoring;
  if (!grounding || !authoring) return <p className="text-xs text-slate-700">{w.aiGeneratedReview}</p>;
  // A record's own provenance: this server always drafts with a model, so only a record stored without one reads this way.
  if (!authoring.liveInference) {
    return (
      <p role="note" className="alert alert-warning">
        <span className="font-semibold">{w.notAiTitle}</span> {w.notAiText}
      </p>
    );
  }
  const usage = authoring.usage;
  return (
    <p className="text-xs text-slate-700">
      {w.draftedByPre(grounding.provenance.provider)} <span className="font-medium" dir="ltr">{grounding.provenance.model}</span>
      {usage && w.usage(String(usage.inputTokens + usage.outputTokens), usage.estimatedCostUsd !== null ? usage.estimatedCostUsd.toFixed(4) : "", (usage.latencyMs / 1000).toFixed(1))}.
      {" "}{w.checkedAgainst}
    </p>
  );
}

/** A model-authored consultation request: each statement beside its chart sources, gaps and AI suggestions kept apart. */
function ReferralView({ draft }: { draft: ConsultationDraft }) {
  const { t, locale } = useT();
  const w = t.work.draft;
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
      <section aria-label={w.yourRequest} className="rounded-md border border-slate-200 bg-slate-50 p-2.5">
        <h3 className="section-title">{w.yourRequest}</h3>
        <p className="text-sm break-words" dir="auto">{authoring.physicianRequest}</p>
        {!!authoring.clarifications?.length && (
          <ul className="mt-1 space-y-1 text-sm">
            {authoring.clarifications.map((entry, index) => (
              <li key={index} className="break-words" dir="auto"><span className="font-medium">{w.assistantAsked}</span> {entry.question} <span className="font-medium">{w.youAnswered}</span> {entry.answer}</li>
            ))}
          </ul>
        )}
      </section>

      {!!authoring.overriddenConcerns?.length && (
        <section aria-label={w.overriddenAria} className="alert alert-warning">
          <h3 className="text-sm font-semibold text-amber-950">{w.overriddenTitle}</h3>
          <ul className="mt-1 space-y-1 text-sm text-amber-950">
            {authoring.overriddenConcerns.map((entry, index) => (
              <li key={index} className="break-words"><span className="font-semibold">{t.work.concerns[entry.kind]}:</span> <span dir="auto">{entry.concern}</span>
                {entry.evidenceIds.length > 0 && <> <span className="inline-flex flex-wrap gap-1 align-middle"><SourceLinks draftId={draft.id} ids={entry.evidenceIds} facts={facts} /></span></>}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-amber-900">{w.overriddenNote}</p>
        </section>
      )}

      {draft.grounding?.patient && (
        <p className="text-sm"><span className="font-medium">{w.patient}</span> {draft.grounding.patient.age ? ageText(draft.grounding.patient.age, locale) : w.ageNotRecorded}, {draft.grounding.patient.sex === "unknown" ? w.sexNotRecorded : (w.sex[draft.grounding.patient.sex] ?? draft.grounding.patient.sex)}
          <span className="text-xs text-slate-700"> {w.patientNote}</span></p>
      )}

      <section>
        <h3 className="text-sm font-semibold">{w.clinicalQuestion}</h3>
        <p className="text-sm break-words" dir="auto">{question}</p>
        <p className="text-xs text-slate-700">{w.wordedBy}</p>
        {reason && <p className="mt-1 text-sm"><span className="font-medium">{w.reasonChart}</span> <span dir="auto">{reason}</span></p>}
      </section>

      {authoring.rejectedStatements > 0 && (
        <p role="note" className="alert alert-warning">
          {w.removed(authoring.rejectedStatements)}
        </p>
      )}

      <section aria-label={w.documentedFindings} className="space-y-2">
        <h3 className="text-sm font-semibold">{w.documentedFindings} <span className="font-normal text-slate-700">{w.fromChart}</span></h3>
        {parsed.sections.filter((section) => section.title !== MISSING_INFORMATION_TITLE).map((section) => (
          <div key={section.title}>
            <h4 className="section-title">{w.sectionTitles[section.title] ?? section.title}</h4>
            {section.statements.length ? (
              <ul className="space-y-1">
                {section.statements.map((statement, index) => (
                  <li key={index} className="text-sm">
                    <span className="break-words" dir="auto">{statement.text}</span>{" "}
                    <span className="inline-flex flex-wrap gap-1 align-middle"><SourceLinks draftId={draft.id} ids={statement.evidenceIds} facts={facts} /></span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-slate-700">{w.nothingIncluded}</p>}
          </div>
        ))}
        {parsed.other.length > 0 && (
          <div>
            <h4 className="section-title">{w.otherText}</h4>
            <ul className="text-sm">{parsed.other.map((line, index) => <li key={index} className="break-words" dir="auto">{line}</li>)}</ul>
          </div>
        )}
      </section>

      <section aria-label={w.missingTitle} className="alert alert-warning">
        <h3 className="text-sm font-semibold text-amber-950">{w.missingTitle} <span className="font-normal">{w.missingSub}</span></h3>
        {missing.length ? (
          <ul className="list-disc ps-5 text-sm text-amber-950">
            {missing.map((item, index) => <li key={index} className="break-words" dir="auto">{missingLine(item.text, locale)}</li>)}
          </ul>
        ) : <p className="text-sm">{w.noneRecorded}</p>}
        <p className="mt-1 text-xs text-amber-950">{w.missingNote}</p>
      </section>

      <section aria-label={w.suggestionsTitle} className="alert alert-ai">
        <h3 className="text-sm font-semibold text-violet-950">{w.suggestionsTitle} <span className="font-normal">{w.suggestionsSub}</span></h3>
        {suggestions.length ? (
          <ul className="list-disc ps-5 text-sm text-violet-950">
            {suggestions.map((item, index) => <li key={index} className="break-words" dir="auto">{item}</li>)}
          </ul>
        ) : <p className="text-sm text-violet-950">{w.noSuggestions}</p>}
      </section>

      {notes.length > 0 && <ul className="text-xs text-slate-700">{notes.map((note, index) => <li key={index} dir="auto">{planNote(note, locale)}</li>)}</ul>}

      <details className="rounded-md border border-slate-200 p-2.5">
        <summary className="cursor-pointer text-sm font-semibold">
          {w.evidenceSummary(known.length, uncited.length)}
        </summary>
        <ul className="mt-2 space-y-1">
          {[...facts.values()].map((fact) => (
            <li key={fact.id} id={anchor(draft.id, fact.id)} className="rounded px-1 py-0.5 text-sm target:bg-sky-100 target:outline target:outline-sky-600">
              <bdi className="font-medium">{factLabel(fact.label, locale)}:</bdi>{" "}
              <bdi className={fact.status === "unknown" ? "text-amber-900 italic" : undefined}>{factValue(fact, t.chart)}</bdi>{" "}
              {fact.status === "known" && !cited.has(fact.id) && <span className={`${tag} border-slate-500 text-slate-700`}>{w.notUsed}</span>}
              <span className="block text-xs text-slate-600"><bdi dir="ltr">{w.evidenceMeta(fact.source.reference, formatDateTime(fact.timestamp, locale), fact.id)}</bdi></span>
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

/** Presentational view of a consultation draft. */
export function ConsultationDraftView({ draft }: { draft: ConsultationDraft }) {
  const { t, locale } = useT();
  const w = t.work.draft;
  const authoring = draft.grounding?.authoring;
  return (
    <article aria-labelledby={`draft-${draft.id}-title`} className="space-y-3">
      <header className="space-y-2">
        <h2 id={`draft-${draft.id}-title`} className="text-base font-semibold">
          {authoring && draft.grounding?.specialty ? w.requestTitle(draft.grounding.specialty) : w.draftTitle}
        </h2>
        <div className="flex flex-wrap gap-2">
          {authoring && !authoring.liveInference ? (
            <Badge tone="warning">{w.noAi}</Badge>
          ) : (
            <AiBadge />
          )}
          {draft.grounding && <DataBadge classification={draft.grounding.provenance.dataClassification} />}
          <DraftStatusBadge status={draft.status} />
        </div>
        <Provenance draft={draft} />
      </header>

      {authoring ? <ReferralView draft={draft} /> : (
        <>
          <section>
            <h3 className="text-sm font-semibold">{w.summary}</h3>
            <p className="whitespace-pre-wrap text-sm" dir="auto">{draft.summary || w.noSummary}</p>
          </section>
          <section>
            <h3 className="text-sm font-semibold">{w.assessment}</h3>
            <p className="whitespace-pre-wrap text-sm" dir="auto">{draft.assessment || w.noAssessment}</p>
          </section>
          <section>
            <h3 className="text-sm font-semibold">{w.plan}</h3>
            {draft.plan.length ? (
              <ol className="list-decimal ps-5 text-sm">
                {draft.plan.map((item, i) => (
                  <li key={i} dir="auto">{item}</li>
                ))}
              </ol>
            ) : (
              <p className="text-sm">{w.noPlan}</p>
            )}
          </section>
        </>
      )}

      <footer className="text-xs text-slate-700">
        <p>{w.prepared(formatDateTime(draft.createdAt, locale))}{draft.updatedAt !== draft.createdAt && w.lastChanged(formatDateTime(draft.updatedAt, locale))}</p>
        {draft.reviewedBy && draft.reviewedAt && (
          <p className="font-medium text-slate-900">
            <bdi>{w.reviewedBy(locale === "ar" ? `\u2066${draft.reviewedBy}\u2069` : draft.reviewedBy, formatDateTime(draft.reviewedAt, locale))}</bdi>
          </p>
        )}
      </footer>
    </article>
  );
}
