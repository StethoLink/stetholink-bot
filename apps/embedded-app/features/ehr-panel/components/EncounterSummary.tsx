"use client";

import type { StethoLinkApiClient } from "@/shared/api-client";
import type { EncounterContext } from "@/shared/contracts";
import { useT } from "@/apps/embedded-app/i18n/client";
import { useEncounterContext } from "../hooks/useEncounterContext";
import { ErrorWithRetry, SkeletonBlock } from "./StateViews";

export function EncounterSummaryView({ encounter }: { encounter: EncounterContext }) {
  const { t, locale } = useT();
  const e = encounter;
  const started = new Date(e.startedAt);
  return (
    <section aria-label={t.chart.encounterLabel} className="card card-pad text-sm">
      <h2 className="font-semibold">
        {t.chart.encounterHeading(t.patient.visitType[e.type], t.patient.visitStatus[e.status])}
      </h2>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {e.reasonForVisit && (
          <>
            <dt className="text-slate-700">{t.chart.reason}</dt>
            <dd dir="auto" className="break-words">{e.reasonForVisit}</dd>
          </>
        )}
        {e.location && (
          <>
            <dt className="text-slate-700">{t.chart.location}</dt>
            <dd dir="auto" className="break-words">{e.location}</dd>
          </>
        )}
        <dt className="text-slate-700">{t.chart.started}</dt>
        <dd>
          <time dateTime={e.startedAt}>
            {Number.isNaN(started.getTime())
              ? e.startedAt
              : started.toLocaleString(locale === "ar" ? "ar-SA-u-ca-gregory-nu-latn" : undefined, { dateStyle: "medium", timeStyle: "short" })}
          </time>
        </dd>
      </dl>
    </section>
  );
}

export function EncounterSummary({ encounterId, client }: { encounterId: string; client?: StethoLinkApiClient }) {
  const { t } = useT();
  const { state, reload } = useEncounterContext(encounterId, client);
  if (state.status === "ready") return <EncounterSummaryView encounter={state.data} />;
  return (
    <section aria-label={t.chart.encounterLabel} className="card card-pad">
      {state.status === "loading" ? (
        <SkeletonBlock label={t.chart.loadingEncounter} lines={2} />
      ) : (
        <ErrorWithRetry message={state.message} code={state.code} reference={state.reference} onRetry={reload} />
      )}
    </section>
  );
}
