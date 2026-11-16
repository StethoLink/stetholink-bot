"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SpecialistIdentity, SpecialistRequestSummary, SpecialistRequestView } from "@/shared/contracts";
import { specialistIdentitySchema, specialistRequestListSchema, specialistRequestViewSchema } from "@/shared/schemas";
import { Alert, Badge, Button, Card, CardHeader, ConfirmDialog, EmptyState, Skeleton, ToastProvider, useToast, type Tone } from "@/apps/embedded-app/components/ui";
import { call, DeliveryError } from "@/apps/embedded-app/features/consultations/hooks/deliveryState";
import { parseReferralText } from "@/shared/utils/referral-text";
import { useT } from "@/apps/embedded-app/i18n/client";
import { formatDateTime } from "@/apps/embedded-app/i18n/format";

const api = {
  identity: () => call(specialistIdentitySchema, "/api/specialist/session"),
  list: () => call(specialistRequestListSchema, "/api/specialist/requests"),
  get: (id: string) => call(specialistRequestViewSchema, `/api/specialist/requests/${encodeURIComponent(id)}`),
  respond: (id: string, body: object) => call(specialistRequestViewSchema, `/api/specialist/requests/${encodeURIComponent(id)}/response`, body),
};
const TONE: Record<string, Tone> = { sent: "warning", accepted: "primary", responded: "success", rejected: "neutral" };
const message = (e: unknown, fallback: string) => e instanceof DeliveryError ? e.message : fallback;

