"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ScribeCapabilities, ScribeSessionView } from "@/shared/contracts";
import { Alert, Badge, Button, Card, CardHeader, ConfirmDialog, EmptyState, Skeleton, WorkInProgress, useToast } from "@/apps/embedded-app/components/ui";
import { CancelledError, DeliveryError } from "@/apps/embedded-app/features/consultations/hooks/deliveryState";
import { useT } from "@/apps/embedded-app/i18n/client";
import { scribeApi } from "../hooks/scribeApi";
import { useRecorder, type RecordedChunk } from "../hooks/useRecorder";
import { ScribeReview } from "./ScribeReview";

const clock = (ms: number) => `${String(Math.floor(ms / 60_000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
/**
 * Records a visit and turns it into a note for the physician to review. Recording starts only
 * after the clinician confirms that the patient agreed, and a clear indicator stays on while it runs.
 */
export function ScribePanel({ openSessionId, onOpenSession }: { openSessionId?: string; onOpenSession?(id: string | undefined): void }) {
  const notify = useToast();
  const { t } = useT();
  const w = t.work.scribe;
  const [capabilities, setCapabilities] = useState<ScribeCapabilities>();
  const [loadError, setLoadError] = useState("");
  const [session, setSession] = useState<ScribeSessionView>();
  const [consentOpen, setConsentOpen] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState<"starting" | "generating" | undefined>(undefined);
  const [error, setError] = useState("");
  const [uploads, setUploads] = useState({ sent: 0, pending: 0, failed: 0 });
  const sessionId = useRef<string | undefined>(undefined);
  const startKey = useRef<string | undefined>(undefined);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const abort = useRef<AbortController | undefined>(undefined);

  // Parts are sent one after another, in order, each retried before the next: the transcript keeps the order of the conversation.
  const onChunk = useCallback((chunk: RecordedChunk) => {
    const id = sessionId.current;
    if (!id) return;
    setUploads((u) => ({ ...u, pending: u.pending + 1 }));
    queue.current = queue.current.then(async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await scribeApi.uploadChunk(id, chunk.index, chunk.durationMs, chunk.audio);
          setUploads((u) => ({ ...u, pending: u.pending - 1, sent: u.sent + 1 }));
          return;
        } catch (e) {
          if ((e as { final?: boolean }).final || attempt === 3) {
            setUploads((u) => ({ ...u, pending: u.pending - 1, failed: u.failed + 1 }));
            setError(e instanceof DeliveryError ? e.message : w.errors.chunk);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 800 * 2 ** attempt));
        }
      }
    });
  }, [w.errors.chunk]);
  const recorder = useRecorder(onChunk);

  useEffect(() => {
    let active = true;
    scribeApi.capabilities().then((value) => active && setCapabilities(value)).catch((e) => active && setLoadError(e instanceof DeliveryError ? e.message : w.loadError));
    return () => { active = false; };
  }, [w.loadError]);
  // Reopening a visit from History.
  useEffect(() => {
    if (!openSessionId || openSessionId === sessionId.current) return;
    let active = true;
    scribeApi.get(openSessionId).then((value) => { if (active) { sessionId.current = value.id; setSession(value); } }).catch((e) => active && setError(e instanceof DeliveryError ? e.message : w.errors.open));
    return () => { active = false; };
  }, [openSessionId, w.errors.open]);

  async function begin() {
    setBusy("starting");
    setError("");
    try {
      const started = await scribeApi.start(startKey.current ??= crypto.randomUUID());
      sessionId.current = started.id;
      setUploads({ sent: 0, pending: 0, failed: 0 });
      // The microphone is requested only now, after the consent statement was recorded.
      if (await recorder.start()) { setSession(started); setConsentOpen(false); }
      else { await scribeApi.discard(started.id).catch(() => undefined); sessionId.current = undefined; setConsentOpen(false); }
      startKey.current = undefined;
    } catch (e) {
      setError(e instanceof DeliveryError ? e.message : w.errors.start);
      setConsentOpen(false);
    } finally { setBusy(undefined); }
  }
  async function finish() {
    const id = sessionId.current;
    if (!id) return;
    recorder.stop();
    setBusy("generating");
    setError("");
    abort.current = new AbortController();
    try {
      // Wait for the last part to arrive before the note is written.
      await new Promise((resolve) => setTimeout(resolve, 400));
      await queue.current;
      const view = await scribeApi.generate(id, abort.current.signal);
      setSession(view);
      onOpenSession?.(id);
    } catch (e) {
      if (!(e instanceof CancelledError)) setError(e instanceof DeliveryError ? e.message : w.errors.note);
      await scribeApi.get(id).then(setSession).catch(() => undefined);
    } finally { setBusy(undefined); }
  }
  async function discard() {
    const id = sessionId.current;
    if (!id) return;
    if (recorder.state.phase === "recording" || recorder.state.phase === "paused") recorder.stop();
    await scribeApi.discard(id).then(() => notify(w.deleted, "info")).catch((e) => setError(e instanceof DeliveryError ? e.message : w.errors.discard));
    sessionId.current = undefined;
    setSession(undefined);
    onOpenSession?.(undefined);
  }
  function reset() { sessionId.current = undefined; setSession(undefined); setError(""); onOpenSession?.(undefined); }

  if (loadError) return <Alert tone="danger">{loadError}</Alert>;
  if (!capabilities) return <Card><Skeleton label={w.loading} lines={3} /></Card>;
  if (!capabilities.enabled) return <EmptyState title={w.offTitle}>{capabilities.reason ?? w.offFallback}</EmptyState>;

  const live = recorder.state.phase === "recording" || recorder.state.phase === "paused";
  const problem = recorder.state.problem ? w.problems[recorder.state.problem] : undefined;
  const nearLimit = recorder.state.elapsedMs > (capabilities.maxMinutes - 2) * 60_000;

  if (session && !live && busy !== "generating" && session.status !== "recording") {
    return <ScribeReview session={session} canApprove={capabilities.canApprove} onChange={setSession} onDiscard={() => void discard()} onNew={reset} />;
  }
  return (
    <Card aria-label={w.title} className="space-y-3">
      <CardHeader title={w.title} description={w.description(capabilities.spokenLanguage, w.languageName[capabilities.noteLanguage === "ar" ? "ar" : "en"])} />
      {problem && (
        <Alert tone="danger" title={problem.title}>{problem.text}</Alert>
      )}
      {busy === "generating" ? (
        <WorkInProgress label={w.working} steps={w.steps} expectedSeconds={40} onCancel={() => abort.current?.abort()} />
      ) : live ? (
        <div className="space-y-3">
          <div role="status" aria-live="polite" className={`flex flex-wrap items-center gap-3 rounded-md border p-3 ${recorder.state.phase === "recording" ? "border-red-700 bg-red-50" : "border-slate-400 bg-slate-50"}`}>
            <span aria-hidden="true" className={`size-3 rounded-full ${recorder.state.phase === "recording" ? "animate-pulse bg-red-700" : "bg-slate-500"}`} />
            <span className="text-sm font-semibold text-slate-900">{recorder.state.phase === "recording" ? w.recording : w.paused}</span>
            <span className="text-sm tabular-nums text-slate-800" aria-label={w.recordedTime}>{clock(recorder.state.elapsedMs)}</span>
            <span aria-hidden="true" className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-200"><span className="block h-full bg-red-700" style={{ width: `${Math.round(recorder.state.level * 100)}%` }} /></span>
          </div>
          <div className="flex flex-wrap gap-2">
            {recorder.state.phase === "recording" ? <Button onClick={recorder.pause}>{w.pause}</Button> : <Button onClick={recorder.resume}>{w.resume}</Button>}
            <Button variant="primary" onClick={() => void finish()}>{w.endVisit}</Button>
            <Button variant="ghost" onClick={() => void discard()}>{w.discardRecording}</Button>
          </div>
          <p className="text-xs text-slate-700">
            {w.uploads(uploads.sent, uploads.pending, uploads.failed)}
            {" "}{w.audioNotKept}
          </p>
          {nearLimit && <Alert tone="warning">{w.nearLimit(capabilities.maxMinutes)}</Alert>}
        </div>
      ) : (
        <div className="space-y-2">
          <Button variant="primary" onClick={() => { setAgreed(false); setError(""); setConsentOpen(true); }}>{w.start}</Button>
          <ul className="list-disc space-y-0.5 ps-5 text-xs text-slate-700">
            <li>{w.bullet1}</li>
            <li>{w.bullet2(capabilities.transcriptRetentionDays)}</li>
            <li>{w.bullet3}</li>
          </ul>
          {session?.status === "recording" && <Alert tone="info" action={<Button size="sm" onClick={() => void finish()}>{w.writeFromRecorded}</Button>}>{w.interrupted}</Alert>}
        </div>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <ConfirmDialog open={consentOpen} onClose={() => setConsentOpen(false)} onConfirm={() => void begin()} title={w.consentTitle} confirmLabel={w.start} busy={busy === "starting"} canConfirm={agreed}>
        <p>{w.consentIntro}</p>
        <label className="flex items-start gap-2 rounded-md border border-slate-300 p-2.5">
          <input type="checkbox" className="mt-0.5 size-4" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
          <span className="font-medium">{w.consentCheck}</span>
        </label>
        <ul className="list-disc space-y-0.5 ps-5 text-slate-800">
          {w.consentBullets.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </ConfirmDialog>
      {session && <p className="text-xs text-slate-600"><Badge tone="neutral">{w.inProgress}</Badge></p>}
    </Card>
  );
}
