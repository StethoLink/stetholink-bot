"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/apps/embedded-app/i18n/client";
import type { DataClassification } from "@/shared/contracts";
import { Alert, Button, Dialog, Tabs, ToastProvider } from "@/apps/embedded-app/components/ui";
import { ConsultationComposer, ConsultationHistory, type AssistantInfo } from "@/apps/embedded-app/features/consultations";
import { ScribeHistory, ScribePanel } from "@/apps/embedded-app/features/scribe";
import { PatientBar } from "./PatientBar";

type TabKey = "scribe" | "consultations" | "history";
const TAB_KEYS = ["scribe", "consultations", "history"] as const;

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
  const { t, locale } = useT();
  const router = useRouter();
  const [switching, setSwitching] = useState(false);
  const tabs = TAB_KEYS.map((key) => ({ key, label: t.tabs[key] }));
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
        setTab(TAB_KEYS[Number(event.key) - 1]);
      }
      const typing = event.target instanceof HTMLElement && (["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName) || event.target.isContentEditable);
      if (event.key === "?" && !typing && !event.ctrlKey && !event.metaKey) setHelp(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The language is remembered by the server and the page is rendered again in place: nothing typed is lost.
  async function switchLanguage() {
    setSwitching(true);
    try {
      const response = await fetch("/api/locale", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locale: locale === "ar" ? "en" : "ar" }) });
      if (response.ok) router.refresh();
    } catch {
      // The interface stays in the current language; nothing else depends on this request.
    } finally {
      setSwitching(false);
    }
  }
  return (
    <ToastProvider>
      <div className="flex min-h-dvh w-full flex-col">
        <header className="sticky top-0 z-30 shadow-xs">
          <h1 className="sr-only">{t.appName}</h1>
          <PatientBar patientId={props.patientId} encounterId={props.encounterId} classification={props.classification} />
        </header>
        {expired && (
          <div className="mx-auto w-full max-w-3xl px-3 pt-3">
            <Alert tone="warning" role="alert" title={t.session.endedTitle}>{t.session.endedText}</Alert>
          </div>
        )}
        <main className="mx-auto w-full max-w-3xl min-w-0 flex-1 px-3 pb-6">
          <Tabs<TabKey> items={tabs} value={tab} onChange={setTab} label={t.tabs.label}>
            <div className="space-y-3 pt-3">
              {!props.assistantEnabled ? (
                <Alert tone="info" title={t.readOnly.title}>{t.readOnly.text}</Alert>
              ) : tab === "scribe" ? (
                <ScribePanel openSessionId={visitId} onOpenSession={setVisitId} />
              ) : tab === "consultations" ? (
                <>
                  <ConsultationComposer patientId={props.patientId} encounterId={props.encounterId} canReview={props.canReview} canRoute={props.canRoute}
                    assistant={props.assistant} openDraftId={draftId} onOpenDraft={setDraftId} />
                  {!props.canReview && <p className="text-xs text-slate-700">{t.draftsOnly}</p>}
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
        <footer className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-x-2 gap-y-1 px-3 pb-3 text-xs text-slate-700">
          <span>{t.footer}</span>
          <span className="flex flex-wrap items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => setHelp(true)}>{t.shortcuts.title}</Button>
            <Button size="sm" variant="ghost" lang={locale === "ar" ? "en" : "ar"} aria-label={`${t.language.label}: ${t.language.other}`} disabled={switching} onClick={() => void switchLanguage()}>{t.language.other}</Button>
          </span>
        </footer>
      </div>
      <Dialog open={help} onClose={() => setHelp(false)} title={t.shortcuts.title} footer={<Button onClick={() => setHelp(false)}>{t.common.close}</Button>}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
          {t.shortcuts.items.map(([keys, action]) => (
            <div key={keys} className="contents"><dt><kbd dir="ltr" className="rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-xs font-medium">{keys}</kbd></dt><dd>{action}</dd></div>
          ))}
        </dl>
      </Dialog>
    </ToastProvider>
  );
}
