"use client";

import { useEffect, useState } from "react";
import { Bug, Loader2, Wrench } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/doco/empty-state";
import { Modal } from "@/components/doco/modal";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import { bugUpdate, fetchBugs, type AdminBugDto } from "@/lib/admin-client";
import {
  BUG_STATUSES,
  bugSeverityVariant,
  bugStatusVariant,
  fmtDateTime,
} from "@/components/doco/admin/shared";

const SEVERITIES = ["low", "medium", "high", "critical"] as const;

const STATUS_LABEL_KEY: Record<string, string> = {
  new: "admin.bugs.stNew",
  confirmed: "admin.bugs.stConfirmed",
  in_progress: "admin.bugs.stInProgress",
  fixed: "admin.bugs.stFixed",
  wontfix: "admin.bugs.stWontfix",
};

const SEVERITY_LABEL_KEY: Record<string, string> = {
  low: "admin.bugs.sevLow",
  medium: "admin.bugs.sevMedium",
  high: "admin.bugs.sevHigh",
  critical: "admin.bugs.sevCritical",
};

/**
 * BugsTab — triage queue for bug reports. Status filter chips + expandable
 * cards; the triage modal edits status / severity / internal note.
 */
export function BugsTab({ onChanged }: { onChanged: () => void }) {
  const { t, locale } = useI18n();
  const { toast } = useToast();

  const [filter, setFilter] = useState<string>("");
  const [bugs, setBugs] = useState<AdminBugDto[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  /* Triage modal state. */
  const [editing, setEditing] = useState<AdminBugDto | null>(null);
  const [status, setStatus] = useState("new");
  const [severity, setSeverity] = useState("medium");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void fetchBugs(filter).then((res) => {
      if (!active) return;
      if (res) setBugs(res.reports);
      else {
        setBugs([]);
        toast({ title: t("admin.toast.failed"), variant: "destructive" });
      }
    });
    return () => {
      active = false;
    };
  }, [filter, reloadKey, toast, t]);

  const openTriage = (bug: AdminBugDto) => {
    setEditing(bug);
    setStatus(bug.status);
    setSeverity(bug.severity);
    setNote(bug.adminNote ?? "");
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    const updated = await bugUpdate(editing.id, {
      status,
      severity,
      adminNote: note,
    });
    setSaving(false);
    if (!updated) {
      toast({ title: t("admin.toast.failed"), variant: "destructive" });
      return;
    }
    toast({ title: t("admin.toast.bugSaved") });
    setEditing(null);
    onChanged();
    setReloadKey((k) => k + 1);
  };

  return (
    <div className="space-y-4">
      {/* Status filter chips */}
      <div className="flex flex-wrap gap-2" role="group" aria-label={t("admin.bugs.statusLabel")}>
        <FilterChip
          active={filter === ""}
          onClick={() => {
            setFilter("");
            setBugs(null);
          }}
        >
          {t("admin.bugs.filterAll")}
        </FilterChip>
        {BUG_STATUSES.map((s) => (
          <FilterChip
            key={s}
            active={filter === s}
            onClick={() => {
              setFilter(s);
              setBugs(null);
            }}
          >
            {t(STATUS_LABEL_KEY[s])}
          </FilterChip>
        ))}
      </div>

      {/* List */}
      {bugs === null ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-card" />
          ))}
        </div>
      ) : bugs && bugs.length > 0 ? (
        <ul className="space-y-3">
          {bugs.map((bug) => (
            <li
              key={bug.id}
              className="rounded-card border border-border bg-surface p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-foreground">{bug.title}</p>
                  <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
                    {bug.message}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="touch"
                  className="shrink-0 rounded-btn"
                  onClick={() => openTriage(bug)}
                >
                  <Wrench className="size-4" aria-hidden="true" />
                  {t("admin.bugs.open")}
                </Button>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Badge variant={bugStatusVariant(bug.status)} className="rounded-chip">
                  {t(STATUS_LABEL_KEY[bug.status] ?? "admin.bugs.stNew")}
                </Badge>
                <Badge variant={bugSeverityVariant(bug.severity)} className="rounded-chip">
                  {t(SEVERITY_LABEL_KEY[bug.severity] ?? "admin.bugs.sevMedium")}
                </Badge>
                {bug.toolId ? (
                  <Badge variant="outline" className="rounded-chip">
                    {bug.toolId}
                  </Badge>
                ) : null}
                <span className="ml-auto">{fmtDateTime(bug.createdAt, locale)}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon={<Bug />} title={t("admin.bugs.empty")} />
      )}

      {/* Triage modal */}
      <Modal
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={editing?.title ?? ""}
        description={
          editing
            ? `${t("admin.bugs.reporter")}: ${editing.email} · ${fmtDateTime(editing.createdAt, locale)}`
            : undefined
        }
        contentClassName="sm:max-w-lg"
        footer={
          <>
            <Button
              type="button"
              variant="outline"
              size="touch"
              className="rounded-btn"
              onClick={() => setEditing(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              size="touch"
              className="rounded-btn"
              onClick={() => void save()}
              disabled={saving}
            >
              {saving ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {saving ? t("admin.bugs.saving") : t("admin.bugs.save")}
            </Button>
          </>
        }
      >
        {editing ? (
          <div className="space-y-4">
            <ScrollArea className="max-h-40 rounded-btn border border-border bg-muted/30 px-3 py-2">
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {editing.message}
              </p>
            </ScrollArea>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="bug-status">{t("admin.bugs.statusLabel")}</Label>
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger id="bug-status" className="h-11 w-full rounded-btn">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BUG_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {t(STATUS_LABEL_KEY[s])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="bug-severity">{t("admin.bugs.severityLabel")}</Label>
                <Select value={severity} onValueChange={setSeverity}>
                  <SelectTrigger id="bug-severity" className="h-11 w-full rounded-btn">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SEVERITIES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {t(SEVERITY_LABEL_KEY[s])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="bug-note">{t("admin.bugs.adminNoteLabel")}</Label>
              <Textarea
                id="bug-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t("admin.bugs.adminNotePlaceholder")}
                className="min-h-20 rounded-btn"
                maxLength={2000}
              />
            </div>

            {editing.toolId || editing.browserInfo ? (
              <dl className="space-y-1 rounded-btn border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                {editing.toolId ? (
                  <div className="flex gap-2">
                    <dt className="font-medium">{t("admin.bugs.tool")}:</dt>
                    <dd>{editing.toolId}</dd>
                  </div>
                ) : null}
                {editing.browserInfo ? (
                  <div className="flex gap-2">
                    <dt className="font-medium">{t("admin.bugs.browser")}:</dt>
                    <dd className="truncate">{editing.browserInfo}</dd>
                  </div>
                ) : null}
              </dl>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
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
      className={
        active
          ? "min-h-9 rounded-chip border border-primary/30 bg-primary/10 px-3 text-sm font-medium text-primary outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50"
          : "min-h-9 rounded-chip border border-border bg-background px-3 text-sm font-medium text-muted-foreground outline-none transition-colors hover:border-primary/25 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      }
    >
      {children}
    </button>
  );
}