function RequestDetail({ id, onBack, onChanged }: { id: string; onBack(): void; onChanged(): void }) {
  const notify = useToast();
  const { t, locale } = useT();
  const i = t.work.inbox;
  const when = (iso: string) => formatDateTime(iso, locale);
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
  useEffect(() => { let active = true; api.get(id).then((value) => active && setView(value)).catch((e) => active && setError(message(e, i.openError))); return () => { active = false; }; }, [id, i.openError]);
  async function reply(body: object, done: string) {
    setBusy(true);
    setError("");
    try {
      setView(await api.respond(id, { ...body, idempotencyKey: key.current }));
      key.current = crypto.randomUUID();
      setMode(undefined); setConfirming(false); notify(done); onChanged();
    } catch (e) { setError(message(e, i.replyError)); setConfirming(false); }
    finally { setBusy(false); }
  }
  if (!view) return <Card>{error ? <Alert tone="danger" action={<Button size="sm" onClick={onBack}>{i.back}</Button>}>{error}</Alert> : <Skeleton label={i.loadingRequest} lines={5} />}</Card>;
  const parsed = parseReferralText(view.summary);
  const report = view.responses.findLast((response) => response.kind === "report")?.report;
  const lines = recommendations.split("\n").map((line) => line.trim()).filter(Boolean);
  return (
    <section aria-label={i.aria} className="space-y-3">
      <Button variant="ghost" size="sm" onClick={onBack}>{i.back}</Button>
      <Card className="space-y-3">
        <CardHeader title={i.requestTitle(view.specialty)} description={i.received(when(view.sentAt))}
          actions={<Badge tone={TONE[view.status] ?? "neutral"} dot>{i.status[view.status] ?? view.status}</Badge>} />
        <Alert tone="info">{i.noPatient}</Alert>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {parsed.header.map((line) => <div key={line.label} className="contents"><dt className="font-medium text-slate-800" dir="auto">{line.label}</dt><dd className="break-words" dir="auto">{line.value}</dd></div>)}
        </dl>
        {parsed.sections.map((section) => (
          <section key={section.title}>
            <h3 className="section-title">{t.work.draft.sectionTitles[section.title] ?? section.title}</h3>
            {section.statements.length ? <ul className="list-disc ps-5 text-sm">{section.statements.map((statement, index) => <li key={index} className="break-words" dir="auto">{statement.text}</li>)}</ul>
              : <p className="text-sm text-slate-700">{t.work.draft.nothingIncluded}</p>}
          </section>
        ))}
        {view.assessment && (
          <Alert tone="warning" title={i.missingTitle}>
            <ul className="list-disc ps-5">{view.assessment.split("\n").filter((line) => line.trim().startsWith("-")).map((line, index) => <li key={index} className="break-words" dir="auto">{line.replace(/^\s*-\s*/, "").replace(/\s*\[[^\]]*\]\s*$/, "")}</li>)}</ul>
            <p className="mt-1 text-xs">{i.missingNote}</p>
          </Alert>
        )}
      </Card>

      {view.responses.filter((response) => response.kind === "rejected").map((response, index) => <Alert key={index} tone="info" title={i.declinedTitle}><span dir="auto">{response.reason}</span></Alert>)}
      {report && (
        <Card aria-label={i.yourReply}><CardHeader level={3} title={i.yourReply} description={i.sentBy(report.responder)} />
          <p className="text-sm whitespace-pre-wrap" dir="auto">{report.summary}</p>
          {report.recommendations.length > 0 && <ul className="mt-1 list-disc ps-5 text-sm">{report.recommendations.map((item, index) => <li key={index} dir="auto">{item}</li>)}</ul>}
        </Card>
      )}

      {(view.canAccept || view.canDecline || view.canReport) && (
        <Card className="space-y-3" aria-label={i.replyTitle}>
          <CardHeader level={3} title={i.replyTitle} description={i.replyDesc} />
          {!mode && (
            <div className="flex flex-wrap gap-2">
              {view.canAccept && <Button variant="primary" busy={busy} onClick={() => void reply({ kind: "accepted" }, i.acceptedToast)}>{i.accept}</Button>}
              {view.canReport && <Button variant="primary" onClick={() => setMode("report")}>{i.writeReply}</Button>}
              {view.canDecline && <Button onClick={() => setMode("decline")}>{i.decline}</Button>}
            </div>
          )}
          {mode === "decline" && (
            <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); setConfirming(true); }}>
              <label className="field-label" htmlFor="decline-reason">{i.declineReason}</label>
              <textarea id="decline-reason" className="field" rows={3} maxLength={2000} required minLength={3} value={reason} onChange={(event) => setReason(event.target.value)} dir="auto" />
              <div className="flex gap-2"><Button type="submit" variant="danger" disabled={reason.trim().length < 3}>{i.declineButton}</Button><Button onClick={() => setMode(undefined)}>{t.common.cancel}</Button></div>
            </form>
          )}
          {mode === "report" && (
            <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); setConfirming(true); }}>
              <label className="field-label" htmlFor="report-summary">{i.summaryLabel}</label>
              <textarea id="report-summary" className="field" rows={5} maxLength={8000} required minLength={3} value={summary} onChange={(event) => setSummary(event.target.value)} dir="auto" />
              <label className="field-label" htmlFor="report-recommendations">{i.recommendationsLabel}</label>
              <textarea id="report-recommendations" className="field" rows={4} value={recommendations} onChange={(event) => setRecommendations(event.target.value)} dir="auto" />
              <div className="flex gap-2"><Button type="submit" variant="primary" disabled={summary.trim().length < 3 || lines.length > 20}>{i.reviewSend}</Button><Button onClick={() => setMode(undefined)}>{t.common.cancel}</Button></div>
            </form>
          )}
        </Card>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <ConfirmDialog open={confirming} onClose={() => setConfirming(false)} busy={busy} variant={mode === "decline" ? "danger" : "primary"}
        title={mode === "decline" ? i.declineTitle : i.sendTitle} confirmLabel={mode === "decline" ? i.declineConfirm : i.sendConfirm}
        onConfirm={() => void (mode === "decline" ? reply({ kind: "rejected", reason: reason.trim() }, i.declinedToast) : reply({ kind: "report", summary: summary.trim(), recommendations: lines }, i.sentToast))}>
        {mode === "decline"
          ? <><p>{i.declineBody}</p><p className="rounded-md border border-slate-200 bg-slate-50 p-2" dir="auto">{reason}</p><p className="text-xs text-slate-700">{i.declineFinal}</p></>
          : <><p>{i.sendBody}</p>
              <p className="rounded-md border border-slate-200 bg-slate-50 p-2 whitespace-pre-wrap" dir="auto">{summary}</p>
              {lines.length > 0 && <ul className="list-disc ps-5">{lines.map((line, index) => <li key={index} dir="auto">{line}</li>)}</ul>}
              <p className="text-xs text-slate-700">{i.sendFinal}</p></>}
      </ConfirmDialog>
    </section>
  );
}

