"use client";
import type { PatientContext } from "@/shared/contracts";
import { useT } from "@/apps/embedded-app/i18n/client";
import { chartNote } from "@/apps/embedded-app/i18n/chart-text";
import { ChartFacts, NotSharedNotice, partsNotShared } from "./ChartFacts";
import { LiveBadge, SyntheticBadge } from "./StateViews";

export function ageInYears(birthDate: string | undefined, now = new Date()): number | undefined {
  if (!birthDate) return undefined;
  const born = new Date(birthDate);
  if (Number.isNaN(born.getTime())) return undefined;
  let years = now.getUTCFullYear() - born.getUTCFullYear();
  const months = now.getUTCMonth() - born.getUTCMonth();
  if (months < 0 || (months === 0 && now.getUTCDate() < born.getUTCDate())) years--;
  return years;
}

/** Chart entries are shown as the EHR wrote them, each with its own text direction. */
function List({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) return <p className="text-sm text-slate-700">{empty}</p>;
  return (
    <ul className="list-disc space-y-0.5 ps-5 text-sm">
      {items.map((item) => <li key={item} dir="auto" className="break-words">{item}</li>)}
    </ul>
  );
}

/** Patient summary. Allergies come first and are never truncated. */
export function PatientContextView({ patient, compact = false }: { patient: PatientContext; compact?: boolean }) {
  const { t, locale } = useT();
  const p = patient;
  const hasAllergies = p.allergies.length > 0;
  const notShared = partsNotShared(p.clinicalFacts);
  const years = ageInYears(p.birthDate);
  const demographics = [t.patient.sex[p.sex], years === undefined ? undefined : t.patient.years(years), p.birthDate && t.patient.born(p.birthDate)].filter(Boolean).join(" · ");

  return (
    <section aria-labelledby={`pt-${p.patientId}`} className={`rounded-lg border border-slate-200 bg-white ${compact ? "p-3" : "p-4"}`}>
      <header className="flex flex-wrap items-center gap-2">
        <h2 id={`pt-${p.patientId}`} className="text-base font-semibold break-words"><bdi>{p.displayName}</bdi></h2>
        {p.source === "synthetic" ? <SyntheticBadge /> : <LiveBadge />}
      </header>
      {demographics && <p className="text-xs text-slate-700">{demographics}</p>}

      <div role="note" aria-label={t.chart.allergies}
        className={`alert mt-3 ${hasAllergies ? "alert-danger" : notShared.includes("allergy") ? "alert-warning" : "alert-info"}`}>
        <p className="text-sm font-semibold">{hasAllergies ? t.chart.allergiesCount(p.allergies.length) : t.chart.allergies}</p>
        {hasAllergies ? (
          <ul className="mt-1 flex flex-wrap gap-1">
            {p.allergies.map((allergy) => (
              <li key={allergy} dir="auto" className="badge badge-danger bg-white font-semibold break-words whitespace-normal">{allergy}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm">{notShared.includes("allergy") ? t.chart.allergiesNotLoaded : t.chart.allergiesNone}</p>
        )}
      </div>

      <div className={`mt-3 grid gap-3 ${compact ? "" : "sm:grid-cols-2"}`}>
        <section>
          <h3 className="text-sm font-semibold">{t.chart.activeProblems}</h3>
          <List items={p.activeProblems} empty={notShared.includes("problem") ? t.chart.notAvailable : t.chart.noneRecorded} />
        </section>
        <section>
          <h3 className="text-sm font-semibold">{t.chart.medications}</h3>
          <List items={p.medications} empty={notShared.includes("medication") ? t.chart.notAvailable : t.chart.noneRecorded} />
        </section>
      </div>
      {p.clinicalFacts && <ChartFacts facts={p.clinicalFacts} />}
      <NotSharedNotice facts={p.clinicalFacts} className="mt-3" />
      {!!p.chartNotes?.length && (
        <div role="note" aria-label={t.chart.notesLabel} className="alert alert-warning mt-3">
          <p className="font-semibold">{t.chart.notesTitle}</p>
          <ul className="mt-1 list-disc space-y-0.5 ps-5">
            {p.chartNotes.map((note) => <li key={note} dir="auto" className="break-words">{chartNote(note, locale)}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}
