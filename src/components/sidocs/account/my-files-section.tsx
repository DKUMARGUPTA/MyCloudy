"use client";

import { useEffect, useSyncExternalStore } from "react";
import { FileText, HardDrive, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/providers/locale-provider";
import type { Locale } from "@/i18n";
import { getTool } from "@/lib/tools/registry";
import {
  ensureRecentFiles,
  formatBytes,
  getRecentFilesSnapshot,
  removeRecentFile,
  subscribeRecentFiles,
  type RecentFileEntry,
} from "@/lib/storage/recent-files";

/**
 * "My files" (account view) — read-only re-use of the device-only recent
 * files store (IndexedDB; PRD §6.1). Shows name / date / size with a
 * per-entry remove action; the filesPrivacy caption states the honest
 * brand promise: entries never leave the device, account or not.
 */

const EMPTY: RecentFileEntry[] = [];

export function MyFilesSection() {
  const { t, locale } = useI18n();
  const entries = useSyncExternalStore(
    subscribeRecentFiles,
    getRecentFilesSnapshot,
    () => EMPTY
  );

  // Initial async load from IndexedDB (emitChange notifies the store).
  useEffect(() => {
    void ensureRecentFiles().catch(() => undefined);
  }, []);

  return (
    <section
      aria-labelledby="my-files-heading"
      className="rounded-card border border-border bg-card"
    >
      <div className="border-b border-border p-5 pb-4">
        <h2
          id="my-files-heading"
          className="flex items-center gap-2 text-base font-semibold text-foreground"
        >
          <HardDrive className="size-4 text-primary" aria-hidden="true" />
          {t("account.myFiles")}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("account.filesPrivacy")}
        </p>
      </div>

      {entries.length === 0 ? (
        <div className="flex flex-col items-center gap-2 p-10 text-center">
          <FileText
            className="size-8 text-muted-foreground/50"
            aria-hidden="true"
          />
          <p className="text-sm text-muted-foreground">
            {t("account.filesEmpty")}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {entries.map((entry) => (
            <MyFileRow key={entry.id} entry={entry} locale={locale} />
          ))}
        </ul>
      )}
    </section>
  );
}

function MyFileRow({
  entry,
  locale,
}: {
  entry: RecentFileEntry;
  locale: Locale;
}) {
  const { t } = useI18n();
  const tool = entry.toolId ? getTool(entry.toolId) : undefined;
  const date = new Date(entry.addedAt).toLocaleDateString(
    locale === "hi" ? "hi-IN" : "en-IN",
    { day: "numeric", month: "short", year: "numeric" }
  );

  return (
    <li className="flex items-center gap-3 px-5 py-3">
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
        aria-hidden="true"
      >
        <FileText className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground" title={entry.label}>
          {entry.label}
        </p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {date} · {formatBytes(entry.size)}
          {tool ? ` · ${tool.name[locale]}` : ""}
        </p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-9 shrink-0 rounded-btn text-muted-foreground hover:text-destructive"
        aria-label={`${t("account.removeFile")}: ${entry.label}`}
        onClick={() => {
          void removeRecentFile(entry.id).catch(() => undefined);
        }}
      >
        <Trash2 className="size-4" aria-hidden="true" />
      </Button>
    </li>
  );
}
