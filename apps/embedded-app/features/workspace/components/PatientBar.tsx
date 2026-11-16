"use client";
import { useState } from "react";
import type { DataClassification } from "@/shared/contracts";
import { useT } from "@/apps/embedded-app/i18n/client";
import { Badge, Button, DataBadge, Skeleton } from "@/apps/embedded-app/components/ui";
import { EncounterSummaryView, ErrorWithRetry, NotSharedNotice, PatientContextView, ageInYears, partsNotShared, useEncounterContext, usePatientContext } from "@/apps/embedded-app/features/ehr-panel";

/**
 * Always-visible identity of the open chart: who the patient is, which visit, and whether the
 * data is real. The full chart record opens underneath without leaving the current tab.
 */
export function PatientBar({ patientId, encounterId, classification }: { patientId: string; encounterId?: string; classification: DataClassification }) {
  const { t } = useT();
  const patient = usePatientContext(patientId);
  const encounter = useEncounterContext(encounterId ?? "");
  const [open, setOpen] = useState(false);
  const p = patient.state.status === "ready" ? patient.state.data : undefined;
  const e = encounterId && encounter.state.status === "ready" ? encounter.state.data : undefined;
  // The list holds named allergies only. A recorded "no known allergy" is a chart fact, not an allergy.
  const allergies = p?.allergies.length ?? 0;
  const years = ageInYears(p?.birthDate);
  const notShared = partsNotShared(p?.clinicalFacts);
  const allergyStatusRecorded = !!p?.clinicalFacts?.some((fact) => fact.category === "allergy" && fact.status === "known");
  return (
    <div className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
        <div className="min-w-0 flex-1">
          {patient.state.status === "loading" && <Skeleton label={t.patient.loading} lines={1} />}
          {p && (
            <>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <h2 className="text-[0.9375rem] font-semibold break-words text-slate-900"><bdi>{p.displayName}</bdi></h2>
                <DataBadge classification={classification} />
              </div>
              <p className="text-xs text-slate-700">
                {[years === undefined ? undefined : t.patient.years(years), t.patient.sex[p.sex], e && t.patient.visit(t.patient.visitType[e.type], t.patient.visitStatus[e.status])].filter(Boolean).join(" · ")}
              </p>
            </>
          )}
        </div>
        {p && (
          <div className="flex flex-wrap items-center gap-2">
            {allergies > 0 ? <Badge tone="danger">{t.patient.allergies(allergies)}</Badge>
              // A list the EHR withheld is not "no allergies recorded".
              : notShared.includes("allergy") ? <Badge tone="warning">{t.patient.allergiesNotLoaded}</Badge>
              : <Badge tone="neutral">{allergyStatusRecorded ? t.patient.allergyStatusInChart : t.patient.allergiesNotRecorded}</Badge>}
            <Button size="sm" aria-expanded={open} aria-controls="chart-summary" onClick={() => setOpen((value) => !value)}>{open ? t.patient.hideChart : t.patient.showChart}</Button>
          </div>
        )}
      </div>
      {patient.state.status === "error" && (
        <div className="mx-auto w-full max-w-3xl px-3 pb-2"><ErrorWithRetry message={patient.state.message} code={patient.state.code} reference={patient.state.reference} onRetry={patient.reload} /></div>
      )}
      {encounterId && encounter.state.status === "error" && (
        <div className="mx-auto w-full max-w-3xl px-3 pb-2"><ErrorWithRetry message={encounter.state.message} code={encounter.state.code} reference={encounter.state.reference} onRetry={encounter.reload} /></div>
      )}
      {/* Visible without opening the chart: a draft written now would lack these records. */}
      {!open && notShared.length > 0 && <div className="mx-auto w-full max-w-3xl px-3 pb-2"><NotSharedNotice facts={p?.clinicalFacts} /></div>}
      {open && p && (
        <div id="chart-summary" className="max-h-[60dvh] overflow-y-auto border-t border-slate-200 bg-slate-50">
          <div className="mx-auto w-full max-w-3xl space-y-2 p-3">
            <PatientContextView patient={p} compact />
            {e && <EncounterSummaryView encounter={e} />}
          </div>
        </div>
      )}
    </div>
  );
}
