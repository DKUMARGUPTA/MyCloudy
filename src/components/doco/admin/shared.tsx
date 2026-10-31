"use client";

import type { LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Admin folder shared bits — small formatting + badge helpers. */

export function fmtDateTime(iso: string, locale: string): string {
  try {
    return new Date(iso).toLocaleString(locale === "hi" ? "hi-IN" : "en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso.slice(0, 16).replace("T", " ");
  }
}

export function fmtDate(iso: string, locale: string): string {
  try {
    return new Date(iso).toLocaleDateString(locale === "hi" ? "hi-IN" : "en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

/* Bug status → badge variant + label key. */
export const BUG_STATUSES = [
  "new",
  "confirmed",
  "in_progress",
  "fixed",
  "wontfix",
] as const;

export function bugStatusVariant(status: string): "new" | "beta" | "secondary" | "private" | "outline" {
  switch (status) {
    case "new":
      return "new";
    case "confirmed":
      return "beta";
    case "in_progress":
      return "secondary";
    case "fixed":
      return "private";
    default:
      return "outline";
  }
}

export function bugSeverityVariant(severity: string): "default" | "destructive" | "secondary" | "outline" {
  switch (severity) {
    case "critical":
      return "destructive";
    case "high":
      return "default";
    case "medium":
      return "secondary";
    default:
      return "outline";
  }
}

/** Small stat card used on the overview tab. */
export function StatCard({
  label,
  value,
  icon: Icon,
  tone = "primary",
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  tone?: "primary" | "accent" | "success" | "muted";
}) {
  const tones: Record<string, string> = {
    primary: "border-primary/20 bg-primary/5 text-primary",
    accent: "border-cat-optimize/25 bg-cat-optimize/10 text-cat-optimize",
    success: "border-success/30 bg-success/10 text-success",
    muted: "border-border bg-muted/50 text-muted-foreground",
  };
  return (
    <div className="rounded-card border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-full border",
            tones[tone]
          )}
          aria-hidden="true"
        >
          <Icon className="size-4" />
        </span>
      </div>
      <p className="mt-2 text-2xl font-bold tabular-nums tracking-tight text-foreground">
        {value}
      </p>
    </div>
  );
}

/** Status chip reused by messages/bugs/users rows. */
export function StatusBadge({
  variant,
  children,
}: {
  variant?: "default" | "secondary" | "destructive" | "outline" | "new" | "private" | "beta";
  children: React.ReactNode;
}) {
  return (
    <Badge variant={variant ?? "secondary"} className="rounded-chip">
      {children}
    </Badge>
  );
}
