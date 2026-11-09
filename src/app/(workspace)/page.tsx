import Link from "next/link";
import { ChatPanel } from "@/features/assistant";
import { EncounterSummary, PatientContextCard } from "@/features/ehr-panel";

const DEMO_PATIENT_ID = "syn-pt-001"; // synthetic
const DEMO_ENCOUNTER_ID = "syn-enc-001"; // synthetic
const DEMO_DRAFT_ID = "syn-draft-001"; // synthetic

export default function WorkspacePage() {
  return (
    <main className="mx-auto grid w-full max-w-6xl gap-4 p-4 md:grid-cols-[1fr_2fr] md:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2 md:col-span-2">
        <h1 className="text-2xl font-semibold">StethoLink Workspace</h1>
        <nav aria-label="Workspace" className="flex flex-wrap gap-4 text-sm font-medium">
          <Link href={`/consultations/${DEMO_DRAFT_ID}`} className="text-sky-800 underline">
            Review pending consultation draft
          </Link>
          <Link href={`/embed?patientId=${DEMO_PATIENT_ID}&encounterId=${DEMO_ENCOUNTER_ID}`} className="text-sky-800 underline">
            Embedded panel preview
          </Link>
        </nav>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <PatientContextCard patientId={DEMO_PATIENT_ID} />
        <EncounterSummary encounterId={DEMO_ENCOUNTER_ID} />
      </div>
      <ChatPanel patientId={DEMO_PATIENT_ID} encounterId={DEMO_ENCOUNTER_ID} />
    </main>
  );
}
