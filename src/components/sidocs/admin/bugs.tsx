"use client";

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/components/providers/locale-provider";
import { cn } from "@/lib/utils";
import { getTool } from "@/lib/tools/registry";
import {
  adminErrorCode,
  fetchAdminBugs,
  patchAdminBug,
  type AdminBugReport,
  type AdminBugSeverity,
  type AdminBugStatus,
} from "./admin-api";
import {
  adminErrorText,
  AdminEmpty,
  AdminErrorCard,
  AdminModuleProps,
  AdminRowsSkeleton,
  formatAdminDate,
  isAdminLoading,
  type AdminLoad,
} from "./admin-shared";

/**
 * Bug reports (#/admin/bugs): status filter chips, expandable report cards
 * with severity dots, status select → PATCH, admin note saved on blur.
 */

const BUG_STATUSES: readonly AdminBugStatus[] = [
  "new",
  "confirmed",
  "in_progress",
  "fixed",
  "wontfix",
];

const SEVERITY_DOT: Record<AdminBugSeverity, string> = {
  low: "bg-muted-foreground/50",
  medium: "bg-amber-500",
  high: "bg-orange-500",
  critical: "bg-rose-500",
};

export function BugsPanel({ refreshToken, onForbidden }: AdminModuleProps) {
  const { t, locale } = useI18n();
  const { toast } = useToast();

  const [statusFilter, setStatusFilter] = useState<string>("");
  const [load, setLoad] = useState<AdminLoad<AdminBugReport[]>>({
    data: null,
    error: null,
  });
  const [reloadKey, setReloadKey] = useState(0);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    fetchAdminBugs(statusFilter, controller.signal)
      .then((data) => {
        if (active) setLoad({ data: data.reports, error: null });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const code = adminErrorCode(error);
        if (code === "forbidden") onForbidden();
        else setLoad({ data: null, error: code });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [statusFilter, refreshToken, reloadKey, onForbidden]);

  function replaceReport(next: AdminBugReport): void {
    setLoad((prev) =>
      prev.data
        ? {
            data: prev.data.map((report) =>
              report.id === next.id ? next : report
            ),
            error: null,
          }
        : prev
    );
  }

  function categoryLabel(category: string): string {
    const key = `bugs.category.${category}`;
    const translated = t(key);
    return translated === key ? category : translated;
  }

  async function changeStatus(
    report: AdminBugReport,
    status: AdminBugStatus
  ): Promise<void> {
    setBusyId(report.id);
    try {
      const { report: updated } = await patchAdminBug(report.id, { status });
      replaceReport(updated);
      toast({ title: t("admin.bugs.updated") });
    } catch (error: unknown) {
      const code = adminErrorCode(error);
      if (code === "forbidden") onForbidden();
      else toast({ title: adminErrorText(t, code), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  async function saveNote(report: AdminBugReport): Promise<void> {
    const note = notes[report.id] ?? report.adminNote ?? "";
    if (note === (report.adminNote ?? "")) return;
    setBusyId(report.id);
    try {
      const { report: updated } = await patchAdminBug(report.id, {
        adminNote: note,
      });
      replaceReport(updated);
      toast({ title: t("admin.bugs.updated") });
    } catch (error: unknown) {
      const code = adminErrorCode(error);
      if (code === "forbidden") onForbidden();
      else toast({ title: adminErrorText(t, code), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  if (load.error !== null) {
    return (
      <AdminErrorCard
        code={load.error}
        onRetry={() => setReloadKey((key) => key + 1)}
      />
    );
  }

  return (
    <section>
      <h2 className="text-lg font-semibold tracking-tight">
        {t("admin.nav.bugs")}
      </h2>

      {/* Status filter chips */}
      <div
        className="scrollbar-thin -mx-1 mt-4 flex gap-1.5 overflow-x-auto px-1 pb-1"
        role="group"
        aria-label={t("admin.users.status")}
      >
        <FilterChip active={statusFilter === ""} onClick={() => setStatusFilter("")}>
          {t("tools.chipAll")}
        </FilterChip>
        {BUG_STATUSES.map((status) => (
          <FilterChip
            key={status}
            active={statusFilter === status}
            onClick={() => setStatusFilter(status)}
          >
            {t(`admin.bugs.status.${status}`)}
          </FilterChip>
        ))}
      </div>

      <div className="mt-4">
        {isAdminLoading(load) ? (
          <AdminRowsSkeleton rows={4} />
        ) : (load.data?.length ?? 0) === 0 ? (
          <AdminEmpty />
        ) : (
          <ul className="space-y-3">
            {(load.data ?? []).map((report) => (
              <li key={report.id}>
                <BugCard
                  report={report}
                  noteValue={notes[report.id] ?? report.adminNote ?? ""}
                  busy={busyId === report.id}
                  onNoteChange={(value) =>
                    setNotes((prev) => ({ ...prev, [report.id]: value }))
                  }
                  onNoteBlur={() => void saveNote(report)}
                  onStatusChange={(status) => void changeStatus(report, status)}
                  categoryLabel={categoryLabel}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex shrink-0 items-center whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
        active
          ? "border-primary/30 bg-primary/10 text-primary"
          : "border-border bg-background text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function BugCard({
  report,
  noteValue,
  busy,
  onNoteChange,
  onNoteBlur,
  onStatusChange,
  categoryLabel,
}: {
  report: AdminBugReport;
  noteValue: string;
  busy: boolean;
  onNoteChange: (value: string) => void;
  onNoteBlur: () => void;
  onStatusChange: (status: AdminBugStatus) => void;
  categoryLabel: (category: string) => string;
}) {
  const { t, locale } = useI18n();
  const tool = report.toolId ? getTool(report.toolId) : undefined;

  return (
    <Card className="gap-0 rounded-xl py-0">
      <Collapsible defaultOpen={report.status === "new"}>
        <div className="flex items-start justify-between gap-3 p-4">
          <CollapsibleTrigger className="group flex min-w-0 flex-1 items-start gap-2.5 text-left">
            <ChevronDown
              className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
              aria-hidden="true"
            />
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    SEVERITY_DOT[report.severity]
                  )}
                  role="img"
                  aria-label={t(`bugs.severity.${report.severity}`)}
                />
                <span className="text-sm font-medium">{report.title}</span>
                <Badge
                  variant="secondary"
                  className="font-normal text-muted-foreground"
                >
                  {categoryLabel(report.category)}
                </Badge>
              </span>
              <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <span>
                  {t("admin.bugs.reporter")}: {report.email ?? "—"}
                </span>
                <span aria-hidden="true">·</span>
                <span>{formatAdminDate(report.updatedAt, locale)}</span>
              </span>
            </span>
          </CollapsibleTrigger>
          <div className="flex shrink-0 flex-col items-end gap-2">
            {report.toolId ? (
              <Badge variant="secondary" className="font-mono font-normal">
                {tool ? tool.name[locale] : report.toolId}
              </Badge>
            ) : null}
            <Select
              value={report.status}
              onValueChange={(value) => onStatusChange(value as AdminBugStatus)}
              disabled={busy}
            >
              <SelectTrigger
                size="sm"
                className="w-36"
                aria-label={t("admin.users.status")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BUG_STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>
                    {t(`admin.bugs.status.${status}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <CollapsibleContent>
          <div className="space-y-3 border-t px-4 py-4">
            <p className="whitespace-pre-wrap text-sm">{report.message}</p>
            {report.browserInfo ? (
              <p className="break-all font-mono text-xs text-muted-foreground">
                {report.browserInfo}
              </p>
            ) : null}
            <div>
              <label
                htmlFor={`bug-note-${report.id}`}
                className="text-xs font-medium text-muted-foreground"
              >
                {t("admin.bugs.note")}
              </label>
              <Textarea
                id={`bug-note-${report.id}`}
                className="mt-1 min-h-14 text-sm"
                value={noteValue}
                disabled={busy}
                onChange={(event) => onNoteChange(event.target.value)}
                onBlur={onNoteBlur}
              />
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
