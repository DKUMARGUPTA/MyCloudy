"use client";

/**
 * OpenDocument to PDF surface (RB2-b — the 72nd tool). ODT/ODS → PDF,
 * 100% on-device, EN + हिंदी.
 *
 * Landing (landingSurface — word-to-pdf precedent): an .odt/.ods drop
 * zone that validates the PK ZIP magic itself (the shared DropZone
 * only knows pdf/image), so a renamed non-ZIP can never enter the
 * pipeline; .odp/.odg packages pass the ZIP sniff and are rejected
 * honestly by the same parseOdt that powers the live summary.
 *
 * Workspace: the file card, a LIVE summary (kind chip + paragraphs or
 * sheets + words + estimated pages) from the exact same parseOdt the
 * worker runs (so the numbers can never disagree with the output),
 * A4/Letter + normal/narrow toggles bound to the shared option values
 * (the aside/bottom-sheet selects and these chips write through one
 * source of truth), and the Convert button that spawns the worker
 * (word-to-pdf pattern) → download + toast. The shell CTA runs the
 * same worker through the standard pipeline — gated via setRunBlocked
 * while no file is present.
 *
 * Mobile-safe: min-w-0 on every grid/text wrapper (the pinned
 * grid-blowout lesson). Everything is real DOM text — no canvas.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import {
  FileDown,
  FileSpreadsheet,
  FileText,
  FileUp,
  FolderOpen,
  Loader2,
  TriangleAlert,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { downloadBlob } from "@/lib/files/output";
import { formatBytes } from "@/lib/storage/recent-files";
import type { WorkerResponse } from "@/lib/workers/protocol";
import { cn } from "@/lib/utils";
import { estimatePages, parseOdt, stats, type ParsedOdf } from "./model";

/* ------------------------------------------------------------------ */
/* Local input validation (magic bytes, size limits)                    */
/* ------------------------------------------------------------------ */

function isMobileDevice(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(pointer: coarse)").matches;
}

function sizeLimitBytes(): number {
  return isMobileDevice() ? 50 * 1024 * 1024 : 200 * 1024 * 1024;
}

function sizeLimitLabel(): string {
  return isMobileDevice() ? "50 MB" : "200 MB";
}

/** OpenDocument files are ZIPs: PK\x03\x04. */
async function sniffIsZip(file: File): Promise<boolean> {
  try {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  } catch {
    return false;
  }
}

interface SummaryState {
  /** staleness tag: the file identity the doc belongs to. */
  key: string;
  doc: ParsedOdf | null;
  /** parseOdt error code ("errOdp"…) or null. */
  error: string | null;
}

/* ------------------------------------------------------------------ */
/* Surface                                                              */
/* ------------------------------------------------------------------ */

