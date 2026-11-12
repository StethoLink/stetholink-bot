"use client";

import { useEffect, useState } from "react";

const PROFILES = [
  { id: "chest-pain-demo", label: "Physician · Omar (fictional chest-pain case)" },
  { id: "cardiology-demo", label: "Physician · Ahmed (fictional cardiology case)" },
  { id: "physician", label: "Physician · Test Patient Alpha" },
  { id: "observer", label: "Non-physician observer · Test Patient Alpha" },
];

/**
 * Opens a synthetic chart session for staging. The launch secret is typed or passed in the URL
 * fragment (never sent as a query string), posted once, and not stored in the browser.
 */
export function StagingLaunch() {
  const [secret, setSecret] = useState("");
  const [profile, setProfile] = useState(PROFILES[0].id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const fromFragment = new URLSearchParams(window.location.hash.slice(1)).get("secret");
    if (fromFragment) {
      setSecret(fromFragment);
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  async function launch() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/staging/launch", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ profile }),
      });
      if (!response.ok) throw new Error(response.status === 401 ? "The launch secret was not accepted." : "The synthetic chart could not be opened.");
      window.location.assign("/embed");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The synthetic chart could not be opened.");
      setBusy(false);
    }
  }

  return (
    <form className="space-y-3 rounded-lg border border-slate-200 bg-white p-4" onSubmit={(event) => { event.preventDefault(); void launch(); }}>
      <h1 className="text-lg font-semibold">Synthetic staging launch</h1>
      <p className="text-sm text-slate-700">Opens a fictional chart with a short-lived session. No real patient, clinician or hospital is involved.</p>
      <label className="block text-sm font-medium">Synthetic chart and role
        <select value={profile} onChange={(event) => setProfile(event.target.value)} disabled={busy}
          className="mt-1 block w-full rounded border border-slate-400 px-2 py-1 font-normal">
          {PROFILES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
      <label className="block text-sm font-medium">Launch secret
        <input type="password" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)} disabled={busy}
          className="mt-1 block w-full rounded border border-slate-400 px-2 py-1 font-normal" />
      </label>
      <button type="submit" disabled={busy || secret.length < 32}
        className="rounded border border-sky-900 bg-sky-800 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
        {busy ? "Opening…" : "Open synthetic chart"}
      </button>
      {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
    </form>
  );
}
