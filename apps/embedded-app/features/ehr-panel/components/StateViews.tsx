import { Alert, Button, DataBadge, Skeleton } from "@/apps/embedded-app/components/ui";

export function SkeletonBlock({ label, lines = 3 }: { label: string; lines?: number }) {
  return <Skeleton label={label} lines={lines} />;
}

/** What went wrong, and the one thing to do about it. */
export function ErrorWithRetry({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <Alert tone="danger" action={<Button size="sm" onClick={onRetry}>Retry</Button>}>{message}</Alert>;
}

export function SyntheticBadge() {
  return <DataBadge classification="synthetic" />;
}

/** Shown on every chart of a tenant configured for real patients. */
export function LiveBadge() {
  return <DataBadge classification="live" />;
}
