"use client";
import { useState } from "react";
import type { ChartWriteResult, NoteStatement, ProposedChartUpdate, ScribeSessionView, ScribeSpeaker, SoapSection } from "@/shared/contracts";
import { SOAP_SECTIONS } from "@/shared/contracts";
import { AiBadge, Alert, Badge, Button, Card, CardHeader, ConfirmDialog, SegmentedControl, useToast } from "@/apps/embedded-app/components/ui";
import { DeliveryError } from "@/apps/embedded-app/features/consultations/hooks/deliveryState";
import { scribeApi } from "../hooks/scribeApi";

const TITLE: Record<SoapSection, string> = { subjective: "Subjective", objective: "Objective", assessment: "Assessment", plan: "Plan" };
const HINT: Record<SoapSection, string> = {
  subjective: "What the patient reported", objective: "Measurements and findings stated in the visit",
  assessment: "Only what the clinician said they think", plan: "Only what the clinician said will be done",
};
const KIND: Record<ProposedChartUpdate["kind"], string> = { allergy: "Allergy", condition: "Problem", medication: "Medicine the patient takes", vital_sign: "Measurement" };
const SPEAKER: Record<ScribeSpeaker, string> = { clinician: "Clinician", patient: "Patient", other: "Other" };
const RESOURCE: Record<string, string> = { DocumentReference: "Visit note", AllergyIntolerance: "Allergy", Condition: "Problem", MedicationStatement: "Patient-reported medicine" };
const sectionText = (statements: NoteStatement[]) => statements.map((statement) => statement.text).join("\n");
const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

function WriteRow({ write, label }: { write: ChartWriteResult; label: string }) {
  const notify = useToast();
  const done = write.status === "created" || write.status === "existing";
  return (
    <li className="space-y-1 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{label}</span>
        {done ? <Badge tone="success" dot>{write.status === "created" ? "Written to the chart" : "Already in the chart"}</Badge>
          : write.status === "unsupported" ? <Badge tone="warning" dot>Not written: copy it</Badge>
          : write.status === "failed" ? <Badge tone="danger" dot>Not written</Badge> : <Badge tone="neutral" dot>Waiting</Badge>}
        {write.resourceId && <span className="text-xs text-slate-600">EHR record {write.resourceId}</span>}
      </div>
      {write.failure && <p className="text-xs text-slate-700">{write.failure}.</p>}
      {write.copyText && (
        <Button size="sm" onClick={() => void navigator.clipboard.writeText(write.copyText!).then(() => notify("Copied. Paste it into the chart."), () => notify("Copying was blocked by the browser. Select the text and copy it.", "danger"))}>Copy to chart</Button>
      )}
    </li>
  );
}

