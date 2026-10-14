"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ExternalLink,
  FileSearch,
  Loader2,
  LockKeyhole,
  SearchX,
  TriangleAlert,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/providers/locale-provider";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { PDF_DOC_PARAMS, loadPdfjs } from "@/lib/pdf/pdfjs";
import { DropZone } from "@/components/doco/tool/drop-zone";
import { formatBytes } from "@/lib/storage/recent-files";
import { ROUTES, navigateToHash } from "@/hooks/use-hash-route";
import { setChainHandoff } from "@/lib/tools/chain";
import { PreviewFileHeader } from "../stamp-common/preview-parts";
import {
  buildMatcher,
  findMatches,
  joinPageText,
  makeSnippet,
  MAX_PREVIEW_MATCHES,
  resolveSearchOptions,
  type RawTextItem,
  type Snippet,
} from "./engine";

/**
 * Search PDFs surface (PRD §8.5) — the interactive live preview of "jump
 * to each match's page" (v1). A read-only on-device probe (main-thread
 * pdf.js, the unlock-pdf pattern) extracts the FIRST file's per-page text
 * once, caches it (Map ref, read inside callbacks only), and every option
 * change re-runs the SAME pure matcher the worker uses — debounced 300ms.
 * Each match card offers "Open page N in viewer", which hands the file to
 * the view-pdf tool via the standard chain handoff.
 *
 * The run (worker) remains the authority: it searches EVERY file and
 * writes the full report.
 */

/** Search input debounce (ms). */
const SEARCH_DEBOUNCE_MS = 300;
/** Extracted-text cache bound (beyond it, the oldest file is evicted). */
const TEXT_CACHE_MAX = 8;

interface PreviewMatch {
  page: number;
  snippet: Snippet;
}

type ExtractStatus = "working" | "ready" | "encrypted" | "error";

interface ExtractState {
  file: File;
  status: ExtractStatus;
  pageCount: number;
}

