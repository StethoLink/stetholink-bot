"use client";

import { useEffect, useState } from "react";

interface Delivery {
  recipientId: string;
  status: "submitted" | "responded";
  response?: string;
}

export function ConsultationDelivery({ draftId }: { draftId: string }) {
  const [recipient, setRecipient] = useState("");
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
        body: JSON.stringify({ recipientId: recipient }),
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
    ) : (
      <>
        <label className="block">Approved recipient ID
          <input value={recipient} onChange={(event) => setRecipient(event.target.value)}
            className="block rounded border px-2 py-1" />
        </label>
        <button type="button" disabled={busy || !recipient.trim()} onClick={() => void send()}
          className="rounded border px-3 py-2">Send approved consultation</button>
      </>
    )}
    {error && <p role="alert">{error}</p>}
  </section>;
}
