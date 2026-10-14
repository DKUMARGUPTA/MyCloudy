"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ClipboardCopy,
  Copy,
  Download,
  Loader2,
  LockKeyhole,
  MousePointerClick,
  ScanText,
  TriangleAlert,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { renderPdfThumbnail } from "@/lib/pdf/thumbnails";
import { formatBytes } from "@/lib/storage/recent-files";
import { DropZone } from "@/components/doco/tool/drop-zone";
import { PreviewFileHeader, PreviewPageStrip } from "../stamp-common/preview-parts";
import {
  type CopyFormat,
  type TextBlock,
  selectionToOutput,
} from "./engine";
import { extractPageBlocks, type ExtractedPage } from "./extract";

/**
 * Copy from PDF surface (PRD §7.1): click paragraphs, lists or headings
 * on the rendered page to select them, then copy straight to the
 * clipboard as plain text, Markdown or CSV — or download the selection.
 *
 * Extraction runs once on load (pdf.js text layer, no rendering of every
 * page — fast even for big files); the page preview renders on demand.
 * The run CTA stays available: it exports the WHOLE file through the
 * worker (with on-device OCR for scanned pages) as .txt / .md.
 */

const PREVIEW_MAX_DIM = 680;

type ExtractStatus = "working" | "ready" | "encrypted" | "error";

interface ExtractState {
  file: File;
  status: ExtractStatus;
  pages: ExtractedPage[];
  truncated: number;
  progress: { page: number; pages: number };
}

function formatMime(format: CopyFormat): string {
  if (format === "markdown") return "text/markdown;charset=utf-8";
  if (format === "csv") return "text/csv;charset=utf-8";
  return "text/plain;charset=utf-8";
}

function formatExt(format: CopyFormat): string {
  if (format === "markdown") return "md";
  if (format === "csv") return "csv";
  return "txt";
}