/** Review of one recorded visit: the transcript, the drafted note with its sources, what is new for the chart, and the physician's approval. */
export function ScribeReview({ session, canApprove, liveTranscription, onChange, onDiscard, onNew }: {
  session: ScribeSessionView; canApprove: boolean; liveTranscription: boolean; onChange(next: ScribeSessionView): void; onDiscard(): void; onNew(): void;
}) {
  const notify = useToast();
  const note = session.note;
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [writeNote, setWriteNote] = useState(true);
  const [focus, setFocus] = useState<{ segmentId: string; quote?: string }>();
  const [editing, setEditing] = useState<SoapSection>();
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const open = session.status === "note_ready";

  async function run(action: () => Promise<ScribeSessionView>, done?: string) {
    setBusy(true);
    setError("");
    try { onChange(await action()); if (done) notify(done); return true; }
    catch (e) { setError(e instanceof DeliveryError ? e.message : "The change could not be saved. Try again."); return false; }
    finally { setBusy(false); }
  }
  function showSource(statement: NoteStatement) {
    const source = statement.sources.find((candidate) => candidate.kind === "transcript");
    if (!source) return;
    setFocus({ segmentId: source.id, quote: source.quote });
    document.getElementById(`segment-${session.id}-${source.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  async function saveSection(section: SoapSection) {
    if (!note) return;
    const lines = draft.split("\n").map((line) => line.replace(/^\s*[-•]\s*/, "").trim()).filter(Boolean);
    const sections = Object.fromEntries(SOAP_SECTIONS.map((key) => [key, key === section
      // A line you did not change keeps its sources; a changed or new line becomes your own text.
      ? lines.map((text) => ({ id: note.sections[key].find((statement) => statement.text === text)?.id, text }))
      : note.sections[key].map((statement) => ({ id: statement.id, text: statement.text }))])) as Record<SoapSection, { id?: string; text: string }[]>;
    if (await run(() => scribeApi.edit(session.id, session.noteVersion, sections), "Section saved.")) setEditing(undefined);
  }
  const swapSpeakers = () => run(() => scribeApi.relabel(session.id, session.segments.map((segment) => ({ id: segment.id, speaker: segment.speaker === "clinician" ? "patient" : segment.speaker === "patient" ? "clinician" : segment.speaker }))));
  const chosen = (note?.proposedUpdates ?? []).filter((update) => selected.includes(update.id));

  if (!note) {
    return (
      <Card className="space-y-3">
        <CardHeader title="Visit recorded" description="The note has not been written yet." />
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" busy={busy} busyLabel="Writing the note…" onClick={() => void run(() => scribeApi.generate(session.id))}>Write the note</Button>
          <Button variant="ghost" onClick={onDiscard}>Discard recording</Button>
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
      </Card>
    );
  }
  const newUpdates = note.proposedUpdates.filter((update) => update.relation === "new" && update.kind !== "vital_sign");
  const conflicts = note.proposedUpdates.filter((update) => update.relation === "conflicts");
  const known = note.proposedUpdates.filter((update) => update.relation === "already_in_chart");
  const measurements = note.proposedUpdates.filter((update) => update.relation === "new" && update.kind === "vital_sign");

  return (
    <section aria-label="Visit note review" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onNew}>Record another visit</Button>
        <span className="text-xs text-slate-700">{clock(session.audioSeconds * 1000)} recorded · cost ${session.spendUsd.toFixed(4)}</span>
      </div>

      <Card className="space-y-3">
        <CardHeader title="Visit note (SOAP)" actions={<>{note.provenance.liveInference ? <AiBadge /> : <Badge tone="warning">Demo fallback (no AI inference)</Badge>}
          {session.status === "note_ready" ? <Badge tone="warning" dot>Awaiting physician review</Badge> : <Badge tone="success" dot>Approved</Badge>}</>}
          description={note.provenance.liveInference
            ? `Drafted by ${note.provenance.model} from the transcript. Every statement points at the words of the visit that support it.`
            : "No language model is configured: each sentence of the transcript is listed as it was said."} />
        {(note.rejectedStatements > 0 || note.rejectedUpdates > 0) && (
          <Alert tone="warning">{note.rejectedStatements + note.rejectedUpdates} drafted item{note.rejectedStatements + note.rejectedUpdates === 1 ? " was" : "s were"} removed because the words of the visit did not support {note.rejectedStatements + note.rejectedUpdates === 1 ? "it" : "them"}. Check the transcript for anything missing.</Alert>
        )}
        {SOAP_SECTIONS.map((section) => (
          <section key={section} aria-label={TITLE[section]} className="space-y-1">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold">{TITLE[section]} <span className="text-xs font-normal text-slate-600">{HINT[section]}</span></h3>
              {open && editing !== section && <Button size="sm" variant="ghost" onClick={() => { setEditing(section); setDraft(sectionText(note.sections[section])); }}>Edit</Button>}
            </div>
            {editing === section ? (
              <div className="space-y-2">
                <label className="sr-only" htmlFor={`edit-${section}`}>Edit {TITLE[section]}, one statement per line</label>
                <textarea id={`edit-${section}`} className="field" rows={Math.max(3, draft.split("\n").length + 1)} value={draft} onChange={(event) => setDraft(event.target.value)} dir="auto" />
                <p className="text-xs text-slate-700">One statement per line. A line you change or add is marked as written by you.</p>
                <div className="flex gap-2"><Button size="sm" variant="primary" busy={busy} onClick={() => void saveSection(section)}>Save section</Button><Button size="sm" onClick={() => setEditing(undefined)}>Cancel</Button></div>
              </div>
            ) : note.sections[section].length ? (
              <ul className="space-y-1">
                {note.sections[section].map((statement) => (
                  <li key={statement.id} className="text-sm" dir="auto">
                    <span className="break-words">{statement.text}</span>{" "}
                    {statement.editedByClinician ? <Badge tone="neutral">Written by you</Badge>
                      : statement.sources.some((source) => source.kind === "transcript")
                        ? <button type="button" className="badge badge-primary cursor-pointer hover:underline" onClick={() => showSource(statement)}>Source: visit {statement.sources.find((source) => source.kind === "transcript")!.id.slice(1)}</button>
                        : <Badge tone="primary">Source: chart</Badge>}
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-slate-700">Nothing documented.</p>}
          </section>
        ))}
      </Card>

      <Card className="space-y-3" aria-label="Information for the chart">
        <CardHeader level={3} title="Information for the chart" description="Heard in this visit. Nothing is written unless you select it and approve." />
        {conflicts.length > 0 && (
          <Alert tone="danger" title="Differs from the chart. Resolve it in the EHR">
            <ul className="mt-1 space-y-1.5">
              {conflicts.map((update) => (
                <li key={update.id}><span className="font-medium">{KIND[update.kind]}: {update.name}.</span> {update.explanation ?? update.detail}
                  {" "}<button type="button" className="font-medium underline" onClick={() => { setFocus(update.source); document.getElementById(`segment-${session.id}-${update.source.segmentId}`)?.scrollIntoView({ block: "center", behavior: "smooth" }); }}>Hear it in the visit</button></li>
              ))}
            </ul>
            <p className="mt-1 text-xs">StethoLink never chooses which is right and writes neither side.</p>
          </Alert>
        )}
        {newUpdates.length > 0 ? (
          <fieldset className="space-y-2" disabled={!open || !canApprove}>
            <legend className="section-title">New: select what to add to the chart</legend>
            {newUpdates.map((update) => (
              <div key={update.id} className="rounded-md border border-slate-200 p-2.5">
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-0.5 size-4" checked={selected.includes(update.id)}
                    onChange={(event) => { setSelected((current) => event.target.checked ? [...current, update.id] : current.filter((id) => id !== update.id)); if (!event.target.checked) setConfirmed((current) => current.filter((id) => id !== update.id)); }} />
                  <span className="min-w-0"><span className="text-sm font-medium">{KIND[update.kind]}: {update.name}</span>{update.detail && <span className="block text-sm text-slate-800">{update.detail}</span>}
                    <span className="block text-xs text-slate-700" dir="auto">Said in the visit: &ldquo;{update.source.quote}&rdquo;</span></span>
                </label>
                {update.kind === "allergy" && selected.includes(update.id) && (
                  <label className="ms-6 mt-1.5 flex items-start gap-2 text-xs text-slate-800">
                    <input type="checkbox" className="mt-0.5 size-3.5" checked={confirmed.includes(update.id)} onChange={(event) => setConfirmed((current) => event.target.checked ? [...current, update.id] : current.filter((id) => id !== update.id))} />
                    I confirm this allergy myself. Otherwise it is recorded as unconfirmed (reported by the patient).
                  </label>
                )}
              </div>
            ))}
          </fieldset>
        ) : <p className="text-sm text-slate-700">Nothing new for the chart was heard in this visit.</p>}
        {measurements.length > 0 && <p className="text-xs text-slate-700">Measurements stated aloud are part of the note text: {measurements.map((update) => `${update.name} ${update.detail ?? ""}`.trim()).join("; ")}.</p>}
        {known.length > 0 && <p className="text-xs text-slate-700">Already in the chart: {known.map((update) => update.name).join(", ")}.</p>}
      </Card>

      {session.writes.length > 0 && (
        <Card aria-label="Chart result">
          <CardHeader level={3} title="Result in the chart" />
          <ul className="divide-y divide-slate-200">
            {session.writes.map((write) => <WriteRow key={write.itemKey} write={write} label={write.item === "note" ? "Visit note" : `${RESOURCE[write.resourceType] ?? write.resourceType}: ${note.proposedUpdates.find((update) => update.id === write.item)?.name ?? ""}`} />)}
          </ul>
          {session.writes.some((write) => write.status === "failed") && canApprove && session.approval && (
            <div className="mt-2"><Button busy={busy} busyLabel="Trying again…" onClick={() => void run(() => scribeApi.approve(session.id, session.approval!.noteVersion, session.approval!.selection))}>Try the failed items again</Button>
              <p className="mt-1 text-xs text-slate-700">Items already written are not written again.</p></div>
          )}
        </Card>
      )}

      {open && (
        <Card className="space-y-2">
          {canApprove ? (
            <>
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 size-4" checked={writeNote} onChange={(event) => setWriteNote(event.target.checked)} />Write the note to the chart</label>
              <div className="flex flex-wrap gap-2">
                <Button variant="success" disabled={busy || !!editing} onClick={() => setConfirming(true)}>Approve and write to chart</Button>
                <Button variant="ghost" onClick={onDiscard}>Discard this visit</Button>
              </div>
              {editing && <p className="text-xs text-slate-700">Save or cancel your edit first.</p>}
            </>
          ) : <p role="status" className="text-sm text-slate-700">A physician must review and approve this note before anything is written to the chart.</p>}
        </Card>
      )}
      {error && <Alert tone="danger">{error}</Alert>}

      <Card aria-label="Transcript" className="space-y-2">
        <CardHeader level={3} title="Transcript" description={session.transcriptDeleted ? undefined : `The words cannot be edited. Deleted when the note is in the chart, or on ${new Date(session.transcriptExpiresAt).toLocaleDateString(undefined, { dateStyle: "medium" })}.`}
          actions={open && session.segments.some((segment) => segment.speaker) ? <Button size="sm" disabled={busy} onClick={() => void swapSpeakers()}>Swap clinician and patient</Button> : undefined} />
        {!liveTranscription && !session.transcriptDeleted && <Alert tone="warning">Demo stand-in: this is a fixed fictional visit, not what was recorded.</Alert>}
        {session.transcriptDeleted ? <p className="text-sm text-slate-700">The transcript was deleted. The audio was never stored.</p> : (
          <ol className="space-y-1.5">
            {session.segments.map((segment) => {
              const marked = focus?.segmentId === segment.id;
              return (
                <li key={segment.id} id={`segment-${session.id}-${segment.id}`} className={`rounded px-1.5 py-1 text-sm ${marked ? "bg-sky-100 outline outline-sky-600" : ""}`}>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                    <span>{segment.id.slice(1)} · {clock(segment.startMs)}</span>
                    {open ? (
                      <SegmentedControl label={`Speaker of sentence ${segment.id.slice(1)}`} disabled={busy} value={segment.speaker ?? "other"}
                        options={[{ value: "clinician", label: "Clinician" }, { value: "patient", label: "Patient" }, { value: "other", label: "Not set" }]}
                        onChange={(value) => void run(() => scribeApi.relabel(session.id, [{ id: segment.id, speaker: value === "other" ? null : value }]))} />
                    ) : segment.speaker && <span>{SPEAKER[segment.speaker]}</span>}
                  </div>
                  <p dir="auto" className="break-words">{segment.text}</p>
                  {marked && focus?.quote && <p dir="auto" className="mt-0.5 text-xs text-sky-900">Quoted: &ldquo;{focus.quote}&rdquo;</p>}
                </li>
              );
            })}
          </ol>
        )}
      </Card>

      <ConfirmDialog open={confirming} onClose={() => setConfirming(false)} title="Approve this note and write to the chart?" confirmLabel="Approve and write" variant="success" busy={busy} error={error || undefined}
        canConfirm={writeNote || chosen.length > 0}
        onConfirm={() => void run(() => scribeApi.approve(session.id, session.noteVersion, { note: writeNote, updates: selected, confirmedAllergies: confirmed.filter((id) => selected.includes(id)) }), "Approved.").then((ok) => { if (ok) setConfirming(false); })}>
        <p className="font-medium">Exactly this will be written to the patient&apos;s chart in the EHR, under your name:</p>
        <ul className="list-disc space-y-1 ps-5 text-slate-800">
          {writeNote && <li>The visit note above, as a clinical note for this visit, for you to sign in the EHR.</li>}
          {chosen.map((update) => (
            <li key={update.id}>{KIND[update.kind]}: <span className="font-medium">{update.name}</span>{update.detail ? `, ${update.detail}` : ""}
              {update.kind === "allergy" && <> ({confirmed.includes(update.id) ? "confirmed by you" : "unconfirmed, reported by the patient"})</>}</li>
          ))}
          {!writeNote && chosen.length === 0 && <li>Nothing is selected.</li>}
        </ul>
        <p className="font-medium">What does not happen</p>
        <ul className="list-disc space-y-0.5 ps-5 text-slate-800">
          <li>Nothing that is already in the chart is changed or removed.</li>
          <li>Items you did not select, and anything that differs from the chart, are not written.</li>
        </ul>
        <p className="text-xs text-slate-700">This cannot be undone from StethoLink. If the EHR does not accept an item, you get its text to copy instead. Pressing the button twice never writes twice.</p>
      </ConfirmDialog>
    </section>
  );
}
