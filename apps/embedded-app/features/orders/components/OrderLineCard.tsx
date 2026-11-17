"use client";

import { useId } from "react";
import type { ClinicalFact, OrderLine } from "@/shared/contracts";
import { Badge, Button, type Tone } from "@/apps/embedded-app/components/ui";
import { useT } from "@/apps/embedded-app/i18n/client";
import { formatDateTime } from "@/apps/embedded-app/i18n/format";
import { MIN_REASON, citedFacts, describeFact, describeFlag, joinWords, noChoice, requiredKinds, type AcknowledgementKind, type LineChoice } from "../hooks/orderText";

/**
 * A sentence with a value of the chart in it (the sentence marks the value with isolate characters): the value is kept in one piece and
 * read in its own direction, so a name in Latin letters does not scramble the Arabic around it and does not break across two lines.
 */
function Sentence({ text }: { text: string }) {
  return <>{text.split(/(\u2068[^\u2069]*\u2069)/).map((part, index) => part.startsWith("\u2068") ? <bdi key={index} className="inline-block max-w-full align-bottom">{part.slice(1, -1)}</bdi> : part)}</>;
}

const STATUS_TONE: Record<OrderLine["status"], Tone> = { pending: "neutral", approved: "success", rejected: "danger" };
const ALERT_OF: Record<Tone, string> = { danger: "alert-danger", warning: "alert-warning", neutral: "alert-info", primary: "alert-info", success: "alert-success", ai: "alert-ai" };

/**
 * One drafted order: what it is (the catalog's own name, code and dose), who asked for it and why, the checks on it in words,
 * and, for a physician, the decision. A decided order shows what was decided and, for a warning that needed it, the reason given.
 */