export function SearchSurface({
  files,
  values,
  setFileOrder,
  setRunBlocked,
  addFiles,
}: ToolSurfaceProps): React.JSX.Element | null {
  const { t } = useI18n();
  const fileMeta = files[0];
  const file = fileMeta?.file ?? null;
  const { query, mode, caseSensitive, wholeWord, context } =
    resolveSearchOptions(values);

  const [extract, setExtract] = useState<ExtractState | null>(null);
  const [matches, setMatches] = useState<PreviewMatch[] | null>(null);
  const [totalFound, setTotalFound] = useState(0);

  /** Per-file page texts — written/read inside callbacks only, never render. */
  const textCacheRef = useRef<Map<File, string[]>>(new Map());

  /* ---------------- text extraction (read-only probe) ---------------- */

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void (async () => {
      // Reset on a microtask — never synchronously in the effect body.
      await Promise.resolve();
      if (cancelled) return;
      setExtract({ file, status: "working", pageCount: 0 });

      const cached = textCacheRef.current.get(file);
      if (cached !== undefined) {
        setExtract({ file, status: "ready", pageCount: cached.length });
        return;
      }

      const pdfjs = await loadPdfjs();
      const data = new Uint8Array(await file.arrayBuffer());
      const doc = await pdfjs.getDocument({ data, ...PDF_DOC_PARAMS })
        .promise;
      if (cancelled) {
        void doc.destroy().catch(() => undefined);
        return;
      }
      const texts: string[] = [];
      try {
        for (let page = 1; page <= doc.numPages; page += 1) {
          if (cancelled) return;
          const pdfPage = await doc.getPage(page);
          const content = await pdfPage.getTextContent();
          pdfPage.cleanup();
          texts.push(joinPageText(content.items as RawTextItem[]));
        }
      } finally {
        await doc.destroy().catch(() => undefined);
      }
      if (cancelled) return;
      const cache = textCacheRef.current;
      cache.set(file, texts);
      if (cache.size > TEXT_CACHE_MAX) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      setExtract({ file, status: "ready", pageCount: texts.length });
    })().catch((cause: unknown) => {
      if (cancelled) return;
      const name =
        cause !== null && typeof cause === "object" && "name" in cause
          ? String((cause as { name: unknown }).name)
          : "";
      setExtract({
        file,
        status: name === "PasswordException" ? "encrypted" : "error",
        pageCount: 0,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const activeExtract =
    extract !== null && extract.file === file ? extract : null;
  const extractStatus: ExtractStatus | "none-yet" =
    activeExtract?.status ?? "none-yet";
  const textsReady = extractStatus === "ready";

  /* ---------------- run gating (CTA, PRD safety) ---------------- */

  let regexInvalid = false;
  if (mode === "regex" && query.trim() !== "") {
    try {
      buildMatcher(query, { mode, caseSensitive, wholeWord });
    } catch {
      regexInvalid = true;
    }
  }
  const queryReady = query.trim() !== "";
  const blockedKey = !file
    ? null
    : !queryReady
      ? "search.errorEmptyQuery"
      : regexInvalid
        ? "search.errorBadRegex"
        : null;
  useEffect(() => {
    setRunBlocked(blockedKey);
    return () => setRunBlocked(null);
  }, [blockedKey, setRunBlocked]);

  /* ---------------- debounced live search ---------------- */

  useEffect(() => {
    if (!file || !textsReady || !queryReady || regexInvalid) {
      let cancelled = false;
      void Promise.resolve().then(() => {
        if (!cancelled) {
          setMatches(null);
          setTotalFound(0);
        }
      });
      return () => {
        cancelled = true;
      };
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      const texts = textCacheRef.current.get(file) ?? [];
      const matcher = (() => {
        try {
          return buildMatcher(query, { mode, caseSensitive, wholeWord });
        } catch {
          return null; // gated above; a race here just means no preview
        }
      })();
      if (matcher === null) return;
      const found: PreviewMatch[] = [];
      let total = 0;
      for (let page = 1; page <= texts.length; page += 1) {
        const pageText = texts[page - 1];
        for (const match of findMatches(pageText, matcher)) {
          total += 1; // true count keeps running past the preview cap
          if (found.length < MAX_PREVIEW_MATCHES) {
            found.push({
              page,
              snippet: makeSnippet(pageText, match, context),
            });
          }
        }
      }
      setMatches(found);
      setTotalFound(total);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    file,
    query,
    mode,
    caseSensitive,
    wholeWord,
    context,
    textsReady,
    queryReady,
    regexInvalid,
  ]);

  /* ---------------- viewer handoff (jump to the match) ---------------- */

  const openInViewer = useCallback((): void => {
    const first = files[0];
    if (!first) return;
    // Hand ONLY the previewed file (the viewer is single-file).
    setChainHandoff({
      fromToolId: "search-pdf",
      items: [{ id: first.id, file: first.file }],
    });
    navigateToHash(ROUTES.tool("view-pdf"));
  }, [files]);

  /* ---------------- file list actions ---------------- */

  const removeFirst = useCallback((): void => {
    setFileOrder(files.slice(1));
  }, [files, setFileOrder]);

  const removeFile = useCallback(
    (id: string): void => {
      setFileOrder(files.filter((item) => item.id !== id));
    },
    [files, setFileOrder]
  );

  if (!file) return null;

  const showMatches =
    textsReady && queryReady && !regexInvalid && matches !== null;
  const showPrompt = textsReady && !queryReady;
  const showNoMatches = showMatches && matches.length === 0;

  return (
    <section
      aria-label={t("search.surfaceLabel")}
      className="flex flex-col gap-3"
    >
      {/* File header (page count arrives from the probe) */}
      <PreviewFileHeader
        file={file}
        pageCount={activeExtract?.pageCount ?? 0}
        onRemove={removeFirst}
      />

      {/* Other files as chips (the preview searches the first file only) */}
      {files.length > 1 ? (
        <ul
          className="flex flex-wrap gap-2"
          aria-label={t("search.otherFiles")}
        >
          {files.slice(1).map((item) => (
            <li key={item.id}>
              <span className="flex max-w-[240px] items-center gap-1.5 rounded-chip border border-border bg-card px-2.5 py-1 text-xs text-foreground">
                <span className="truncate" title={item.file.name}>
                  {item.file.name}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {formatBytes(item.file.size)}
                </span>
                <button
                  type="button"
                  onClick={() => removeFile(item.id)}
                  aria-label={t("tool.removeFileLabel", { name: item.file.name })}
                  className="flex size-8 shrink-0 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Probe status (aria-live: results appear progressively) */}
      <div aria-live="polite">
        {extractStatus === "working" || extractStatus === "none-yet" ? (
          <p
            role="status"
            className="flex items-center gap-2 rounded-card border border-border bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground"
          >
            <Loader2
              className="size-3.5 shrink-0 animate-spin"
              aria-hidden="true"
            />
            {t("search.reading")}
          </p>
        ) : extractStatus === "encrypted" ? (
          <p className="flex items-start gap-2 rounded-card border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
            <LockKeyhole className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {t("search.probeEncrypted")}
          </p>
        ) : extractStatus === "error" ? (
          <p className="flex items-start gap-2 rounded-card border border-border bg-muted/40 px-4 py-2.5 text-xs leading-relaxed text-muted-foreground">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {t("search.probeError")}
          </p>
        ) : null}
      </div>

      {/* Regex validity echo (run is gated) */}
      {textsReady && regexInvalid ? (
        <p className="flex items-start gap-2 rounded-card border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {t("search.regexInvalid")}
        </p>
      ) : null}

      {/* Prompt: nothing typed yet */}
      {showPrompt ? (
        <p className="flex items-start gap-2 rounded-card border border-dashed border-border bg-muted/30 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          <FileSearch className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {t("search.typeQuery")}
        </p>
      ) : null}

      {/* Match count chip */}
      {showMatches && matches.length > 0 ? (
        <p className="flex w-fit items-center gap-1.5 rounded-chip bg-cat-view/10 px-2.5 py-1 text-[11px] font-semibold text-cat-view">
          <FileSearch className="size-3.5" aria-hidden="true" />
          {t("search.matchCount", { count: totalFound })}
        </p>
      ) : null}

      {/* Empty result */}
      {showNoMatches ? (
        <p className="flex items-center gap-2 rounded-card border border-border bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground">
          <SearchX className="size-3.5 shrink-0" aria-hidden="true" />
          {t("search.noMatches")}
        </p>
      ) : null}

      {/* Match cards */}
      {showMatches && matches.length > 0 ? (
        <ul
          className="flex max-h-96 flex-col gap-2 overflow-y-auto scrollbar-thin pr-1"
          aria-label={t("search.resultsLabel")}
        >
          {matches.map((match, index) => (
            <MatchCard
              key={`${match.page}-${index}`}
              page={match.page}
              snippet={match.snippet}
              onOpen={openInViewer}
            />
          ))}
        </ul>
      ) : null}

      {/* Honest cap note */}
      {showMatches && totalFound > matches.length ? (
        <p className="text-xs text-muted-foreground">
          {t("search.moreMatches", { count: matches.length })}
        </p>
      ) : null}

      {/* Honest scope note */}
      <p className="text-xs text-muted-foreground">
        {t("search.firstFileNote")}
      </p>

      {/* Add more (compact) — same shell pipeline as the landing drop */}
      <DropZone
        labelKey="tool.addMoreFiles"
        multiple
        maxFiles={20}
        acceptKind="pdf"
        onAccept={addFiles}
        currentCount={files.length}
        className="py-2"
      />
    </section>
  );
}

export default SearchSurface;

/* ------------------------------ card ------------------------------ */

function MatchCard({
  page,
  snippet,
  onOpen,
}: {
  page: number;
  snippet: Snippet;
  onOpen: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const openLabel = t("search.openPage", { page });
  return (
    <li className="flex flex-col gap-2 rounded-card border border-border bg-card p-3 transition-colors hover:border-primary/25 sm:flex-row sm:items-start sm:gap-3">
      <span className="flex shrink-0 self-start items-center rounded-chip bg-cat-view/10 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-cat-view">
        {t("search.pageChip", { page })}
      </span>
      <p className="min-w-0 flex-1 break-words text-sm leading-relaxed text-foreground">
        <span className="text-muted-foreground">{snippet.before}</span>
        <mark className="rounded-[2px] bg-primary/15 px-0.5 font-semibold text-foreground">
          {snippet.hit}
        </mark>
        <span className="text-muted-foreground">{snippet.after}</span>
      </p>
      <Button
        type="button"
        variant="outline"
        className="h-11 min-h-11 shrink-0 rounded-btn px-3 text-xs font-medium"
        onClick={onOpen}
        aria-label={openLabel}
      >
        <ExternalLink className="size-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">{openLabel}</span>
      </Button>
    </li>
  );
}
