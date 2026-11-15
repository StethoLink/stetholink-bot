"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SpecialistIdentity, SpecialistRequestSummary, SpecialistRequestView } from "@/shared/contracts";
import { specialistIdentitySchema, specialistRequestListSchema, specialistRequestViewSchema } from "@/shared/schemas";
import { Alert, Badge, Button, Card, CardHeader, ConfirmDialog, EmptyState, Skeleton, ToastProvider, useToast, type Tone } from "@/apps/embedded-app/components/ui";
import { call, DeliveryError } from "@/apps/embedded-app/features/consultations/hooks/deliveryState";
import { parseReferralText } from "@/shared/utils/referral-text";

const api = {
  identity: () => call(specialistIdentitySchema, "/api/specialist/session"),
  list: () => call(specialistRequestListSchema, "/api/specialist/requests"),
  get: (id: string) => call(specialistRequestViewSchema, `/api/specialist/requests/${encodeURIComponent(id)}`),
  respond: (id: string, body: object) => call(specialistRequestViewSchema, `/api/specialist/requests/${encodeURIComponent(id)}/response`, body),
};
const STATUS: Record<string, { text: string; tone: Tone }> = {
  sent: { text: "New", tone: "warning" }, accepted: { text: "Accepted, reply awaited", tone: "primary" }, responded: { text: "Replied", tone: "success" }, rejected: { text: "Declined", tone: "neutral" },
};
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const message = (e: unknown, fallback: string) => e instanceof DeliveryError ? e.message : fallback;