function Inbox() {
  const { t, locale } = useT();
  const i = t.work.inbox;
  const [identity, setIdentity] = useState<SpecialistIdentity>();
  const [items, setItems] = useState<SpecialistRequestSummary[]>();
  const [open, setOpen] = useState<string>();
  const [error, setError] = useState("");
  const load = useCallback(() => { api.list().then(setItems).catch((e) => setError(message(e, i.loadError))); }, [i.loadError]);
  useEffect(() => { api.identity().then(setIdentity).catch(() => undefined); load(); }, [load]);
  return (
    <div className="flex min-h-dvh w-full flex-col">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white shadow-xs">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-2 px-3 py-2">
          <div><h1 className="text-[0.9375rem] font-semibold">{i.inboxTitle}</h1>{identity && <p className="text-xs text-slate-700" dir="auto">{identity.service} · {identity.displayName}</p>}</div>
          <Badge tone="neutral">{i.noIdentifiers}</Badge>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 space-y-3 px-3 py-3">
        {error && <Alert tone="danger">{error}</Alert>}
        {open ? <RequestDetail key={open} id={open} onBack={() => { setOpen(undefined); load(); }} onChanged={load} /> : (
          <Card aria-label={i.requestsTitle}>
            <CardHeader title={i.requestsTitle} actions={<Button size="sm" onClick={load}>{i.refresh}</Button>} />
            {items === undefined ? <Skeleton label={i.loadingRequests} lines={3} /> : items.length === 0 ? <EmptyState title={i.noRequests}>{i.noRequestsText}</EmptyState> : (
              <ul className="divide-y divide-slate-200">
                {items.map((item) => (
                  <li key={item.requestId}>
                    <button type="button" onClick={() => setOpen(item.requestId)} className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-1 py-2 text-start text-sm hover:bg-slate-50">
                      <span className="font-medium" dir="auto">{item.specialty}</span>
                      <Badge tone={TONE[item.status] ?? "neutral"} dot>{i.status[item.status] ?? item.status}</Badge>
                      <span className="ms-auto text-xs text-slate-700">{formatDateTime(item.sentAt, locale)}</span>
                      <span className="w-full text-xs text-slate-700 break-words" dir="auto">{item.question}</span>
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
  const { t } = useT();
  const i = t.work.inbox;
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function post(url: string, body: object) {
    const response = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error?.message ?? i.requestFailed);
  }
  async function run(action: () => Promise<void>) { setBusy(true); setError(""); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : i.requestFailed); } finally { setBusy(false); } }
  return (
    <main className="mx-auto w-full max-w-md space-y-3 p-4">
      <h1 className="text-base font-semibold">{i.inboxTitle}</h1>
      <Alert tone="info" title={i.signInAlertTitle}>{i.signInAlert}</Alert>
      {emailEnabled && (
        <Card className="space-y-2">
          <CardHeader level={3} title={i.codeTitle} description={i.codeDesc} />
          <label className="field-label" htmlFor="specialist-email">{i.emailLabel}</label>
          <input id="specialist-email" type="email" autoComplete="email" dir="ltr" className="field" value={email} onChange={(event) => setEmail(event.target.value)} />
          {!sent ? <Button variant="primary" busy={busy} disabled={!email.includes("@")} onClick={() => void run(async () => { await post("/api/specialist/login", { email }); setSent(true); })}>{i.sendCode}</Button> : (
            <>
              <p className="text-sm text-slate-700">{i.codeSent}</p>
              <label className="field-label" htmlFor="specialist-code">{i.codeLabel}</label>
              <input id="specialist-code" className="field" dir="ltr" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} />
              <Button variant="primary" busy={busy} disabled={code.trim().length < 10} onClick={() => void run(async () => { await post("/api/specialist/session", { email, code }); window.location.reload(); })}>{i.signIn}</Button>
            </>
          )}
          {error && <Alert tone="danger">{error}</Alert>}
        </Card>
      )}
    </main>
  );
}
