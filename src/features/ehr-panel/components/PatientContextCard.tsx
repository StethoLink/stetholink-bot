"use client";

import { usePatientContext } from "../hooks/usePatientContext";

export function PatientContextCard({ patientId }: { patientId: string }) {
  const state = usePatientContext(patientId);
  if (state.status === "loading") return <p aria-busy="true">Loading patient context…</p>;
  if (state.status === "error") return <p role="alert">{state.message}</p>;
  const p = state.patient;
  return (
    <section aria-label="Patient context" className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="font-semibold">
        {p.displayName}
        {p.source === "synthetic" && <span className="ml-2 text-xs text-amber-700">(synthetic)</span>}
      </h2>
      <dl className="mt-2 text-sm">
        <dt className="font-medium">Allergies</dt>
        <dd>{p.allergies.length ? p.allergies.join(", ") : "None recorded"}</dd>
        <dt className="mt-1 font-medium">Active problems</dt>
        <dd>{p.activeProblems.join(", ") || "None recorded"}</dd>
      </dl>
    </section>
  );
}
