"use client";

import { useEffect, useState } from "react";

interface Delivery {
  recipientId: string;
  status: "submitted" | "responded";
  response?: string;
}

export function ConsultationDelivery({ draftId, recipientId, version, canSend }: {
  draftId: string; recipientId: string; version: number; canSend: boolean;
}) {
  const [delivery, setDelivery] = useState<Delivery>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const url = `/api/consultations/drafts/${encodeURIComponent(draftId)}/delivery`;

  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("Delivery status unavailable");
      const saved = await response.json() as Delivery | null;
      if (saved && !controller.signal.aborted) setDelivery(saved);
    }).catch(() => {
      if (!controller.signal.aborted) setError("Delivery status is unavailable.");
    });
    return () => controller.abort();
  }, [url]);

  async function send() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipientId, expectedVersion: version, idempotencyKey: `send:${version}:${draftId}` }),
      });
      if (!response.ok) throw new Error("Delivery failed");
      setDelivery(await response.json() as Delivery);
    } catch {
      setError("Delivery failed. Verify the approved recipient and retry.");
    } finally {
      setBusy(false);
    }
  }

  return <section aria-label="Route approved consultation" className="space-y-2">
    {delivery ? (
      <p role="status">Recipient {delivery.recipientId} · {delivery.status}. {delivery.response}</p>
    ) : canSend && (
      <>
        <p>Approved destination {recipientId}</p>
        <button type="button" disabled={busy} onClick={() => void send()}
          className="rounded border px-3 py-2">Send approved consultation</button>
      </>
    )}
    {error && <p role="alert">{error}</p>}
  </section>;
}