export function OrderLineCard({ line, facts, choice, onChoice }: {
  line: OrderLine;
  facts: ReadonlyMap<string, ClinicalFact>;
  /** What the physician has chosen so far. Without `onChoice` the card is for reading only: no decision control is shown. */
  choice?: LineChoice;
  onChoice?(next: LineChoice): void;
}) {
  const { t, locale } = useT();
  const o = t.work.orders;
  const id = useId();
  const cited = citedFacts(line.evidenceIds, facts);
  const flags = line.flags.map((flag) => describeFlag(flag, facts, o.flags, locale, t.chart));
  const required = requiredKinds(line.flags);
  const current = choice ?? noChoice;
  const deciding = line.status === "pending" && !!onChoice;
  const choose = (next: "approve" | "reject") => onChoice?.({ ...current, choice: current.choice === next ? undefined : next });
  const toggle = (kind: AcknowledgementKind) => onChoice?.({ ...current, acknowledged: current.acknowledged.includes(kind) ? current.acknowledged.filter((entry) => entry !== kind) : [...current.acknowledged, kind] });
  const medication = line.medication;

  return (
    <article aria-labelledby={`${id}-title`} className="space-y-2 rounded-md border border-slate-200 bg-white p-3">
      <header className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <Badge>{o.kinds[line.kind]}</Badge>
          <Badge tone={STATUS_TONE[line.status]} dot>{o.line.status[line.status]}</Badge>
        </div>
        <h4 id={`${id}-title`} className="text-sm font-semibold break-words"><bdi>{line.display}</bdi></h4>
      </header>

      <p className="text-xs text-slate-700">
        <span className="font-medium text-slate-900">{line.basis === "requested" ? o.line.requested : o.line.proposed}</span>
        {line.basis === "requested" && line.requestedText && <> · {o.line.yourWords} <span className="rounded bg-slate-100 px-1 text-slate-900" dir="auto">{line.requestedText}</span></>}
      </p>

      {medication && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md bg-slate-50 p-2 text-sm">
          <dt className="sr-only">{o.kinds.medication}</dt>
          <dd className="col-span-2 font-medium break-words"><bdi>{medication.product}</bdi></dd>
          <dt className="text-slate-700">{o.line.medication.dose}</dt><dd><bdi>{medication.dose}</bdi></dd>
          <dt className="text-slate-700">{o.line.medication.route}</dt><dd><bdi>{medication.route}</bdi></dd>
          <dt className="text-slate-700">{o.line.medication.frequency}</dt><dd><bdi>{medication.frequency}</bdi></dd>
          {medication.duration && <><dt className="text-slate-700">{o.line.medication.duration}</dt><dd><bdi>{medication.duration}</bdi></dd></>}
        </dl>
      )}
      {line.code && (
        <p className="text-xs text-slate-700">{o.line.code}: <bdi dir="ltr" className="font-medium text-slate-900">{line.code.code}</bdi> · <bdi dir="ltr">{line.code.system}</bdi></p>
      )}

      <p className="text-sm break-words"><span className="font-medium">{o.line.why}</span> <span dir="auto">{line.reason}</span></p>
      {cited.length > 0 && (
        <div>
          <p className="section-title">{o.line.basedOn}</p>
          <ul className="list-disc ps-5 text-sm">
            {cited.map((fact) => <li key={fact.id} className="break-words"><bdi>{describeFact(fact, locale, t.chart)}</bdi></li>)}
          </ul>
        </div>
      )}

      {flags.length > 0 && (
        <ul aria-label={o.flags.aria} className="space-y-1.5">
          {flags.map((flag, index) => (
            <li key={`${flag.kind}-${index}`} className={`alert ${ALERT_OF[flag.tone]}`}>
              <p className="flex flex-wrap items-center gap-1.5 font-semibold"><Badge tone={flag.tone}>{flag.title}</Badge></p>
              {flag.hospitalText && <p className="mt-1 break-words" dir="auto">{flag.hospitalText}</p>}
              {flag.sentence && <p className="mt-1 break-words" dir="auto"><Sentence text={flag.sentence} /></p>}
              {flag.needsAcknowledgement && line.status === "pending" && <p className="mt-1 text-xs font-medium">{o.flags.needsAck}</p>}
            </li>
          ))}
        </ul>
      )}

      {deciding && (
        <div className="space-y-2 border-t border-slate-200 pt-2">
          <div role="group" aria-label={o.decide.choose(line.display)} className="flex flex-wrap gap-2">
            <Button size="sm" variant={current.choice === "approve" ? "success" : "secondary"} aria-pressed={current.choice === "approve"} onClick={() => choose("approve")}>{o.decide.approve}</Button>
            <Button size="sm" variant={current.choice === "reject" ? "danger" : "secondary"} aria-pressed={current.choice === "reject"} onClick={() => choose("reject")}>{o.decide.reject}</Button>
          </div>
          {current.choice === "approve" && required.length > 0 && (
            <fieldset className="space-y-2 rounded-md border border-amber-700 bg-amber-50 p-2.5 text-amber-950">
              <legend className="px-1 text-xs font-semibold">{o.decide.acknowledgeHeading}</legend>
              {required.map((kind) => (
                <label key={kind} className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5 size-4 shrink-0" checked={current.acknowledged.includes(kind)} onChange={() => toggle(kind)} />
                  <span>{o.decide.acknowledgements[kind]}</span>
                </label>
              ))}
              <div>
                <label className="field-label" htmlFor={`${id}-reason`}>{o.decide.reasonLabel}</label>
                <textarea id={`${id}-reason`} rows={2} maxLength={500} className="field" dir="auto" value={current.reason} aria-describedby={`${id}-reason-hint`}
                  aria-invalid={current.reason.trim().length < MIN_REASON} onChange={(event) => onChoice?.({ ...current, reason: event.target.value })} />
                <span id={`${id}-reason-hint`} className="field-hint">{o.decide.reasonHint(MIN_REASON)}</span>
              </div>
            </fieldset>
          )}
        </div>
      )}

      {line.status !== "pending" && (
        <div className="space-y-0.5 border-t border-slate-200 pt-2 text-xs text-slate-700">
          {line.decidedAt && <p>{line.status === "approved" ? o.line.approvedOn(formatDateTime(line.decidedAt, locale)) : o.line.rejectedOn(formatDateTime(line.decidedAt, locale))}</p>}
          {!!line.acknowledged?.length && <p>{o.line.acknowledged} {joinWords(line.acknowledged.map((kind) => o.flags.kinds[kind]), locale)}</p>}
          {line.overrideReason && <p className="break-words">{o.line.yourReason} <span dir="auto" className="text-slate-900">{line.overrideReason}</span></p>}
        </div>
      )}
    </article>
  );
}
