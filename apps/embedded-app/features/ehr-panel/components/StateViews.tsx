"use client";
import type { ApiErrorCode } from "@/shared/contracts";
import { Alert, Button, DataBadge, Skeleton } from "@/apps/embedded-app/components/ui";
import { useT } from "@/apps/embedded-app/i18n/client";

export function SkeletonBlock({ label, lines = 3 }: { label: string; lines?: number }) {
  return <Skeleton label={label} lines={lines} />;
}

/** The reference an administrator matches to one server log line. Selectable in one press, read left to right. */
export function ErrorReference({ reference }: { reference?: string }) {
  const { t } = useT();
  if (!reference) return null;
  return <p className="mt-1 text-xs">{t.common.reference}: <code dir="ltr" className="font-semibold select-all">{reference}</code></p>;
}

/**
 * What went wrong, and the one thing to do about it. In English the server's own explanation is shown;
 * in Arabic the explanation for its error code, because the server writes English.
 */
export function ErrorWithRetry({ message, code, reference, onRetry }: { message: string; code?: ApiErrorCode; reference?: string; onRetry: () => void }) {
  const { t, locale } = useT();
  return (
    <Alert tone="danger" action={<Button size="sm" onClick={onRetry}>{t.common.retry}</Button>}>
      {locale !== "en" && code ? t.errors[code] : message}
      <ErrorReference reference={reference} />
    </Alert>
  );
}

export function SyntheticBadge() {
  return <DataBadge classification="synthetic" />;
}

/** Shown on every chart of a tenant configured for real patients. */
export function LiveBadge() {
  return <DataBadge classification="live" />;
}
