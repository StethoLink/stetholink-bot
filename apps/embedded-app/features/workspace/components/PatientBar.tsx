"use client";
import { useState } from "react";
import type { DataClassification, EncounterContext, PatientContext } from "@/shared/contracts";
import { Badge, Button, DataBadge, Skeleton } from "@/apps/embedded-app/components/ui";
import { EncounterSummaryView, ErrorWithRetry, PatientContextView, useEncounterContext, usePatientContext } from "@/apps/embedded-app/features/ehr-panel";

const SEX: Record<PatientContext["sex"], string> = { male: "Male", female: "Female", other: "Other", unknown: "Sex not recorded" };
const VISIT: Record<EncounterContext["type"], string> = { inpatient: "Inpatient", outpatient: "Outpatient", emergency: "Emergency", virtual: "Virtual" };
const VISIT_STATUS: Record<EncounterContext["status"], string> = {
  planned: "planned", arrived: "arrived", triaged: "triaged", in_progress: "in progress", on_leave: "on leave", finished: "finished", cancelled: "cancelled",
};

export function ageInYears(birthDate: string | undefined, now = new Date()): string | undefined {
  if (!birthDate) return undefined;
  const born = new Date(birthDate);
  if (Number.isNaN(born.getTime())) return undefined;
  let years = now.getUTCFullYear() - born.getUTCFullYear();
  const months = now.getUTCMonth() - born.getUTCMonth();
  if (months < 0 || (months === 0 && now.getUTCDate() < born.getUTCDate())) years--;
  return `${years} y`;
}

/**
 * Always-visible identity of the open chart: who the patient is, which visit, and whether the
 * data is real. The full chart record opens underneath without leaving the current tab.
 */
export function PatientBar({ patientId, encounterId, classification }: { patientId: string; encounterId?: string; classification: DataClassification }) {
  const patient = usePatientContext(patientId);
  const encounter = useEncounterContext(encounterId ?? "");
  const [open, setOpen] = useState(false);
  const p = patient.state.status === "ready" ? patient.state.data : undefined;
  const e = encounterId && encounter.state.status === "ready" ? encounter.state.data : undefined;
  // The list holds named allergies only. A recorded "no known allergy" is a chart fact, not an allergy.
  const allergies = p?.allergies.length ?? 0;
  const allergyStatusRecorded = !!p?.clinicalFacts?.some((fact) => fact.category === "allergy" && fact.status === "known");
  return (
    <div className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
        <div className="min-w-0 flex-1">
          {patient.state.status === "loading" && <Skeleton label="Loading patient" lines={1} />}
          {p && (
            <>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <h2 className="text-[0.9375rem] font-semibold break-words text-slate-900">{p.displayName}</h2>
                <DataBadge classification={classification} />
              </div>
              <p className="text-xs text-slate-700">
                {[ageInYears(p.birthDate), SEX[p.sex], e && `${VISIT[e.type]} visit, ${VISIT_STATUS[e.status]}`].filter(Boolean).join(" · ")}
              </p>
            </>
          )}
        </div>
        {p && (
          <div className="flex items-center gap-2">
            {allergies > 0 ? <Badge tone="danger">Allergies: {allergies}</Badge> : <Badge tone="neutral">{allergyStatusRecorded ? "Allergy status in chart" : "Allergies not recorded"}</Badge>}
            <Button size="sm" aria-expanded={open} aria-controls="chart-summary" onClick={() => setOpen((value) => !value)}>{open ? "Hide chart" : "Chart"}</Button>
          </div>
        )}
      </div>
      {patient.state.status === "error" && (
        <div className="mx-auto w-full max-w-3xl px-3 pb-2"><ErrorWithRetry message={patient.state.message} onRetry={patient.reload} /></div>
      )}
      {encounterId && encounter.state.status === "error" && (
        <div className="mx-auto w-full max-w-3xl px-3 pb-2"><ErrorWithRetry message={encounter.state.message} onRetry={encounter.reload} /></div>
      )}
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
