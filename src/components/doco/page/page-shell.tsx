"use client";

import type { LucideIcon } from "lucide-react";
import { ArrowLeft, ShieldCheck } from "lucide-react";

import { cn } from "@/lib/utils";
import { useI18n } from "@/components/providers/locale-provider";
import { useLocalizedRoutes } from "@/hooks/use-hash-route";

/**
 * Shared frame for the Phase 6 static pages (About, Contact, Privacy,
 * Terms): back-to-home breadcrumb, page header, updated chip and a
 * content-width prose container — matches the All-Tools visual language.
 */

export function PageShell({
  icon: Icon,
  badge,
  title,
  lede,
  updated,
  children,
  wide = false,
}: {
  icon: LucideIcon;
  /** Short eyebrow above the title (page kind, not the full title). */
  badge: string;
  title: string;
  lede: string;
  updated?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const { t } = useI18n();
  const routes = useLocalizedRoutes();

  return (
    <div
      className={cn(
        "mx-auto w-full px-4 pb-16 pt-6 sm:pt-8",
        wide ? "max-w-6xl" : "max-w-3xl"
      )}
    >
      <nav aria-label={t("common.a11yBreadcrumb")} className="mb-6">
        <a
          href={routes.home}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-btn text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t("pages.backHome")}
        </a>
      </nav>

      <header className="max-w-2xl">
        <span className="inline-flex items-center gap-2 rounded-chip border border-primary/25 bg-primary/5 px-3 py-1 text-xs font-medium text-primary sm:text-sm">
          <Icon className="size-3.5" aria-hidden="true" />
          {badge}
        </span>
        <h1 className="mt-4 text-2xl font-bold tracking-tight sm:text-3xl">
          {title}
        </h1>
        <p className="mt-3 text-pretty text-muted-foreground">{lede}</p>
        {updated ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {t("pages.updated", { date: updated })}
          </p>
        ) : null}
      </header>

      <div className="mt-10 space-y-10">{children}</div>
    </div>
  );
}

/** Branded section with an icon chip heading. */
export function PageSection({
  icon: Icon,
  title,
  children,
  id,
}: {
  icon?: LucideIcon;
  title: string;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight sm:text-xl">
        {Icon ? (
          <span
            className="flex size-8 shrink-0 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-primary"
            aria-hidden="true"
          >
            <Icon className="size-4" />
          </span>
        ) : null}
        {title}
      </h2>
      <div className="mt-3.5 space-y-3.5">{children}</div>
    </section>
  );
}

/** Green "never happens" callout — the privacy USP block. */
export function PrivacyCallout({
  title,
  body,
}: {
  title: string;
  body: string;
}) {
  return (
    <div className="flex gap-3 rounded-card border border-success/30 bg-success/5 p-4">
      <ShieldCheck
        className="mt-0.5 size-5 shrink-0 text-success"
        aria-hidden="true"
      />
      <div>
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

/** Key/value definition rows (privacy "what we collect" lists). */
export function KeyValueList({
  rows,
}: {
  rows: { label: string; value: string }[];
}) {
  return (
    <dl className="space-y-2.5">
      {rows.map((row) => (
        <div
          key={row.label}
          className="rounded-card border border-border bg-surface px-4 py-3"
        >
          <dt className="text-sm font-semibold">{row.label}</dt>
          <dd className="mt-0.5 text-sm text-muted-foreground">
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
