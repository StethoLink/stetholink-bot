"use client";

import type { OrderDraft } from "@/shared/contracts";
import { AiBadge, Badge, DataBadge } from "@/apps/embedded-app/components/ui";
import { useT } from "@/apps/embedded-app/i18n/client";
import { formatDateTime } from "@/apps/embedded-app/i18n/format";
import { chartNote, factLabel } from "@/apps/embedded-app/i18n/chart-text";
import { factsOf, groupByKind, type LineChoice } from "../hooks/orderText";
import { OrderLineCard } from "./OrderLineCard";

/**
 * A drafted set of orders: the request, the orders grouped by kind (each with who asked for it, its checks and its decision),
 * what matched nothing, and what the chart did not give. With `onChoice` a physician chooses approve or reject on each pending order.
 */
export function OrderDraftView({ draft, choices = {}, onChoice }: {
  draft: OrderDraft;
  choices?: Readonly<Record<string, LineChoice | undefined>>;
  onChoice?(lineId: string, next: LineChoice): void;
}) {
  const { t, locale } = useT();
  const w = t.work.orders.draft;
  const facts = factsOf(draft);
  const groups = groupByKind(draft.lines);
  const count = (status: "pending" | "approved" | "rejected") => draft.lines.filter((line) => line.status === status).length;
  const counts = [["total", draft.lines.length], ["pending", count("pending")], ["approved", count("approved")], ["rejected", count("rejected")]] as const;

  return (
    <article aria-labelledby={`orders-${draft.id}-title`} className="space-y-3">
      <header className="space-y-2">
        <h2 id={`orders-${draft.id}-title`} className="text-base font-semibold">{w.title}</h2>
        <div className="flex flex-wrap gap-2">
          <AiBadge />
          <DataBadge classification={draft.provenance.dataClassification} />
          <Badge tone="primary">{w.mode[draft.mode]}</Badge>
        </div>
        <p className="text-xs text-slate-700">{w.aiNote}</p>
      </header>

      <section aria-label={w.yourRequest} className="rounded-md border border-slate-200 bg-slate-50 p-2.5">
        <h3 className="section-title">{w.yourRequest}</h3>
        <p className="text-sm break-words" dir="auto">{draft.request}</p>
      </section>

      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {counts.map(([key, value]) => (
          <div key={key} className="flex items-baseline gap-1.5"><dt className="text-slate-700">{w.counts[key]}:</dt><dd className="font-semibold">{value}</dd></div>
        ))}
      </dl>

      {draft.unmatched.length > 0 && (
        <section aria-label={w.unmatchedTitle} className="alert alert-warning">
          <h3 className="text-sm font-semibold">{w.unmatchedTitle}</h3>
          <p>{w.unmatchedText}</p>
          <ul className="list-disc ps-5">{draft.unmatched.map((phrase, index) => <li key={index} className="break-words" dir="auto">{phrase}</li>)}</ul>
        </section>
      )}
      {draft.provenance.rejectedLines > 0 && <p role="note" className="alert alert-warning">{w.dropped(draft.provenance.rejectedLines)}</p>}

      {groups.map(({ kind, lines }) => (
        <section key={kind} aria-label={t.work.orders.groups[kind]} className="space-y-2">
          <h3 className="section-title">{t.work.orders.groups[kind]}</h3>
          <ul className="space-y-2">
            {lines.map((line) => (
              <li key={line.id}>
                <OrderLineCard line={line} facts={facts} choice={choices[line.id]} onChoice={onChoice ? (next) => onChoice(line.id, next) : undefined} />
              </li>
            ))}
          </ul>
        </section>
      ))}

      <p className="text-xs text-slate-700">{t.work.orders.flags.checksNote}</p>

      {draft.missingInformation.length > 0 && (
        <details className="rounded-md border border-amber-700 bg-amber-50 p-2.5 text-amber-950">
          <summary className="cursor-pointer text-sm font-semibold">{w.missingTitle} ({draft.missingInformation.length})</summary>
          <ul className="mt-1 list-disc ps-5 text-sm">
            {draft.missingInformation.map((item) => (
              <li key={item.id} className="break-words" dir="auto">{factLabel(item.label, locale)}: {t.chart.unavailable[item.reason] ?? t.chart.notAvailable}</li>
            ))}
          </ul>
          <p className="mt-1 text-xs">{t.work.draft.missingNote}</p>
        </details>
      )}
      {draft.notes.length > 0 && (
        <section aria-label={w.notesTitle} className="text-xs text-slate-700">
          <h3 className="font-semibold">{w.notesTitle}</h3>
          <ul>{draft.notes.map((note, index) => <li key={index} dir="auto">{chartNote(note, locale)}</li>)}</ul>
        </section>
      )}

      <footer className="text-xs text-slate-700">
        <p>{w.prepared(formatDateTime(draft.createdAt, locale))} · {w.catalogVersion} <bdi dir="ltr">{draft.catalogVersion}</bdi></p>
      </footer>
    </article>
  );
}
