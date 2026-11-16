"use client";
import { useEffect, useState } from "react";
import { useT } from "@/apps/embedded-app/i18n/client";
import { Button } from "./Button";
import { Skeleton } from "./Skeleton";

/**
 * Shown while a model request runs (usually 15 to 30 seconds): what is happening, how long it
 * has taken, a skeleton of the result and a way to stop waiting.
 */
export function WorkInProgress({ label, steps, onCancel, expectedSeconds = 30 }: { label: string; steps?: readonly string[]; onCancel?: () => void; expectedSeconds?: number }) {
  const { t } = useT();
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const step = steps?.length ? steps[Math.min(steps.length - 1, Math.floor((seconds / expectedSeconds) * steps.length))] : undefined;
  return (
    <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" className="text-sm font-medium text-slate-900">{label}</p>
        <span className="text-xs text-slate-700" aria-hidden="true">{seconds} s</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-slate-200" aria-hidden="true">
        <div className="h-full rounded-full bg-sky-600 transition-[width] duration-1000 ease-linear" style={{ width: `${Math.min(95, (seconds / expectedSeconds) * 100)}%` }} />
      </div>
      {step && <p className="text-xs text-slate-700">{step}</p>}
      <Skeleton label={t.progress.resultHere} lines={3} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-700">{seconds > expectedSeconds ? t.progress.longer : t.progress.usually(expectedSeconds)}</p>
        {onCancel && <Button size="sm" onClick={onCancel}>{t.common.cancel}</Button>}
      </div>
    </div>
  );
}
