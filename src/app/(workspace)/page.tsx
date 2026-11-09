import { ChatPanel } from "@/features/assistant";
import { PatientContextCard } from "@/features/ehr-panel";

const DEMO_PATIENT_ID = "syn-pt-001"; // synthetic

export default function WorkspacePage() {
  return (
    <main className="mx-auto grid w-full max-w-6xl gap-4 p-4 md:grid-cols-[1fr_2fr] md:p-6">
      <h1 className="text-2xl font-semibold md:col-span-2">StethoLink Workspace</h1>
      <PatientContextCard patientId={DEMO_PATIENT_ID} />
      <ChatPanel patientId={DEMO_PATIENT_ID} />
    </main>
  );
}
