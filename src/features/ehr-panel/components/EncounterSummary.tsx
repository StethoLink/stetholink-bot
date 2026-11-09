"use client";

import type { StethoLinkApiClient } from "@/shared/api-client";
import type { EncounterContext } from "@/shared/contracts";
import { useEncounterContext } from "../hooks/useEncounterContext";
import { ErrorWithRetry, SkeletonBlock } from "./StateViews";

const TYPE: Record<EncounterContext["type"], string> = {
  inpatient: "Inpatient",
  outpatient: "Outpatient",
  emergency: "Emergency",
  virtual: "Virtual",
};
const STATUS: Record<EncounterContext["status"], string> = {
  planned: "Planned",
  in_progress: "In progress",
  finished: "Finished",
  cancelled: "Cancelled",
};

export function EncounterSummaryView({ encounter }: { encounter: EncounterContext }) {
  const e = encounter;
  const started = new Date(e.startedAt);
  return (
    <section aria-label="Encounter" className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
      <h2 className="font-semibold">
        {TYPE[e.type]} encounter · {STATUS[e.status]}
      </h2>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {e.reasonForVisit && (
          <>
            <dt className="text-slate-700">Reason</dt>
            <dd className="break-words">{e.reasonForVisit}</dd>
          </>
        )}
        {e.location && (
          <>
            <dt className="text-slate-700">Location</dt>
            <dd className="break-words">{e.location}</dd>
          </>
        )}
        <dt className="text-slate-700">Started</dt>
        <dd>
          <time dateTime={e.startedAt}>
            {Number.isNaN(started.getTime())
              ? e.startedAt
              : started.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
          </time>
        </dd>
      </dl>
    </section>
  );
}

export function EncounterSummary({ encounterId, client }: { encounterId: string; client?: StethoLinkApiClient }) {
  const { state, reload } = useEncounterContext(encounterId, client);
  if (state.status === "ready") return <EncounterSummaryView encounter={state.data} />;
  return (
    <section aria-label="Encounter" className="rounded-lg border border-slate-200 bg-white p-3">
      {state.status === "loading" ? (
        <SkeletonBlock label="Loading encounter…" lines={2} />
      ) : (
        <ErrorWithRetry message={state.message} onRetry={reload} />
      )}
    </section>
  );
}
