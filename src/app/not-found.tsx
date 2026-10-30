"use client";

import Link from "next/link";

import { useI18n } from "@/components/providers/locale-provider";

/**
 * Root not-found boundary (R19 audit fix).
 *
 * Next.js serves this for every unmatched path — including unknown /hi/*
 * paths (the /hi catch-all calls notFound()) and unknown tool/category ids.
 * It renders inside the root layout, so LocaleProvider is available and the
 * page follows the visitor's stored locale (hydration-safe: English on first
 * paint, Hindi right after hydration for hi users).
 *
 * Design: self-contained (no AppShell/mega-menu dependency), brand-consistent
 * (teal gradient lockup, theme-aware tokens), minimal JS — plain Links work
 * even before hydration for no-JS visitors and crawlers.
 */
export default function NotFound() {
  const { t } = useI18n();

  return (
    <main
      className="flex min-h-screen flex-col items-center justify-center bg-background px-6 py-16"
      role="main"
    >
      <div className="w-full max-w-md text-center">
        {/* Brand lockup */}
        <Link
          href="/"
          className="inline-flex items-center gap-2.5 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-label="DocoPDF — home"
        >
          <span
            aria-hidden="true"
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-teal-500 to-teal-700 text-lg font-black text-white shadow-sm"
          >
            D
          </span>
          <span className="text-lg font-bold tracking-tight text-foreground">
            DocoPDF
          </span>
        </Link>

        {/* 404 code */}
        <p
          aria-hidden="true"
          className="mt-10 bg-gradient-to-br from-teal-500 to-teal-700 bg-clip-text text-[88px] font-black leading-none tracking-tight text-transparent"
        >
          {t("nf.code")}
        </p>

        <h1 className="mt-4 text-xl font-bold tracking-tight text-foreground sm:text-2xl">
          {t("nf.heading")}
        </h1>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
          {t("nf.desc")}
        </p>

        {/* Actions */}
        <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
          <Link
            href="/"
            className="inline-flex min-h-11 items-center justify-center rounded-xl bg-teal-700 px-6 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-teal-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {t("nf.home")}
          </Link>
          <Link
            href="/tools"
            className="inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-300 bg-transparent px-6 text-sm font-semibold text-foreground transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2 focus-visible:ring-offset-background dark:border-slate-700 dark:hover:bg-slate-900"
          >
            {t("nf.tools")}
          </Link>
        </div>
      </div>
    </main>
  );
}
