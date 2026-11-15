"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ScribeCapabilities, ScribeSessionView } from "@/shared/contracts";
import { Alert, Badge, Button, Card, CardHeader, ConfirmDialog, EmptyState, Skeleton, WorkInProgress, useToast } from "@/apps/embedded-app/components/ui";
import { CancelledError, DeliveryError } from "@/apps/embedded-app/features/consultations/hooks/deliveryState";
import { scribeApi } from "../hooks/scribeApi";
import { useRecorder, type MicrophoneProblem, type RecordedChunk } from "../hooks/useRecorder";
import { ScribeReview } from "./ScribeReview";

const PROBLEM: Record<MicrophoneProblem, { title: string; text: string; newWindow?: boolean }> = {
  blocked_by_frame: { title: "The microphone is not allowed inside the EHR window", text: "Your EHR has not given this panel access to the microphone. Open StethoLink in its own window to record this visit. Ask your EHR administrator to allow the microphone for StethoLink so this step is not needed.", newWindow: true },
  denied: { title: "The microphone was not allowed", text: "Allow microphone access for this site in your browser's address bar, then start again." },
  no_device: { title: "No microphone was found", text: "Connect a microphone, then start again." },
  unsupported: { title: "This browser cannot record", text: "Use a current version of Chrome or Edge to record a visit." },
};
const clock = (ms: number) => `${String(Math.floor(ms / 60_000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const STEPS = ["Reading the transcript", "Writing the note", "Checking every statement against the words of the visit", "Comparing new information with the chart"];

/**
 * Records a visit and turns it into a note for the physician to review. Recording starts only
 * after the clinician confirms that the patient agreed, and a clear indicator stays on while it runs.
 */
export function ScribePanel({ openSessionId, onOpenSession }: { openSessionId?: string; onOpenSession?(id: string | undefined): void }) {
  const notify = useToast();
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
            setError(e instanceof DeliveryError ? e.message : "A part of the recording could not be sent.");
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 800 * 2 ** attempt));
        }
      }
    });
  }, []);
  const recorder = useRecorder(onChunk);

  useEffect(() => {
    let active = true;
    scribeApi.capabilities().then((value) => active && setCapabilities(value)).catch((e) => active && setLoadError(e instanceof DeliveryError ? e.message : "The scribe could not be loaded."));
    return () => { active = false; };
  }, []);
  // Reopening a visit from History.
  useEffect(() => {
    if (!openSessionId || openSessionId === sessionId.current) return;
    let active = true;
    scribeApi.get(openSessionId).then((value) => { if (active) { sessionId.current = value.id; setSession(value); } }).catch((e) => active && setError(e instanceof DeliveryError ? e.message : "The visit could not be opened."));
    return () => { active = false; };
  }, [openSessionId]);

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
      setError(e instanceof DeliveryError ? e.message : "The recording could not be started.");
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
      if (!(e instanceof CancelledError)) setError(e instanceof DeliveryError ? e.message : "The note could not be written. Try again.");
      await scribeApi.get(id).then(setSession).catch(() => undefined);
    } finally { setBusy(undefined); }
  }
  async function discard() {
    const id = sessionId.current;
    if (!id) return;
    if (recorder.state.phase === "recording" || recorder.state.phase === "paused") recorder.stop();
    await scribeApi.discard(id).then(() => notify("The recording and its transcript were deleted.", "info")).catch((e) => setError(e instanceof DeliveryError ? e.message : "The visit could not be discarded."));
    sessionId.current = undefined;
    setSession(undefined);
    onOpenSession?.(undefined);
  }
  function reset() { sessionId.current = undefined; setSession(undefined); setError(""); onOpenSession?.(undefined); }

  if (loadError) return <Alert tone="danger">{loadError}</Alert>;
  if (!capabilities) return <Card><Skeleton label="Loading the scribe" lines={3} /></Card>;
  if (!capabilities.enabled) return <EmptyState title="Scribe is not switched on">{capabilities.reason ?? "Recording a visit is not set up for this hospital yet."}</EmptyState>;

  const live = recorder.state.phase === "recording" || recorder.state.phase === "paused";
  const problem = recorder.state.problem ? PROBLEM[recorder.state.problem] : undefined;
  const nearLimit = recorder.state.elapsedMs > (capabilities.maxMinutes - 2) * 60_000;

  if (session && !live && busy !== "generating" && session.status !== "recording") {
    return <ScribeReview session={session} canApprove={capabilities.canApprove} liveTranscription={capabilities.liveTranscription} onChange={setSession} onDiscard={() => void discard()} onNew={reset} />;
  }
  return (
    <Card aria-label="Visit scribe" className="space-y-3">
      <CardHeader title="Visit scribe" description={`Records the visit, then drafts a note for you to review. Spoken language: ${capabilities.spokenLanguage}. Note language: ${capabilities.noteLanguage === "ar" ? "Arabic" : "English"}.`} />
      {!capabilities.liveTranscription && (
        <Alert tone="warning"><span className="font-semibold">Demo stand-in.</span> No transcription service is configured. Whatever is recorded, a fixed fictional visit is used as the transcript.</Alert>
      )}
      {problem && (
        <Alert tone="danger" title={problem.title} action={problem.newWindow ? <Button size="sm" onClick={() => window.open(window.location.href, "_blank", "noopener")}>Open in a new window</Button> : undefined}>{problem.text}</Alert>
      )}
      {busy === "generating" ? (
        <WorkInProgress label="Writing the note from the visit" steps={STEPS} expectedSeconds={40} onCancel={() => abort.current?.abort()} />
      ) : live ? (
        <div className="space-y-3">
          <div role="status" aria-live="polite" className={`flex flex-wrap items-center gap-3 rounded-md border p-3 ${recorder.state.phase === "recording" ? "border-red-700 bg-red-50" : "border-slate-400 bg-slate-50"}`}>
            <span aria-hidden="true" className={`size-3 rounded-full ${recorder.state.phase === "recording" ? "animate-pulse bg-red-700" : "bg-slate-500"}`} />
            <span className="text-sm font-semibold text-slate-900">{recorder.state.phase === "recording" ? "Recording" : "Paused. Not recording"}</span>
            <span className="text-sm tabular-nums text-slate-800" aria-label="Recorded time">{clock(recorder.state.elapsedMs)}</span>
            <span aria-hidden="true" className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-200"><span className="block h-full bg-red-700" style={{ width: `${Math.round(recorder.state.level * 100)}%` }} /></span>
          </div>
          <div className="flex flex-wrap gap-2">
            {recorder.state.phase === "recording" ? <Button onClick={recorder.pause}>Pause</Button> : <Button onClick={recorder.resume}>Resume</Button>}
            <Button variant="primary" onClick={() => void finish()}>End visit and write note</Button>
            <Button variant="ghost" onClick={() => void discard()}>Discard recording</Button>
          </div>
          <p className="text-xs text-slate-700">
            {uploads.sent} part{uploads.sent === 1 ? "" : "s"} transcribed{uploads.pending ? `, ${uploads.pending} being sent` : ""}{uploads.failed ? `, ${uploads.failed} could not be sent` : ""}.
            {" "}The audio is not kept: each part is turned into text and dropped.
          </p>
          {nearLimit && <Alert tone="warning">Recording stops being accepted at {capabilities.maxMinutes} minutes. End the visit to write the note.</Alert>}
        </div>
      ) : (
        <div className="space-y-2">
          <Button variant="primary" onClick={() => { setAgreed(false); setError(""); setConsentOpen(true); }}>Start recording</Button>
          <ul className="list-disc space-y-0.5 ps-5 text-xs text-slate-700">
            <li>You confirm the patient&apos;s agreement before anything is recorded.</li>
            <li>The audio is never stored. The transcript is deleted when the note is in the chart, or after {capabilities.transcriptRetentionDays} days.</li>
            <li>The note is a draft. Nothing reaches the chart until the physician approves it.</li>
          </ul>
          {session?.status === "recording" && <Alert tone="info" action={<Button size="sm" onClick={() => void finish()}>Write the note from what was recorded</Button>}>A recording of this visit was interrupted.</Alert>}
        </div>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <ConfirmDialog open={consentOpen} onClose={() => setConsentOpen(false)} onConfirm={() => void begin()} title="Before you record" confirmLabel="Start recording" busy={busy === "starting"} canConfirm={agreed}>
        <p>Tell the patient that the visit will be recorded to write the clinical note, and ask whether they agree.</p>
        <label className="flex items-start gap-2 rounded-md border border-slate-300 p-2.5">
          <input type="checkbox" className="mt-0.5 size-4" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
          <span className="font-medium">The patient agreed verbally to this visit being recorded.</span>
        </label>
        <ul className="list-disc space-y-0.5 ps-5 text-slate-800">
          <li>Your confirmation is saved with the visit, with the time and your name.</li>
          <li>A red &quot;Recording&quot; indicator stays visible. You can pause or stop at any time.</li>
          <li>If the patient does not agree, do not record. Close this window.</li>
        </ul>
      </ConfirmDialog>
      {session && <p className="text-xs text-slate-600"><Badge tone="neutral">Visit in progress</Badge></p>}
    </Card>
  );
}
