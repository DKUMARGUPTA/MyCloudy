"use client";

import { useEffect, useState } from "react";
import { Inbox, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { fetchMyReports, type MyBugReport } from "./api";
import { useI18n } from "@/components/providers/locale-provider";
import type { Locale } from "@/i18n";
import { getTool } from "@/lib/tools/registry";
import { cn } from "@/lib/utils";

/**
 * "My reports" (signed-in only) — bug reports the account submitted, with
 * a status chip per report (new=amber, confirmed=rose, in_progress=teal,
 * fixed=emerald, wontfix=muted — brand rule: no blue/indigo) and a severity
 * dot. Status labels reuse the admin.bugs.status.* catalog keys.
 */

const STATUS_CLASSES: Record<string, string> = {
  new: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  confirmed: "bg-rose-500/15 text-rose-700 dark:text-rose-400",
  in_progress: "bg-teal-500/15 text-teal-700 dark:text-teal-400",
  fixed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  wontfix: "bg-muted text-muted-foreground",
};

const SEVERITY_DOTS: Record<string, string> = {
  low: "bg-muted-foreground/50",
  medium: "bg-amber-500",
  high: "bg-orange-500",
  critical: "bg-destructive",
};

const KNOWN_STATUSES = Object.keys(STATUS_CLASSES);
const KNOWN_SEVERITIES = ["low", "medium", "high", "critical"];

type LoadState = "loading" | "ready" | "error";

export function MyReports() {
  const { t, locale } = useI18n();
  const [state, setState] = useState<LoadState>("loading");
  const [reports, setReports] = useState<MyBugReport[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  // Async fetch only — state updates ride the promise (no sync setState
  // in the effect body, per house rules). Also refetches whenever the bug
  // form successfully submits (house custom-event pattern).
  useEffect(() => {
    let cancelled = false;
    void fetchMyReports().then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setReports(res.reports);
        setState("ready");
      } else {
        setState("error");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  useEffect(() => {
    const onReported = () => setReloadKey((key) => key + 1);
    window.addEventListener("sidocs:bug-reported", onReported);
    return () => {
      window.removeEventListener("sidocs:bug-reported", onReported);
    };
  }, []);

  const reload = () => {
    setState("loading");
    setReloadKey((key) => key + 1);
  };

  return (
    <section
      aria-labelledby="my-reports-heading"
      className="rounded-card border border-border bg-card"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border p-5 pb-4">
        <h2
          id="my-reports-heading"
          className="flex items-center gap-2 text-base font-semibold text-foreground"
        >
          <Inbox className="size-4 text-primary" aria-hidden="true" />
          {t("account.myReports")}
        </h2>
        {state === "ready" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="rounded-btn text-muted-foreground"
            onClick={reload}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            {t("common.refresh")}
          </Button>
        ) : null}
      </div>

      {state === "loading" ? (
        <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t("common.loading")}
        </div>
      ) : state === "error" ? (
        <div className="flex flex-col items-center gap-3 p-8 text-center">
          <p className="text-sm text-muted-foreground">{t("bugs.error")}</p>
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="rounded-btn"
            onClick={reload}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            {t("common.retry")}
          </Button>
        </div>
      ) : reports.length === 0 ? (
        <div className="flex flex-col items-center gap-2 p-10 text-center">
          <Inbox
            className="size-8 text-muted-foreground/50"
            aria-hidden="true"
          />
          <p className="text-sm text-muted-foreground">
            {t("account.noReports")}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {reports.map((report) => (
            <ReportRow key={report.id} report={report} locale={locale} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ReportRow({ report, locale }: { report: MyBugReport; locale: Locale }) {
  const { t } = useI18n();
  const tool = report.toolId ? getTool(report.toolId) : undefined;
  const date = new Date(report.createdAt).toLocaleDateString(
    locale === "hi" ? "hi-IN" : "en-IN",
    { day: "numeric", month: "short", year: "numeric" }
  );
  const statusLabel = KNOWN_STATUSES.includes(report.status)
    ? t(`admin.bugs.status.${report.status}`)
    : report.status;
  const severityLabel = KNOWN_SEVERITIES.includes(report.severity)
    ? t(`bugs.severity.${report.severity}`)
    : report.severity;

  return (
    <li className="space-y-2 px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-sm font-semibold text-foreground">
          {report.title}
        </p>
        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium",
            STATUS_CLASSES[report.status] ?? STATUS_CLASSES.wontfix
          )}
        >
          {statusLabel}
        </span>
      </div>
      <p className="text-sm leading-relaxed text-muted-foreground">
        {report.message}
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span
            className={cn(
              "size-2 rounded-full",
              SEVERITY_DOTS[report.severity] ?? SEVERITY_DOTS.low
            )}
            aria-hidden="true"
          />
          {severityLabel}
        </span>
        {tool ? <span className="truncate">{tool.name[locale]}</span> : null}
        <span>{date}</span>
      </div>
      {report.adminNote ? (
        <p className="rounded-btn bg-muted px-3 py-2 text-xs text-muted-foreground">
          {report.adminNote}
        </p>
      ) : null}
    </li>
  );
}
