"use client";
import { useEffect, useState } from "react";
import type { DataClassification } from "@/shared/contracts";
import { Alert, Button, Dialog, Tabs, ToastProvider } from "@/apps/embedded-app/components/ui";
import { ConsultationComposer, ConsultationHistory, type AssistantInfo } from "@/apps/embedded-app/features/consultations";
import { ScribeHistory, ScribePanel } from "@/apps/embedded-app/features/scribe";
import { PatientBar } from "./PatientBar";

type TabKey = "scribe" | "consultations" | "history";
const TABS = [
  { key: "scribe", label: "Scribe" },
  { key: "consultations", label: "Consultations" },
  { key: "history", label: "History" },
] as const;
const SHORTCUTS: [string, string][] = [
  ["Alt + 1, 2, 3", "Open Scribe, Consultations or History"],
  ["Ctrl + Enter", "Submit the text you are typing"],
  ["Esc", "Close a dialog"],
  ["?", "Show this list"],
];

export interface WorkspaceProps {
  patientId: string;
  encounterId?: string;
  classification: DataClassification;
  canReview: boolean;
  canRoute: boolean;
  /** False when the hospital has not switched the assistant on for EHR data: the chart is read-only. */
  assistantEnabled: boolean;
  assistant: AssistantInfo;
  /** When the server session ends (epoch milliseconds). */
  expiresAt: number;
  initialTab?: TabKey;
}

/**
 * The plugin frame: a sticky patient bar and three tabs. It fits a 360 to 480 px side panel
 * inside the EHR and widens to a readable column in a full window.
 */
export function Workspace(props: WorkspaceProps) {
  const [tab, setTab] = useState<TabKey>(props.initialTab ?? "consultations");
  const [visitId, setVisitId] = useState<string>();
  const [draftId, setDraftId] = useState<string>();
  const [help, setHelp] = useState(false);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    const remaining = props.expiresAt - Date.now();
    const timer = setTimeout(() => setExpired(true), Math.max(0, Math.min(remaining, 2_000_000_000)));
    return () => clearTimeout(timer);
  }, [props.expiresAt]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.altKey && ["1", "2", "3"].includes(event.key)) {
        event.preventDefault();
        setTab(TABS[Number(event.key) - 1].key);
      }
      const typing = event.target instanceof HTMLElement && (["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName) || event.target.isContentEditable);
      if (event.key === "?" && !typing && !event.ctrlKey && !event.metaKey) setHelp(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <ToastProvider>
      <div className="flex min-h-dvh w-full flex-col">
        <header className="sticky top-0 z-30 shadow-xs">
          <h1 className="sr-only">StethoLink</h1>
          <PatientBar patientId={props.patientId} encounterId={props.encounterId} classification={props.classification} />
        </header>
        {expired && (
          <div className="mx-auto w-full max-w-3xl px-3 pt-3">
            <Alert tone="warning" role="alert" title="Your session has ended">
              For safety, StethoLink closes after 15 minutes. Reopen it from the patient&apos;s chart in the EHR to continue. Anything you saved is kept.
            </Alert>
          </div>
        )}
        <main className="mx-auto w-full max-w-3xl min-w-0 flex-1 px-3 pb-6">
          <Tabs<TabKey> items={TABS} value={tab} onChange={setTab} label="StethoLink sections">
            <div className="space-y-3 pt-3">
              {!props.assistantEnabled ? (
                <Alert tone="info" title="Reading only">
                  The chart is shown for reading. Writing notes and consultations from EHR data is not switched on for this hospital yet. Ask your StethoLink administrator.
                </Alert>
              ) : tab === "scribe" ? (
                <ScribePanel openSessionId={visitId} onOpenSession={setVisitId} />
              ) : tab === "consultations" ? (
                <>
                  <ConsultationComposer patientId={props.patientId} encounterId={props.encounterId} canReview={props.canReview} canRoute={props.canRoute}
                    assistant={props.assistant} openDraftId={draftId} onOpenDraft={setDraftId} />
                  {!props.canReview && <p className="text-xs text-slate-700">This session can prepare drafts only. Approving and sending need a verified physician session.</p>}
                </>
              ) : (
                <>
                  <ScribeHistory onOpen={(id) => { setVisitId(id); setTab("scribe"); }} />
                  <ConsultationHistory onOpen={(id) => { setDraftId(id); setTab("consultations"); }} />
                </>
              )}
            </div>
          </Tabs>
        </main>
        <footer className="mx-auto flex w-full max-w-3xl items-center justify-between gap-2 px-3 pb-3 text-xs text-slate-600">
          <span>StethoLink prepares drafts. A clinician decides.</span>
          <Button size="sm" variant="ghost" onClick={() => setHelp(true)}>Keyboard shortcuts</Button>
        </footer>
      </div>
      <Dialog open={help} onClose={() => setHelp(false)} title="Keyboard shortcuts" footer={<Button onClick={() => setHelp(false)}>Close</Button>}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
          {SHORTCUTS.map(([keys, action]) => (
            <div key={keys} className="contents"><dt><kbd className="rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-xs font-medium">{keys}</kbd></dt><dd>{action}</dd></div>
          ))}
        </dl>
      </Dialog>
    </ToastProvider>
  );
}
