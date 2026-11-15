export function Skeleton({ label, lines = 3 }: { label: string; lines?: number }) {
  return (
    <div aria-busy="true" role="status" className="space-y-2">
      <span className="sr-only">{label}</span>
      {Array.from({ length: lines }, (_, index) => <div key={index} className="skeleton h-3.5" style={{ width: `${92 - index * 14}%` }} />)}
    </div>
  );
}
