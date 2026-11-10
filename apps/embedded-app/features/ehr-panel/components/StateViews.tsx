export function SkeletonBlock({ label, lines = 3 }: { label: string; lines?: number }) {
  return (
    <div aria-busy="true" className="space-y-2">
      <span className="sr-only">{label}</span>
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className="h-4 animate-pulse rounded bg-slate-200 motion-reduce:animate-none"
          style={{ width: `${90 - i * 15}%` }}
        />
      ))}
    </div>
  );
}

export function ErrorWithRetry({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="space-y-2 text-sm text-red-800">
      <p>{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded border border-current bg-white px-3 py-1 font-medium focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-sky-700"
      >
        Retry
      </button>
    </div>
  );
}

export function SyntheticBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-amber-800 bg-amber-50 px-1.5 py-0.5 text-xs font-semibold text-amber-900">
      <span aria-hidden="true">⚑</span>
      Synthetic data
    </span>
  );
}
