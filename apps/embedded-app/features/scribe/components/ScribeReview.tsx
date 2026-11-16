"use client";
import { useState } from "react";
import type { ChartWriteResult, NoteStatement, ScribeSessionView, SoapSection } from "@/shared/contracts";
import { SOAP_SECTIONS } from "@/shared/contracts";
import { AiBadge, Alert, Badge, Button, Card, CardHeader, ConfirmDialog, SegmentedControl, useToast } from "@/apps/embedded-app/components/ui";
import { DeliveryError } from "@/apps/embedded-app/features/consultations/hooks/deliveryState";
import { useT } from "@/apps/embedded-app/i18n/client";
import { formatDate } from "@/apps/embedded-app/i18n/format";
import { scribeApi } from "../hooks/scribeApi";

const sectionText = (statements: NoteStatement[]) => statements.map((statement) => statement.text).join("\n");
const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

function WriteRow({ write, label }: { write: ChartWriteResult; label: string }) {
  const notify = useToast();
  const { t } = useT();
  const r = t.work.scribeReview;
  const done = write.status === "created" || write.status === "existing";
  return (
    <li className="space-y-1 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{label}</span>
        {done ? <Badge tone="success" dot>{write.status === "created" ? r.written : r.existing}</Badge>
          : write.status === "unsupported" ? <Badge tone="warning" dot>{r.unsupported}</Badge>
          : write.status === "failed" ? <Badge tone="danger" dot>{r.failed}</Badge> : <Badge tone="neutral" dot>{r.waiting}</Badge>}
        {write.resourceId && <span className="text-xs text-slate-600"><bdi dir="ltr">{r.ehrRecord(write.resourceId)}</bdi></span>}
      </div>
      {write.failure && <p className="text-xs text-slate-700" dir="auto">{write.failure}.</p>}
      {write.copyText && (
        <Button size="sm" onClick={() => void navigator.clipboard.writeText(write.copyText!).then(() => notify(r.copied), () => notify(r.copyBlocked, "danger"))}>{r.copyToChart}</Button>
      )}
    </li>
  );
}