function RequestDetail({ id, onBack, onChanged }: { id: string; onBack(): void; onChanged(): void }) {
  const notify = useToast();
  const [view, setView] = useState<SpecialistRequestView>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"decline" | "report">();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [summary, setSummary] = useState("");
  const [recommendations, setRecommendations] = useState("");
  // One key per reply: pressing twice, or retrying after a dropped connection, records it once.
  const key = useRef(crypto.randomUUID());
  useEffect(() => { let active = true; api.get(id).then((value) => active && setView(value)).catch((e) => active && setError(message(e, "The request could not be opened."))); return () => { active = false; }; }, [id]);
  async function reply(body: object, done: string) {
    setBusy(true);
    setError("");
    try {
      setView(await api.respond(id, { ...body, idempotencyKey: key.current }));
      key.current = crypto.randomUUID();
      setMode(undefined); setConfirming(false); notify(done); onChanged();
    } catch (e) { setError(message(e, "The reply could not be recorded. Try again.")); setConfirming(false); }
    finally { setBusy(false); }
  }
  if (!view) return <Card>{error ? <Alert tone="danger" action={<Button size="sm" onClick={onBack}>Back to the inbox</Button>}>{error}</Alert> : <Skeleton label="Loading the request" lines={5} />}</Card>;
  const parsed = parseReferralText(view.summary);
  const report = view.responses.findLast((response) => response.kind === "report")?.report;
  const lines = recommendations.split("\n").map((line) => line.trim()).filter(Boolean);
  return (
    <section aria-label="Consultation request" className="space-y-3">
      <Button variant="ghost" size="sm" onClick={onBack}>Back to the inbox</Button>
      <Card className="space-y-3">
        <CardHeader title={`${view.specialty} consultation request`} description={`Received ${when(view.sentAt)}. Approved and sent by the treating physician.`}
          actions={<Badge tone={STATUS[view.status]?.tone ?? "neutral"} dot>{STATUS[view.status]?.text ?? view.status}</Badge>} />
        <Alert tone="info">This request identifies no patient: it carries age, sex and the clinical content the physician approved. To see the chart, use your EHR.</Alert>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {parsed.header.map((line) => <div key={line.label} className="contents"><dt className="font-medium text-slate-800">{line.label}</dt><dd className="break-words">{line.value}</dd></div>)}
        </dl>
        {parsed.sections.map((section) => (
          <section key={section.title}>
            <h3 className="section-title">{section.title}</h3>
            {section.statements.length ? <ul className="list-disc ps-5 text-sm">{section.statements.map((statement, index) => <li key={index} className="break-words">{statement.text}</li>)}</ul>
              : <p className="text-sm text-slate-700">Nothing from the chart was included.</p>}
          </section>
        ))}
        {view.assessment && (
          <Alert tone="warning" title="Missing information">
            <ul className="list-disc ps-5">{view.assessment.split("\n").filter((line) => line.trim().startsWith("-")).map((line, index) => <li key={index} className="break-words">{line.replace(/^\s*-\s*/, "").replace(/\s*\[[^\]]*\]\s*$/, "")}</li>)}</ul>
            <p className="mt-1 text-xs">Not available does not mean normal or not done.</p>
          </Alert>
        )}
      </Card>

      {view.responses.filter((response) => response.kind === "rejected").map((response, index) => <Alert key={index} tone="info" title="You declined this request">{response.reason}</Alert>)}
      {report && (
        <Card aria-label="Your reply"><CardHeader level={3} title="Your reply" description={`Sent by ${report.responder}`} />
          <p className="text-sm whitespace-pre-wrap">{report.summary}</p>
          {report.recommendations.length > 0 && <ul className="mt-1 list-disc ps-5 text-sm">{report.recommendations.map((item, index) => <li key={index}>{item}</li>)}</ul>}
        </Card>
      )}

      {(view.canAccept || view.canDecline || view.canReport) && (
        <Card className="space-y-3" aria-label="Reply">
          <CardHeader level={3} title="Reply" description="Your reply goes to the treating physician and is recorded under your name." />
          {!mode && (
            <div className="flex flex-wrap gap-2">
              {view.canAccept && <Button variant="primary" busy={busy} onClick={() => void reply({ kind: "accepted" }, "Accepted. The physician has been told.")}>Accept request</Button>}
              {view.canReport && <Button variant="primary" onClick={() => setMode("report")}>Write reply</Button>}
              {view.canDecline && <Button onClick={() => setMode("decline")}>Decline</Button>}
            </div>
          )}
          {mode === "decline" && (
            <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); setConfirming(true); }}>
              <label className="field-label" htmlFor="decline-reason">Reason for declining</label>
              <textarea id="decline-reason" className="field" rows={3} maxLength={2000} required minLength={3} value={reason} onChange={(event) => setReason(event.target.value)} dir="auto" />
              <div className="flex gap-2"><Button type="submit" variant="danger" disabled={reason.trim().length < 3}>Decline request</Button><Button onClick={() => setMode(undefined)}>Cancel</Button></div>
            </form>
          )}
          {mode === "report" && (
            <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); setConfirming(true); }}>
              <label className="field-label" htmlFor="report-summary">Summary of your opinion</label>
              <textarea id="report-summary" className="field" rows={5} maxLength={8000} required minLength={3} value={summary} onChange={(event) => setSummary(event.target.value)} dir="auto" />
              <label className="field-label" htmlFor="report-recommendations">Recommendations, one per line</label>
              <textarea id="report-recommendations" className="field" rows={4} value={recommendations} onChange={(event) => setRecommendations(event.target.value)} dir="auto" />
              <div className="flex gap-2"><Button type="submit" variant="primary" disabled={summary.trim().length < 3 || lines.length > 20}>Review and send</Button><Button onClick={() => setMode(undefined)}>Cancel</Button></div>
            </form>
          )}
        </Card>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <ConfirmDialog open={confirming} onClose={() => setConfirming(false)} busy={busy} variant={mode === "decline" ? "danger" : "primary"}
        title={mode === "decline" ? "Decline this request?" : "Send this reply?"} confirmLabel={mode === "decline" ? "Decline" : "Send reply"}
        onConfirm={() => void (mode === "decline" ? reply({ kind: "rejected", reason: reason.trim() }, "Declined. The physician has been told.") : reply({ kind: "report", summary: summary.trim(), recommendations: lines }, "Reply sent to the physician."))}>
        {mode === "decline"
          ? <><p>The treating physician is told that your service declined, with this reason:</p><p className="rounded-md border border-slate-200 bg-slate-50 p-2" dir="auto">{reason}</p><p className="text-xs text-slate-700">This closes the request and cannot be undone.</p></>
          : <><p>The treating physician receives this reply under your name, and may add it to the patient&apos;s chart.</p>
              <p className="rounded-md border border-slate-200 bg-slate-50 p-2 whitespace-pre-wrap" dir="auto">{summary}</p>
              {lines.length > 0 && <ul className="list-disc ps-5">{lines.map((line, index) => <li key={index} dir="auto">{line}</li>)}</ul>}
              <p className="text-xs text-slate-700">A sent reply cannot be changed.</p></>}
      </ConfirmDialog>
    </section>
  );
}

