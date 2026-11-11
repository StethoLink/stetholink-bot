"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ConsultationDeliveryView } from "@/shared/contracts";
import { awaitingProvider, deliveryApi, DeliveryError, describeDelivery, type EligibleProvider } from "../hooks/deliveryState";

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const button = "rounded border border-slate-700 px-3 py-2 text-sm font-medium disabled:opacity-50";

/** Provider choice, delivery state and the specialist's reply for an approved consultation. */
export function ConsultationDelivery({ draftId, onChanged }: { draftId: string; onChanged?: () => void }) {
  const [view, setView] = useState<ConsultationDeliveryView | null>();
  const [providers, setProviders] = useState<EligibleProvider[]>([]);
  const [providerId, setProviderId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // One key per send intent: a retry after a network failure cannot create a second request.
  const sendKey = useRef<string | undefined>(undefined);
  const lastVersion = useRef<number | undefined>(undefined);

  const apply = useCallback((next: ConsultationDeliveryView | null) => {
    setView(next);
    if (next && lastVersion.current !== undefined && lastVersion.current !== next.version) onChanged?.();
    lastVersion.current = next?.version;
  }, [onChanged]);

  const refresh = useCallback(async () => {
    try {
      apply(await deliveryApi.view(draftId));
      setError("");
    } catch (e) {
      setError(e instanceof DeliveryError ? e.message : "Delivery status is unavailable.");
    }
  }, [apply, draftId]);

  useEffect(() => {
    void refresh();
    void deliveryApi.providers(draftId).then((list) => {
      setProviders(list);
      setProviderId((current) => current || list[0]?.id || "");
    }).catch(() => setProviders([]));
  }, [draftId, refresh]);

  const waiting = awaitingProvider(view);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [waiting, refresh]);

  async function run(action: () => Promise<ConsultationDeliveryView>) {
    setBusy(true);
    setError("");
    try {
      apply(await action());
      sendKey.current = undefined;
    } catch (e) {
      setError(e instanceof DeliveryError ? e.message : "The action failed. Try again.");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  if (view === undefined) return <p className="text-sm text-slate-700" aria-busy="true">Loading delivery status…</p>;
  if (view === null) return <p className="text-sm text-slate-700" role="status">Delivery is not available in this environment (no durable storage configured).</p>;

  const { state, problem } = describeDelivery(view);
  const target = view.canRetry ? view.provider?.id ?? "" : providerId;
  const send = () => run(() => deliveryApi.send(draftId, {
    providerId: target, expectedVersion: view.version, idempotencyKey: sendKey.current ??= crypto.randomUUID(),
  }));

  return (
    <section aria-label="Routing and specialist response" className="space-y-3 rounded border border-slate-300 p-3">
      <h3 className="text-sm font-semibold">Routing and specialist response</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="font-medium">Delivery state</dt>
        <dd role="status">{state}</dd>
        <dt className="font-medium">Recipient</dt>
        <dd>{view.provider ? `${view.provider.displayName} (${view.provider.id})` : "Not chosen yet"}</dd>
      </dl>

      {problem && <p role="alert" className="rounded border border-red-700 bg-red-50 p-2 text-sm text-red-800">{problem}</p>}

      {view.canSend && (
        providers.length ? (
          <div className="space-y-2">
            <label className="block text-sm font-medium">Eligible provider
              <select value={providerId} onChange={(event) => setProviderId(event.target.value)} disabled={busy}
                className="mt-1 block w-full rounded border border-slate-400 px-2 py-1 font-normal">
                {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.displayName}</option>)}
              </select>
            </label>
            <button type="button" className={button} disabled={busy || !target} onClick={() => void send()}>
              {busy ? "Sending…" : "Send approved consultation"}
            </button>
          </div>
        ) : (
          <p role="alert" className="text-sm text-red-800">
            No allowed provider offers the requested specialty, so this consultation cannot be sent.
          </p>
        )
      )}
      {view.canRetry && (
        <button type="button" className={button} disabled={busy || !target} onClick={() => void send()}>
          {busy ? "Retrying…" : "Retry delivery to the same provider"}
        </button>
      )}

      {view.attempts.length > 0 && (
        <div>
          <h4 className="text-sm font-medium">Request history</h4>
          <ol className="text-sm">
            {[...view.attempts].reverse().map((attempt) => (
              <li key={attempt.requestId}>
                Attempt {attempt.number}: {attempt.status} · {when(attempt.updatedAt)} · request {attempt.requestId.slice(0, 8)}
              </li>
            ))}
          </ol>
        </div>
      )}

      {view.responses.filter((response) => response.kind === "rejected").map((response) => (
        <p key={response.responseId} className="text-sm">Provider declined: {response.reason ?? "no reason given"}</p>
      ))}

      {view.report?.report && (
        <article aria-label="Specialist response" className="space-y-2 rounded border border-emerald-700 bg-emerald-50 p-3 text-sm">
          <h4 className="font-semibold">Specialist response</h4>
          <p className="text-xs text-slate-700">
            From {view.report.report.responder} via {view.provider?.displayName ?? view.report.providerId} · received {when(view.report.receivedAt)}
          </p>
          <p className="whitespace-pre-wrap">{view.report.report.summary}</p>
          {view.report.report.recommendations.length > 0 && (
            <ul className="list-disc pl-5">
              {view.report.report.recommendations.map((item, index) => <li key={index}>{item}</li>)}
            </ul>
          )}
        </article>
      )}

      <div className="flex flex-wrap gap-2">
        {view.canSimulate && (
          <button type="button" className={button} disabled={busy} onClick={() => void run(() => deliveryApi.simulate(draftId))}>
            Simulate specialist reply (synthetic demo)
          </button>
        )}
        {view.attempts.length > 0 && (
          <button type="button" className={button} disabled={busy} onClick={() => void refresh()}>Refresh status</button>
        )}
      </div>
      {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
    </section>
  );
}