/** Review of one recorded visit: the transcript, the drafted note with its sources, what is new for the chart, and the physician's approval. */
export function ScribeReview({ session, canApprove, onChange, onDiscard, onNew }: {
  session: ScribeSessionView; canApprove: boolean; onChange(next: ScribeSessionView): void; onDiscard(): void; onNew(): void;
}) {
  const notify = useToast();
  const { t, locale } = useT();
  const r = t.work.scribeReview;
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
    catch (e) { setError(e instanceof DeliveryError ? e.message : r.changeError); return false; }
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
    if (await run(() => scribeApi.edit(session.id, session.noteVersion, sections), r.sectionSaved)) setEditing(undefined);
  }
  const swapSpeakers = () => run(() => scribeApi.relabel(session.id, session.segments.map((segment) => ({ id: segment.id, speaker: segment.speaker === "clinician" ? "patient" : segment.speaker === "patient" ? "clinician" : segment.speaker }))));
  const chosen = (note?.proposedUpdates ?? []).filter((update) => selected.includes(update.id));

  if (!note) {
    return (
      <Card className="space-y-3">
        <CardHeader title={r.recordedTitle} description={r.notWrittenYet} />
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" busy={busy} busyLabel={r.writingNote} onClick={() => void run(() => scribeApi.generate(session.id))}>{r.writeNote}</Button>
          <Button variant="ghost" onClick={onDiscard}>{r.discardRecording}</Button>
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
    <section aria-label={r.aria} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onNew}>{r.recordAnother}</Button>
        <span className="text-xs text-slate-700">{r.stats(clock(session.audioSeconds * 1000), session.spendUsd.toFixed(4))}</span>
      </div>

      <Card className="space-y-3">
        <CardHeader title={r.noteTitle} actions={<>{note.provenance.liveInference ? <AiBadge /> : <Badge tone="warning">{r.noAi}</Badge>}
          {session.status === "note_ready" ? <Badge tone="warning" dot>{r.awaiting}</Badge> : <Badge tone="success" dot>{r.approved}</Badge>}</>}
          description={note.provenance.liveInference
            ? r.draftedBy(note.provenance.model)
            : r.storedWithout} />
        {(note.rejectedStatements > 0 || note.rejectedUpdates > 0) && (
          <Alert tone="warning">{r.removed(note.rejectedStatements + note.rejectedUpdates)}</Alert>
        )}
        {SOAP_SECTIONS.map((section) => (
          <section key={section} aria-label={r.soapTitle[section]} className="space-y-1">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold">{r.soapTitle[section]} <span className="text-xs font-normal text-slate-600">{r.soapHint[section]}</span></h3>
              {open && editing !== section && <Button size="sm" variant="ghost" onClick={() => { setEditing(section); setDraft(sectionText(note.sections[section])); }}>{r.edit}</Button>}
            </div>
            {editing === section ? (
              <div className="space-y-2">
                <label className="sr-only" htmlFor={`edit-${section}`}>{r.editLabel(r.soapTitle[section])}</label>
                <textarea id={`edit-${section}`} className="field" rows={Math.max(3, draft.split("\n").length + 1)} value={draft} onChange={(event) => setDraft(event.target.value)} dir="auto" />
                <p className="text-xs text-slate-700">{r.editHint}</p>
                <div className="flex gap-2"><Button size="sm" variant="primary" busy={busy} onClick={() => void saveSection(section)}>{r.saveSection}</Button><Button size="sm" onClick={() => setEditing(undefined)}>{t.common.cancel}</Button></div>
              </div>
            ) : note.sections[section].length ? (
              <ul className="space-y-1">
                {note.sections[section].map((statement) => (
                  <li key={statement.id} className="text-sm" dir="auto">
                    <span className="break-words">{statement.text}</span>{" "}
                    {statement.editedByClinician ? <Badge tone="neutral">{r.writtenByYou}</Badge>
                      : statement.sources.some((source) => source.kind === "transcript")
                        ? <button type="button" className="badge badge-primary cursor-pointer hover:underline" onClick={() => showSource(statement)}>{r.sourceVisit(statement.sources.find((source) => source.kind === "transcript")!.id.slice(1))}</button>
                        : <Badge tone="primary">{r.sourceChart}</Badge>}
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-slate-700">{r.nothingDocumented}</p>}
          </section>
        ))}
      </Card>

      <Card className="space-y-3" aria-label={r.chartInfoTitle}>
        <CardHeader level={3} title={r.chartInfoTitle} description={r.chartInfoDesc} />
        {conflicts.length > 0 && (
          <Alert tone="danger" title={r.conflictsTitle}>
            <ul className="mt-1 space-y-1.5">
              {conflicts.map((update) => (
                <li key={update.id} dir="auto"><span className="font-medium">{r.kind[update.kind]}: {update.name}.</span> {update.explanation ?? update.detail}
                  {" "}<button type="button" className="font-medium underline" onClick={() => { setFocus(update.source); document.getElementById(`segment-${session.id}-${update.source.segmentId}`)?.scrollIntoView({ block: "center", behavior: "smooth" }); }}>{r.hearIt}</button></li>
              ))}
            </ul>
            <p className="mt-1 text-xs">{r.neverChooses}</p>
          </Alert>
        )}
        {newUpdates.length > 0 ? (
          <fieldset className="space-y-2" disabled={!open || !canApprove}>
            <legend className="section-title">{r.newLegend}</legend>
            {newUpdates.map((update) => (
              <div key={update.id} className="rounded-md border border-slate-200 p-2.5">
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-0.5 size-4" checked={selected.includes(update.id)}
                    onChange={(event) => { setSelected((current) => event.target.checked ? [...current, update.id] : current.filter((id) => id !== update.id)); if (!event.target.checked) setConfirmed((current) => current.filter((id) => id !== update.id)); }} />
                  <span className="min-w-0"><span className="text-sm font-medium" dir="auto">{r.kind[update.kind]}: {update.name}</span>{update.detail && <span className="block text-sm text-slate-800" dir="auto">{update.detail}</span>}
                    <span className="block text-xs text-slate-700" dir="auto">{r.said(update.source.quote)}</span></span>
                </label>
                {update.kind === "allergy" && selected.includes(update.id) && (
                  <label className="ms-6 mt-1.5 flex items-start gap-2 text-xs text-slate-800">
                    <input type="checkbox" className="mt-0.5 size-3.5" checked={confirmed.includes(update.id)} onChange={(event) => setConfirmed((current) => event.target.checked ? [...current, update.id] : current.filter((id) => id !== update.id))} />
                    {r.confirmAllergy}
                  </label>
                )}
              </div>
            ))}
          </fieldset>
        ) : <p className="text-sm text-slate-700">{r.nothingNew}</p>}
        {measurements.length > 0 && <p className="text-xs text-slate-700" dir="auto">{r.measurements(measurements.map((update) => `${update.name} ${update.detail ?? ""}`.trim()).join("; "))}</p>}
        {known.length > 0 && <p className="text-xs text-slate-700" dir="auto">{r.alreadyIn(known.map((update) => update.name).join(", "))}</p>}
      </Card>

      {session.writes.length > 0 && (
        <Card aria-label={r.resultTitle}>
          <CardHeader level={3} title={r.resultTitle} />
          <ul className="divide-y divide-slate-200">
            {session.writes.map((write) => <WriteRow key={write.itemKey} write={write} label={write.item === "note" ? r.visitNote : `${r.resource[write.resourceType] ?? write.resourceType}: ${note.proposedUpdates.find((update) => update.id === write.item)?.name ?? ""}`} />)}
          </ul>
          {session.writes.some((write) => write.status === "failed") && canApprove && session.approval && (
            <div className="mt-2"><Button busy={busy} busyLabel={r.trying} onClick={() => void run(() => scribeApi.approve(session.id, session.approval!.noteVersion, session.approval!.selection))}>{r.retryFailed}</Button>
              <p className="mt-1 text-xs text-slate-700">{r.notRewritten}</p></div>
          )}
        </Card>
      )}

      {open && (
        <Card className="space-y-2">
          {canApprove ? (
            <>
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 size-4" checked={writeNote} onChange={(event) => setWriteNote(event.target.checked)} />{r.writeNoteCheck}</label>
              <div className="flex flex-wrap gap-2">
                <Button variant="success" disabled={busy || !!editing} onClick={() => setConfirming(true)}>{r.approveWrite}</Button>
                <Button variant="ghost" onClick={onDiscard}>{r.discardVisit}</Button>
              </div>
              {editing && <p className="text-xs text-slate-700">{r.saveFirst}</p>}
            </>
          ) : <p role="status" className="text-sm text-slate-700">{r.mustApprove}</p>}
        </Card>
      )}
      {error && <Alert tone="danger">{error}</Alert>}

      <Card aria-label={r.transcript} className="space-y-2">
        <CardHeader level={3} title={r.transcript} description={session.transcriptDeleted ? undefined : r.transcriptDesc(formatDate(session.transcriptExpiresAt, locale))}
          actions={open && session.segments.some((segment) => segment.speaker) ? <Button size="sm" disabled={busy} onClick={() => void swapSpeakers()}>{r.swap}</Button> : undefined} />
        {session.transcriptDeleted ? <p className="text-sm text-slate-700">{r.transcriptDeleted}</p> : (
          <ol className="space-y-1.5">
            {session.segments.map((segment) => {
              const marked = focus?.segmentId === segment.id;
              return (
                <li key={segment.id} id={`segment-${session.id}-${segment.id}`} className={`rounded px-1.5 py-1 text-sm ${marked ? "bg-sky-100 outline outline-sky-600" : ""}`}>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                    <span>{segment.id.slice(1)} · {clock(segment.startMs)}</span>
                    {open ? (
                      <SegmentedControl label={r.speakerOf(segment.id.slice(1))} disabled={busy} value={segment.speaker ?? "other"}
                        options={[{ value: "clinician", label: r.speaker.clinician }, { value: "patient", label: r.speaker.patient }, { value: "other", label: r.speakerNotSet }]}
                        onChange={(value) => void run(() => scribeApi.relabel(session.id, [{ id: segment.id, speaker: value === "other" ? null : value }]))} />
                    ) : segment.speaker && <span>{r.speaker[segment.speaker]}</span>}
                  </div>
                  <p dir="auto" className="break-words">{segment.text}</p>
                  {marked && focus?.quote && <p dir="auto" className="mt-0.5 text-xs text-sky-900">{r.quoted(focus.quote)}</p>}
                </li>
              );
            })}
          </ol>
        )}
      </Card>

      <ConfirmDialog open={confirming} onClose={() => setConfirming(false)} title={r.confirmTitle} confirmLabel={r.confirmLabel} variant="success" busy={busy} error={error || undefined}
        canConfirm={writeNote || chosen.length > 0}
        onConfirm={() => void run(() => scribeApi.approve(session.id, session.noteVersion, { note: writeNote, updates: selected, confirmedAllergies: confirmed.filter((id) => selected.includes(id)) }), r.approvedToast).then((ok) => { if (ok) setConfirming(false); })}>
        <p className="font-medium">{r.confirmIntro}</p>
        <ul className="list-disc space-y-1 ps-5 text-slate-800">
          {writeNote && <li>{r.noteItem}</li>}
          {chosen.map((update) => (
            <li key={update.id} dir="auto">{r.kind[update.kind]}: <span className="font-medium">{update.name}</span>{update.detail ? `, ${update.detail}` : ""}
              {update.kind === "allergy" && <> ({confirmed.includes(update.id) ? r.confirmedByYou : r.unconfirmed})</>}</li>
          ))}
          {!writeNote && chosen.length === 0 && <li>{r.nothingSelected}</li>}
        </ul>
        <p className="font-medium">{r.doesNotHappen}</p>
        <ul className="list-disc space-y-0.5 ps-5 text-slate-800">
          {r.notHappenBullets.map((line) => <li key={line}>{line}</li>)}
        </ul>
        <p className="text-xs text-slate-700">{r.finalNote}</p>
      </ConfirmDialog>
    </section>
  );
}