function Inbox() {
  const [identity, setIdentity] = useState<SpecialistIdentity>();
  const [items, setItems] = useState<SpecialistRequestSummary[]>();
  const [open, setOpen] = useState<string>();
  const [error, setError] = useState("");
  const load = useCallback(() => { api.list().then(setItems).catch((e) => setError(message(e, "The inbox could not be loaded."))); }, []);
  useEffect(() => { api.identity().then(setIdentity).catch(() => undefined); load(); }, [load]);
  return (
    <div className="flex min-h-dvh w-full flex-col">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white shadow-xs">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-2 px-3 py-2">
          <div><h1 className="text-[0.9375rem] font-semibold">Consultation inbox</h1>{identity && <p className="text-xs text-slate-700">{identity.service} · {identity.displayName}</p>}</div>
          <Badge tone="neutral">No patient identifiers</Badge>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 space-y-3 px-3 py-3">
        {error && <Alert tone="danger">{error}</Alert>}
        {open ? <RequestDetail key={open} id={open} onBack={() => { setOpen(undefined); load(); }} onChanged={load} /> : (
          <Card aria-label="Requests">
            <CardHeader title="Requests for your service" actions={<Button size="sm" onClick={load}>Refresh</Button>} />
            {items === undefined ? <Skeleton label="Loading requests" lines={3} /> : items.length === 0 ? <EmptyState title="No requests">Consultation requests sent to your service appear here.</EmptyState> : (
              <ul className="divide-y divide-slate-200">
                {items.map((item) => (
                  <li key={item.requestId}>
                    <button type="button" onClick={() => setOpen(item.requestId)} className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-1 py-2 text-start text-sm hover:bg-slate-50">
                      <span className="font-medium">{item.specialty}</span>
                      <Badge tone={STATUS[item.status]?.tone ?? "neutral"} dot>{STATUS[item.status]?.text ?? item.status}</Badge>
                      <span className="ms-auto text-xs text-slate-700">{when(item.sentAt)}</span>
                      <span className="w-full text-xs text-slate-700 break-words">{item.question}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </main>
    </div>
  );
}

/** The receiving specialist's side of the plugin: the requests sent to their service, and their reply. */
export function SpecialistInbox() {
  return <ToastProvider><Inbox /></ToastProvider>;
}

/** Sign-in by one-time email code, for a specialist without access to the EHR. */
export function SpecialistSignIn({ emailEnabled }: { emailEnabled: boolean }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function post(url: string, body: object) {
    const response = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error?.message ?? "The request failed. Try again.");
  }
  async function run(action: () => Promise<void>) { setBusy(true); setError(""); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "The request failed. Try again."); } finally { setBusy(false); } }
  return (
    <main className="mx-auto w-full max-w-md space-y-3 p-4">
      <h1 className="text-base font-semibold">Consultation inbox</h1>
      <Alert tone="info" title="Open the inbox from your EHR">If you work in the hospital&apos;s EHR, open StethoLink from its application list. You are signed in with your hospital account.</Alert>
      {emailEnabled && (
        <Card className="space-y-2">
          <CardHeader level={3} title="Sign in with a one-time code" description="For specialists without access to the EHR. The email contains a code and nothing about any patient." />
          <label className="field-label" htmlFor="specialist-email">Your registered email address</label>
          <input id="specialist-email" type="email" autoComplete="email" className="field" value={email} onChange={(event) => setEmail(event.target.value)} />
          {!sent ? <Button variant="primary" busy={busy} disabled={!email.includes("@")} onClick={() => void run(async () => { await post("/api/specialist/login", { email }); setSent(true); })}>Send me a code</Button> : (
            <>
              <p className="text-sm text-slate-700">If the address is registered, a code is on its way. It works once and expires in 10 minutes.</p>
              <label className="field-label" htmlFor="specialist-code">Code</label>
              <input id="specialist-code" className="field" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} />
              <Button variant="primary" busy={busy} disabled={code.trim().length < 10} onClick={() => void run(async () => { await post("/api/specialist/session", { email, code }); window.location.reload(); })}>Sign in</Button>
            </>
          )}
          {error && <Alert tone="danger">{error}</Alert>}
        </Card>
      )}
    </main>
  );
}
