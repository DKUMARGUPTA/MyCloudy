"use client";

import { useEffect, useState } from "react";
import { Inbox, RotateCw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/sidocs/empty-state";
import { useI18n } from "@/components/providers/locale-provider";
import type { Locale } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * P12 admin console — shared bits used by every module (task 12-c):
 * module props contract, load-state type, error/empty/skeleton blocks,
 * a debounce hook and date helpers.
 */

/** Props every admin module receives from the console shell. */
export interface AdminModuleProps {
  /** Bumped by the console Refresh button — modules refetch when it changes. */
  refreshToken: number;
  /** Called when any API call answers 403 (role revoked mid-session). */
  onForbidden: () => void;
}

/** Local fetch state for the module pattern (setState only in .then/.catch). */
export interface AdminLoad<T> {
  data: T | null;
  error: string | null;
}

/** True while neither data nor an error has arrived (first load only). */
export function isAdminLoading<T>(load: AdminLoad<T>): boolean {
  return load.data === null && load.error === null;
}

/** i18n error text for an API error code (unknown codes → server_error). */
export function adminErrorText(
  t: (key: string) => string,
  code: string
): string {
  const known =
    code === "bad_request" ||
    code === "not_found" ||
    code === "rate_limited" ||
    code === "server_error";
  return t(known ? `auth.err.${code}` : "auth.err.server_error");
}

/** Inline error card with a retry button (network/5xx states). */
export function AdminErrorCard({
  code,
  onRetry,
}: {
  code: string;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="rounded-card border bg-card p-8 text-center shadow-sm">
      <div
        className="mx-auto flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive"
        aria-hidden="true"
      >
        <TriangleAlert className="size-6" />
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        {adminErrorText(t, code)}
      </p>
      <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
        <RotateCw className="size-4" aria-hidden="true" />
        {t("common.retry")}
      </Button>
    </div>
  );
}

/** Empty list state. */
export function AdminEmpty() {
  const { t } = useI18n();
  return (
    <EmptyState
      icon={<Inbox aria-hidden="true" />}
      title={t("common.none")}
    />
  );
}

/** Row/list skeleton block with a polite loading label. */
export function AdminRowsSkeleton({
  rows = 5,
  rowClassName,
}: {
  rows?: number;
  rowClassName?: string;
}) {
  const { t } = useI18n();
  return (
    <div role="status" aria-label={t("common.loading")} className="space-y-3">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton
          key={index}
          className={cn("w-full rounded-xl", rowClassName ?? "h-16")}
        />
      ))}
    </div>
  );
}

/**
 * Debounce a changing value (search boxes). The state update happens in
 * the timer callback, never synchronously inside the effect.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

const dateLocales: Record<Locale, string> = { en: "en-IN", hi: "hi-IN" };

/** Short date for table cells (e.g. 12 Mar 2026). Invalid input → raw. */
export function formatAdminDate(iso: string, locale: Locale): string {
  // Date-only strings ("2026-03-12") parse as UTC midnight — anchor them to
  // local midnight so the displayed day never shifts by a timezone.
  const value = iso.length === 10 ? `${iso}T00:00` : iso;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(dateLocales[locale], {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

/** Short date + time for audit rows. Invalid input → raw. */
export function formatAdminDateTime(iso: string, locale: Locale): string {
  const value = iso.length === 10 ? `${iso}T00:00` : iso;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(dateLocales[locale], {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