/** Clipboard with the legacy execCommand fallback (file://, old WebView). */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyFromPdfSurface(
  props: ToolSurfaceProps
): React.JSX.Element | null {
  const { files, setFileOrder, setRunBlocked, addFiles } = props;
  const { t } = useI18n();
  const { toast } = useToast();
  const fileMeta = files[0];
  const file = fileMeta?.file ?? null;

  const [extract, setExtract] = useState<ExtractState | null>(null);
  const [selectedPage, setSelectedPage] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [format, setFormat] = useState<CopyFormat>("text");
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [renderFailed, setRenderFailed] = useState(false);
  const extractToken = useRef(0);

  /* ---------------- block extraction (once per file) ---------------- */

  useEffect(() => {
    if (!file) return;
    const token = extractToken.current + 1;
    extractToken.current = token;
    let cancelled = false;
    void (async () => {
      // Reset on a microtask — never synchronously in the effect body.
      await Promise.resolve();
      if (cancelled) return;
      setSelected(new Set());
      setSelectedPage(0);
      setExtract({
        file,
        status: "working",
        pages: [],
        truncated: 0,
        progress: { page: 0, pages: 0 },
      });
      try {
        const result = await extractPageBlocks(file, (p) => {
          if (!cancelled && extractToken.current === token) {
            setExtract((prev) =>
              prev !== null && prev.file === file
                ? { ...prev, progress: p }
                : prev
            );
          }
        });
        if (cancelled || extractToken.current !== token) return;
        setExtract({
          file,
          status: "ready",
          pages: result.pages,
          truncated: result.truncated,
          progress: { page: 0, pages: 0 },
        });
      } catch (cause: unknown) {
        if (cancelled || extractToken.current !== token) return;
        const name =
          cause !== null && typeof cause === "object" && "name" in cause
            ? String((cause as { name: unknown }).name)
            : "";
        setExtract({
          file,
          status: name === "PasswordException" ? "encrypted" : "error",
          pages: [],
          truncated: 0,
          progress: { page: 0, pages: 0 },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);

  const activeExtract =
    extract !== null && extract.file === file ? extract : null;
  const pages = activeExtract?.pages ?? [];
  const pageCount = pages.length;
  const status: ExtractStatus | "none-yet" = activeExtract?.status ?? "none-yet";
  const ready = status === "ready";

  // The worker run never depends on the interactive selection.
  useEffect(() => {
    setRunBlocked(null);
    return () => setRunBlocked(null);
  }, [setRunBlocked]);

  /* ---------------- page preview render ---------------- */

  useEffect(() => {
    if (!file || !ready || pageCount === 0) return;
    let cancelled = false;
    void (async () => {
      // Reset on a microtask — never synchronously in the effect body.
      await Promise.resolve();
      if (cancelled) return;
      setBitmap(null);
      setRenderFailed(false);
      try {
        const thumb = await renderPdfThumbnail(file, {
          pageIndex: selectedPage,
          maxDim: PREVIEW_MAX_DIM,
        });
        const next = await createImageBitmap(thumb.blob);
        if (!cancelled) setBitmap(next);
      } catch {
        if (!cancelled) setRenderFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file, ready, pageCount, selectedPage]);

  const currentPage =
    selectedPage < pageCount ? pages[selectedPage] : null;
  const currentBlocks = currentPage?.blocks ?? [];
  const currentEmpty = ready && pageCount > 0 && currentBlocks.length === 0;

  /* ---------------- selection ---------------- */

  const allBlocks = useMemo(
    () => pages.flatMap((page) => page.blocks),
    [pages]
  );
  const selectedBlocks = useMemo(
    () => allBlocks.filter((block) => selected.has(block.id)),
    [allBlocks, selected]
  );
  const charCount = useMemo(
    () => selectedBlocks.reduce((sum, block) => sum + block.text.length, 0),
    [selectedBlocks]
  );
  const markedPages = useMemo(() => {
    const set = new Set<number>();
    for (const block of allBlocks) {
      if (selected.has(block.id)) set.add(block.page);
    }
    return set as ReadonlySet<number>;
  }, [allBlocks, selected]);

  const toggleBlock = useCallback((id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const selectPage = useCallback((): void => {
    if (currentPage === null) return;
    setSelected((prev) => {
      const next = new Set(prev);
      for (const block of currentPage.blocks) next.add(block.id);
      return next;
    });
  }, [currentPage]);

  const clearSelection = useCallback((): void => {
    setSelected(new Set());
  }, []);

  /* ---------------- copy / download ---------------- */

  const onCopy = useCallback(async (): Promise<void> => {
    if (selectedBlocks.length === 0) return;
    const text = selectionToOutput(selectedBlocks, format);
    const ok = await writeClipboard(text);
    if (ok) {
      toast({
        title: t("copyFrom.copySuccess"),
        description: t("copyFrom.copySuccessDesc", { count: charCount }),
      });
    } else {
      toast({
        title: t("copyFrom.copyFail"),
        variant: "destructive",
      });
    }
  }, [selectedBlocks, format, charCount, t, toast]);

  const onDownload = useCallback((): void => {
    if (selectedBlocks.length === 0 || file === null) return;
    const text = selectionToOutput(selectedBlocks, format);
    const base = file.name
      .replace(/\.(pdf)$/i, "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .slice(0, 120);
    const blob = new Blob([text], { type: formatMime(format) });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${base}-copy.${formatExt(format)}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, [selectedBlocks, format, file]);

  /* ---------------- file chips ---------------- */

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

  return (
    <section
      aria-label={t("copyFrom.surfaceLabel")}
      className="flex flex-col gap-3"
    >
      <PreviewFileHeader
        file={file}
        pageCount={ready ? pageCount : 0}
        onRemove={removeFirst}
      />

      {/* Other files as chips (the preview works on the first file) */}
      {files.length > 1 ? (
        <ul
          className="flex flex-wrap gap-2"
          aria-label={t("copyFrom.otherFiles")}
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

      {/* ---------------- selection toolbar ---------------- */}
      <div
        className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-card p-2.5 shadow-sm"
        role="toolbar"
        aria-label={t("copyFrom.toolbarLabel")}
      >
        <div className="flex items-center gap-1.5">
          <span className="sr-only">{t("copyFrom.formatLabel")}</span>
          <Select
            value={format}
            onValueChange={(next) => {
              if (next === "markdown" || next === "csv" || next === "text") {
                setFormat(next);
              }
            }}
          >
            <SelectTrigger className="h-11 min-h-11 w-[150px] rounded-btn text-xs font-medium">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="text" className="text-xs">
                {t("copyFrom.fmtText")}
              </SelectItem>
              <SelectItem value="markdown" className="text-xs">
                {t("copyFrom.fmtMarkdown")}
              </SelectItem>
              <SelectItem value="csv" className="text-xs">
                {t("copyFrom.fmtCsv")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <p
          className="min-w-0 flex-1 basis-40 text-xs leading-relaxed text-muted-foreground"
          aria-live="polite"
        >
          {selectedBlocks.length > 0
            ? t("copyFrom.selectionSummary", {
                blocks: selectedBlocks.length,
                chars: charCount,
              })
            : t("copyFrom.emptyHint")}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-11 min-h-11 rounded-btn px-3 text-xs font-medium"
            onClick={selectPage}
            disabled={!ready || currentBlocks.length === 0}
          >
            <MousePointerClick className="size-3.5" aria-hidden="true" />
            {t("copyFrom.selectPage")}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-11 min-h-11 rounded-btn px-3 text-xs font-medium"
            onClick={clearSelection}
            disabled={selectedBlocks.length === 0}
          >
            {t("copyFrom.clearSelection")}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-11 min-h-11 rounded-btn px-3 text-xs font-medium"
            onClick={onDownload}
            disabled={selectedBlocks.length === 0}
          >
            <Download className="size-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">{t("copyFrom.downloadButton")}</span>
          </Button>
          <Button
            type="button"
            size="touch"
            className="rounded-btn px-4 text-xs font-semibold"
            onClick={() => {
              void onCopy();
            }}
            disabled={selectedBlocks.length === 0}
          >
            <Copy className="size-3.5" aria-hidden="true" />
            {t("copyFrom.copyButton")}
          </Button>
        </div>
      </div>

      {/* ---------------- extraction status ---------------- */}
      <div aria-live="polite">
        {status === "working" || status === "none-yet" ? (
          <p
            role="status"
            className="flex items-center gap-2 rounded-card border border-border bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground"
          >
            <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
            {activeExtract !== null && activeExtract.progress.pages > 0
              ? t("copyFrom.readingProgress", {
                  page: activeExtract.progress.page,
                  pages: activeExtract.progress.pages,
                })
              : t("copyFrom.reading")}
          </p>
        ) : status === "encrypted" ? (
          <p className="flex items-start gap-2 rounded-card border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
            <LockKeyhole className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {t("copyFrom.probeEncrypted")}
          </p>
        ) : status === "error" ? (
          <p className="flex items-start gap-2 rounded-card border border-border bg-muted/40 px-4 py-2.5 text-xs leading-relaxed text-muted-foreground">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {t("copyFrom.probeError")}
          </p>
        ) : null}
      </div>

      {/* Pages beyond the interactive guard — honest note */}
      {ready && activeExtract !== null && activeExtract.truncated > 0 ? (
        <p className="flex items-start gap-2 rounded-card border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {t("copyFrom.truncatedNote", { count: activeExtract.truncated })}
        </p>
      ) : null}

      {/* ---------------- page + clickable blocks ---------------- */}
      {ready ? (
        <div className="flex flex-col gap-3">
          {pageCount > 1 ? (
            <PreviewPageStrip
              file={file}
              pageCount={pageCount}
              selected={selectedPage}
              onSelect={setSelectedPage}
              markedSet={markedPages}
            />
          ) : null}

          {currentEmpty ? (
            <p className="flex items-start gap-2 rounded-card border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
              <ScanText className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {t("copyFrom.noTextPage")}
            </p>
          ) : null}

          {renderFailed ? (
            <p className="flex items-start gap-2 rounded-card border border-border bg-muted/40 px-4 py-2.5 text-xs leading-relaxed text-muted-foreground">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {t("copyFrom.renderError")}
            </p>
          ) : null}

          {bitmap !== null && currentPage !== null ? (
            <div
              className="relative mx-auto w-full max-w-[680px] overflow-hidden rounded-card border border-border bg-white shadow-sm"
              aria-label={t("copyFrom.pageBlocksLabel")}
            >
              <canvas
                ref={(canvas) => {
                  if (!canvas) return;
                  const ctx = canvas.getContext("2d");
                  if (!ctx) return;
                  canvas.width = bitmap.width;
                  canvas.height = bitmap.height;
                  ctx.clearRect(0, 0, canvas.width, canvas.height);
                  ctx.drawImage(bitmap, 0, 0);
                }}
                className="block h-auto w-full"
                aria-hidden="true"
              />
              <div className="absolute inset-0">
                {currentBlocks.map((block) => (
                  <BlockOverlay
                    key={block.id}
                    block={block}
                    viewW={currentPage.viewW}
                    viewH={currentPage.viewH}
                    selected={selected.has(block.id)}
                    onToggle={() => toggleBlock(block.id)}
                    label={t("copyFrom.blockA11y", {
                      text: block.text.slice(0, 80),
                    })}
                  />
                ))}
              </div>
            </div>
          ) : !renderFailed && !currentEmpty && bitmap === null ? (
            <div
              className="flex items-center justify-center rounded-card border border-dashed border-border bg-muted/30 px-4 py-10 text-xs text-muted-foreground"
              role="status"
            >
              <Loader2 className="mr-2 size-3.5 animate-spin" aria-hidden="true" />
              {t("copyFrom.reading")}
            </div>
          ) : null}

          <p className="text-xs text-muted-foreground">
            {t("copyFrom.runNote")}
          </p>
        </div>
      ) : null}

      {/* Add more (compact) — same shell pipeline as the landing drop */}
      <DropZone
        labelKey="tool.addMoreFiles"
        multiple
        maxFiles={5}
        acceptKind="pdf"
        onAccept={addFiles}
        currentCount={files.length}
        className="py-2"
      />
    </section>
  );
}

export default CopyFromPdfSurface;

/* ------------------------------ overlay ------------------------------ */

function BlockOverlay({
  block,
  viewW,
  viewH,
  selected,
  onToggle,
  label,
}: {
  block: TextBlock;
  viewW: number;
  viewH: number;
  selected: boolean;
  onToggle: () => void;
  label: string;
}): React.JSX.Element {
  const left = `${(block.x / viewW) * 100}%`;
  const top = `${(block.y / viewH) * 100}%`;
  const width = `${Math.max(2, (block.w / viewW) * 100)}%`;
  const height = `max(${(block.h / viewH) * 100}%, 44px)`;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      aria-label={label}
      title={block.kind === "heading" ? "## " + block.text.slice(0, 60) : block.text.slice(0, 80)}
      style={{ left, top, width, height }}
      className={[
        "absolute rounded-sm text-left outline-none transition-colors",
        "focus-visible:ring-[3px] focus-visible:ring-ring/60",
        selected
          ? "bg-primary/20 ring-1 ring-inset ring-primary/50"
          : "bg-primary/0 hover:bg-primary/10 ring-1 ring-inset ring-transparent hover:ring-primary/25",
      ].join(" ")}
    >
      <span className="sr-only">{selected ? "✓ " : ""}</span>
    </button>
  );
}
