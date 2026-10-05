"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Clock, FileText, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/components/providers/locale-provider";
import { ROUTES, navigateToHash } from "@/hooks/use-hash-route";
import { getTool } from "@/lib/tools/registry";
import {
  clearRecentFiles,
  ensureRecentFiles,
  formatBytes,
  getRecentFilesSnapshot,
  subscribeRecentFiles,
  type RecentFileEntry,
} from "@/lib/storage/recent-files";

/**
 * Recent files strip (PRD §6.1): local metadata + thumbnails only, with a
 * "Clear" button; the whole section is hidden when empty ("empty state
 * hidden"). Clicking an entry opens the tool it was used with — file
 * contents are never kept, so the user re-selects the file (privacy by
 * design; a toast explains this honestly).
 */

const EMPTY: RecentFileEntry[] = [];

function useObjectUrl(blob: Blob | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    // State updates ride the microtask queue (never synchronous in the
    // effect body), and the cleanup revokes whatever URL was created.
    void Promise.resolve()
      .then(() => {
        if (cancelled) return null;
        if (!blob) {
          setUrl(null);
          return null;
        }
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
        return null;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [blob]);
  return url;
}

function relativeDays(addedAt: number, locale: string): string {
  const days = Math.max(
    0,
    Math.floor((Date.now() - addedAt) / (24 * 60 * 60 * 1000))
  );
  const fmt = new Intl.RelativeTimeFormat(locale === "hi" ? "hi" : "en", {
    numeric: "auto",
  });
  return fmt.format(-days, "day");
}

function RecentItemCard({
  entry,
  onOpen,
}: {
  entry: RecentFileEntry;
  onOpen: (entry: RecentFileEntry) => void;
}) {
  const { locale } = useI18n();
  const url = useObjectUrl(entry.thumbnail);
  const tool = entry.toolId ? getTool(entry.toolId) : undefined;

  return (
    <button
      type="button"
      onClick={() => onOpen(entry)}
      className="flex w-36 shrink-0 flex-col gap-2 rounded-card border border-border bg-card p-3 text-left outline-none transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <div className="flex h-24 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/40">
        {url ? (
          <img
            src={url}
            alt=""
            loading="lazy"
            decoding="async"
            className="size-full object-contain"
          />
        ) : (
          <FileText className="size-8 text-muted-foreground/60" aria-hidden="true" />
        )}
      </div>
      <div className="min-w-0">
        <p className="truncate text-xs font-semibold text-foreground" title={entry.label}>
          {entry.label}
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {formatBytes(entry.size)} · {relativeDays(entry.addedAt, locale)}
        </p>
        {tool ? (
          <p className="mt-0.5 truncate text-[11px] text-primary">
            {tool.name[locale]}
          </p>
        ) : null}
      </div>
    </button>
  );
}

export function RecentFiles() {
  const { t } = useI18n();
  const { toast } = useToast();
  const entries = useSyncExternalStore(
    subscribeRecentFiles,
    getRecentFilesSnapshot,
    () => EMPTY
  );

  // Initial async load from IndexedDB (emitChange notifies the store).
  useEffect(() => {
    void ensureRecentFiles().catch(() => undefined);
  }, []);

  const visible = useMemo(() => entries.slice(0, 8), [entries]);

  const openEntry = (entry: RecentFileEntry) => {
    if (entry.toolId && getTool(entry.toolId)?.enabled) {
      navigateToHash(ROUTES.tool(entry.toolId));
      toast({ title: t("recent.reselectToast") });
      return;
    }
    navigateToHash(ROUTES.tools);
    toast({ title: t("recent.reselectToast") });
  };

  if (visible.length === 0) return null;

  return (
    <section
      id="recent"
      aria-labelledby="recent-heading"
      className="mx-auto w-full max-w-6xl px-4 py-10"
    >
      <div className="flex items-center justify-between gap-3">
        <h2
          id="recent-heading"
          className="flex items-center gap-2 text-lg font-semibold text-foreground"
        >
          <Clock className="size-4 text-primary" aria-hidden="true" />
          {t("recent.title")}
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="rounded-btn text-muted-foreground hover:text-destructive"
          onClick={() => {
            void clearRecentFiles().catch(() => undefined);
            toast({ title: t("recent.clearedToast") });
          }}
        >
          <Trash2 className="size-4" aria-hidden="true" />
          {t("recent.clear")}
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{t("recent.note")}</p>
      <ul className="scrollbar-thin -mx-1 mt-4 flex gap-3 overflow-x-auto px-1 pb-2">
        {visible.map((entry) => (
          <li key={entry.id}>
            <RecentItemCard entry={entry} onOpen={openEntry} />
          </li>
        ))}
      </ul>
    </section>
  );
}