export function OdtToPdfSurface({
  files,
  values,
  onChange,
  setFileOrder,
  setRunBlocked,
  addFiles,
}: ToolSurfaceProps): React.JSX.Element {
  const { t, locale } = useI18n();
  const { toast } = useToast();

  const file = files.length > 0 ? (files[files.length - 1]?.file ?? null) : null;
  const fileKey = file ? `${file.name}:${file.size}:${file.lastModified}` : "";

  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  const [summary, setSummary] = useState<SummaryState | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const workerRef = useRef<Worker | null>(null);

  /* ---------- CTA gate: no file → blocked (scan-pdf pattern) ---------- */
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setRunBlocked(files.length === 0 ? "odt.ctaNoFile" : null);
    });
    return () => {
      cancelled = true;
    };
  }, [files.length, setRunBlocked]);

  /* ---------- live summary: the SAME parser the worker uses ---------- */
  useEffect(() => {
    let cancelled = false;
    if (!file) {
      void Promise.resolve().then(() => {
        if (!cancelled) setSummary(null);
      });
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (cancelled) return;
        try {
          setSummary({ key: fileKey, doc: parseOdt(bytes), error: null });
        } catch (error) {
          const code =
            error && typeof error === "object" && "code" in error
              ? String((error as { code: unknown }).code)
              : "";
          setSummary({ key: fileKey, doc: null, error: code || "errNoContent" });
        }
      } catch {
        if (!cancelled) setSummary({ key: fileKey, doc: null, error: "errCorrupt" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file, fileKey]);

  const parsedDoc =
    summary && summary.key === fileKey && file ? summary.doc : null;
  const parseError =
    summary && summary.key === fileKey && file ? summary.error : null;
  const docOk = parsedDoc !== null;
  const docStats = parsedDoc !== null ? stats(parsedDoc) : null;
  const estPages = parsedDoc !== null ? estimatePages(parsedDoc) : 0;
  const statPairs: readonly [string, number][] =
    docStats === null
      ? []
      : docStats.kind === "text"
        ? [
            ["odt.statParas", docStats.blocks],
            ["odt.statTables", docStats.tableCount],
            ["odt.statWords", docStats.words],
            ["odt.statPages", estPages],
          ]
        : [
            ["odt.statSheets", docStats.sheetCount],
            ["odt.statRows", docStats.rowCount],
            ["odt.statCells", docStats.cellCount],
            ["odt.statPages", estPages],
          ];

  /* ---------- input pipeline (magic bytes + size limit) ---------- */

  const acceptFile = useCallback(
    (incoming: File[]): void => {
      if (incoming.length === 0 || files.length > 0) return;
      const f = incoming[0];
      if (!f) return;
      if (f.size > sizeLimitBytes()) {
        toast({
          title: t("odt.errTooLargeTitle"),
          description: t("odt.errTooLargeDesc", { size: sizeLimitLabel() }),
          variant: "destructive",
        });
        return;
      }
      void sniffIsZip(f).then((isZip) => {
        if (!isZip) {
          toast({
            title: t("odt.errNotZipTitle"),
            description: t("odt.errNotZipDesc"),
            variant: "destructive",
          });
          return;
        }
        addFiles([f]);
      });
    },
    [addFiles, files.length, t, toast]
  );

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      acceptFile([...(event.target.files ?? [])]);
      event.target.value = ""; // allow re-selecting the same file
    },
    [acceptFile]
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>): void => {
      event.preventDefault();
      dragCounter.current = 0;
      setDragOver(false);
      acceptFile([...event.dataTransfer.files]);
    },
    [acceptFile]
  );

  // Ctrl+V of a file from the desktop (house DropZone behaviour).
  useEffect(() => {
    const onPaste = (event: globalThis.ClipboardEvent): void => {
      const pasted = [...(event.clipboardData?.files ?? [])];
      if (pasted.length === 0) return;
      event.preventDefault();
      acceptFile(pasted);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [acceptFile]);

  /* ---------- Convert → worker spawn (word-to-pdf pattern) ---------- */

  const pageSize = String(values.pageSize ?? "a4") === "letter" ? "letter" : "a4";
  const margin = String(values.margin ?? "normal") === "narrow" ? "narrow" : "normal";
  const lang = locale === "hi" ? "hi" : "en";

  const convert = useCallback((): void => {
    if (!file || workerRef.current || !docOk) return;
    setPct(0);
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    const runId = Date.now();
    const cleanup = (): void => {
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };
    worker.addEventListener(
      "message",
      (event: MessageEvent<WorkerResponse>) => {
        const data = event.data;
        if (!data || data.runId !== runId) return;
        if (data.type === "progress") {
          setPct(data.pct);
          return;
        }
        if (data.type === "result") {
          setPct(null);
          const output = data.outputs[0];
          if (output) {
            downloadBlob(output.blob, output.name);
            toast({
              title: t("odt.doneTitle"),
              description: t("odt.doneDesc", {
                name: output.name,
                pages: data.detail?.pages ?? 1,
              }),
            });
          }
          cleanup();
          return;
        }
        if (data.type === "error") {
          setPct(null);
          toast({
            title: t("tool.errorTitle"),
            description: data.code.startsWith("odt.")
              ? t(data.code)
              : t("tool.errorGeneric"),
            variant: "destructive",
          });
          cleanup();
        }
      }
    );
    worker.addEventListener("error", () => {
      setPct(null);
      toast({
        title: t("tool.errorTitle"),
        description: t("tool.errorGeneric"),
        variant: "destructive",
      });
      cleanup();
    });
    worker.postMessage({
      type: "run",
      runId,
      toolId: "odt-to-pdf",
      options: {
        pageSize,
        margin,
        lang,
      },
      files: [file],
    });
  }, [docOk, file, lang, margin, pageSize, t, toast]);

  // Kill a stuck worker if the surface unmounts mid-run.
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
    };
  }, []);

  const removeFile = useCallback((): void => {
    setFileOrder([]);
  }, [setFileOrder]);

  const countFmt = useCallback(
    (n: number): string => n.toLocaleString(locale === "hi" ? "hi-IN" : "en-IN"),
    [locale]
  );

  /* ---------------------------------------------------------------- */

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      {/* ---------------- file input / file card ---------------- */}
      {!file ? (
        <section aria-label={t("odt.selectFile")}>
          <div
            onDragEnter={(event) => {
              event.preventDefault();
              dragCounter.current += 1;
              setDragOver(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              event.preventDefault();
              dragCounter.current = Math.max(0, dragCounter.current - 1);
              if (dragCounter.current === 0) setDragOver(false);
            }}
            onDrop={handleDrop}
            className={cn(
              "relative rounded-card border-2 border-dashed transition-all duration-200",
              dragOver
                ? "scale-[1.01] border-primary bg-primary/5 ring-4 ring-primary/10"
                : "border-border bg-card hover:border-primary/40"
            )}
          >
            <label
              htmlFor={inputId}
              className="flex min-h-44 cursor-pointer flex-col items-center justify-center gap-3 px-6 py-8 text-center"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-14 items-center justify-center rounded-full border transition-all duration-200",
                  dragOver
                    ? "scale-110 border-primary bg-primary/10 text-primary"
                    : "border-border bg-muted/50 text-muted-foreground"
                )}
              >
                {dragOver ? (
                  <FileUp className="size-6 animate-in fade-in-50 zoom-in-75" />
                ) : (
                  <FolderOpen className="size-6" />
                )}
              </span>
              <span className="text-sm font-semibold text-foreground">
                {t("odt.selectFile")}
              </span>
              <span className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span>{t("odt.dropHint")}</span>
                <span aria-hidden="true">·</span>
                <span className="font-medium">
                  <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-sans text-[10px]">
                    Ctrl
                  </kbd>
                  <span> + </span>
                  <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-sans text-[10px]">
                    V
                  </kbd>
                  <span className="sr-only"> </span>
                  <span> {t("odt.pasteHint")}</span>
                </span>
              </span>
              <span className="text-[11px] text-muted-foreground">
                {t("odt.limits", { size: sizeLimitLabel() })}
              </span>
            </label>
            <input
              ref={inputRef}
              id={inputId}
              type="file"
              accept=".odt,.ods,.ott,.ots,application/vnd.oasis.opendocument.text,application/vnd.oasis.opendocument.spreadsheet"
              className="sr-only"
              onChange={handleInputChange}
              aria-label={t("odt.selectFile")}
            />
          </div>
        </section>
      ) : (
        <section aria-label={file.name}>
          <div className="rounded-card border border-border bg-card p-4 sm:p-5">
            <div className="flex flex-wrap items-center gap-3">
              <span
                className="flex size-11 shrink-0 items-center justify-center rounded-btn bg-primary/10 text-primary"
                aria-hidden="true"
              >
                {parsedDoc?.kind === "sheets" ? (
                  <FileSpreadsheet className="size-5" />
                ) : (
                  <FileText className="size-5" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className="truncate text-sm font-semibold text-foreground"
                  title={file.name}
                >
                  {file.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatBytes(file.size)}
                </p>
              </div>
              <span className="shrink-0 rounded-chip bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
                {parsedDoc?.kind === "sheets"
                  ? t("odt.chipSheets")
                  : t("odt.chipText")}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-btn"
                onClick={removeFile}
                aria-label={t("odt.removeFile")}
              >
                <X className="size-4" aria-hidden="true" />
                <span className="hidden sm:inline">{t("odt.removeFile")}</span>
              </Button>
            </div>
          </div>
        </section>
      )}

      {/* ---------------- live summary ---------------- */}
      {file ? (
        <section aria-labelledby="odt-summary-heading">
          <h2
            id="odt-summary-heading"
            className="text-sm font-semibold text-foreground"
          >
            {t("odt.summaryTitle")}
          </h2>
          {parsedDoc === null ? (
            <div
              className="mt-3 flex items-center gap-2 rounded-card border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
              aria-live="polite"
            >
              {parseError === null ? (
                <>
                  <Loader2
                    className="size-4 shrink-0 animate-spin text-primary"
                    aria-hidden="true"
                  />
                  {t("conv.reading")}
                </>
              ) : (
                <>
                  <TriangleAlert
                    className="size-4 shrink-0 text-amber-600"
                    aria-hidden="true"
                  />
                  {t(`odt.${parseError}`)}
                </>
              )}
            </div>
          ) : (
            <div className="mt-3">
              {docStats !== null ? (
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {statPairs.map(([key, n]) => (
                    <div
                      key={key}
                      className="min-w-0 rounded-card border border-border bg-card p-3 text-center"
                    >
                      <dt className="order-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {t(key)}
                      </dt>
                      <dd className="order-1 text-lg font-bold tabular-nums text-foreground">
                        {countFmt(n)}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {docOk && docStats !== null && docStats.truncated ? (
                <div
                  role="status"
                  className="mt-3 flex items-start gap-2 rounded-btn border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-900 dark:text-amber-200"
                >
                  <TriangleAlert
                    className="mt-0.5 size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  {t("odt.truncatedNote")}
                </div>
              ) : null}
            </div>
          )}
        </section>
      ) : null}

      {/* ---------------- layout toggles + convert ---------------- */}
      <section aria-labelledby="odt-layout-heading">
        <h2
          id="odt-layout-heading"
          className="text-sm font-semibold text-foreground"
        >
          {t("odt.layoutTitle")}
        </h2>
        <div className="mt-3 flex flex-col gap-4 rounded-card border border-border bg-card p-4 sm:p-5">
          <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">
                {t("odt.pageSizeLbl")}
              </p>
              <div
                role="group"
                aria-label={t("odt.pageSizeLbl")}
                className="mt-2 flex flex-wrap gap-2"
              >
                {(
                  [
                    ["a4", "odt.pageA4"],
                    ["letter", "odt.pageLetter"],
                  ] as const
                ).map(([value, key]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={pageSize === value}
                    onClick={() => onChange("pageSize", value)}
                    className={cn(
                      "h-9 rounded-btn px-4 text-xs font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      pageSize === value
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-foreground hover:bg-muted/80"
                    )}
                  >
                    {t(key)}
                  </button>
                ))}
              </div>
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">
                {t("odt.marginLbl")}
              </p>
              <div
                role="group"
                aria-label={t("odt.marginLbl")}
                className="mt-2 flex flex-wrap gap-2"
              >
                {(
                  [
                    ["normal", "odt.marginNormal"],
                    ["narrow", "odt.marginNarrow"],
                  ] as const
                ).map(([value, key]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={margin === value}
                    onClick={() => onChange("margin", value)}
                    className={cn(
                      "h-9 rounded-btn px-4 text-xs font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      margin === value
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-foreground hover:bg-muted/80"
                    )}
                  >
                    {t(key)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <Button
              type="button"
              size="touch"
              className="w-full rounded-btn font-semibold sm:w-auto sm:self-start"
              onClick={convert}
              disabled={!file || pct !== null || !docOk}
            >
              {pct !== null ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <FileDown className="size-4" aria-hidden="true" />
              )}
              {pct !== null ? t("odt.converting") : t("odt.convert")}
            </Button>
            {pct !== null ? (
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
                className="h-1.5 w-full overflow-hidden rounded-full bg-muted sm:max-w-xs"
              >
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300"
                  style={{ width: `${pct}%` }}
                />
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {/* ---------------- honest limits ---------------- */}
      <p className="rounded-btn bg-muted/60 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
        {t("odt.honestNote")}
      </p>
    </div>
  );
}
