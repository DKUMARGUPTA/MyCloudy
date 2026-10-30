"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  Check,
  ClipboardCheck,
  Copy,
  Download,
  FileText,
  FileUp,
  ListChecks,
  Loader2,
  Lock,
  RefreshCw,
  Sparkles,
  X,
  Zap,
} from "lucide-react";

import type { ConvertFace } from "../convert-common/face";
import { faceOpts, faceWidth } from "../convert-common/face";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DropZone } from "@/components/doco/tool/drop-zone";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import { formatBytes } from "@/lib/storage/recent-files";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import {
  buildSummaryMarkdown,
  buildSummaryPlainText,
  buildDocExcerpt,
  hasDevanagari,
  isLikelyScanned,
  isSummaryLanguage,
  isSummaryLength,
  parseSummarySections,
  summarizeBaseName,
  type DocExcerpt,
  type ExtractedPage,
  type SummaryLength,
  type SummarySection,
} from "./model";

/**
 * Summarize PDF (R11) — the workspace IS the tool (viewerOnly, like
 * chat-with-pdf): no run step, no result phase. Pipeline:
 *
 *   file → extraction worker (the SHARED chat worker file, on-device,
 *          page-marked text, index 0)
 *        → buildDocExcerpt (chat model, head+tail trim, 48k budget)
 *        → /api/summarize (ONLY the excerpt + option codes)
 *        → structured sections on screen (localized labels, (p. N) chips)
 *        → Copy / Export: Markdown, plain text, PDF (own-engine
 *          CreateContext on the main thread — a 1-3 page summary;
 *          Devanagari embeds Noto via our subsetter).
 *
 * Hooks discipline (R3 house rules): no setState during render — the
 * extraction effect keys on the file-set signature + retry tick, exactly
 * like the chat surface.
 */

type FileStatus = "pending" | "ready" | "scanned" | "encrypted" | "corrupt";

interface WorkerEvent {
  type?: string;
  page?: number;
  total?: number;
  index?: number;
  pages?: ExtractedPage[];
  code?: "encrypted" | "corrupt";
}

const SECTION_ICONS: Record<string, typeof Zap> = {
  tldr: Zap,
  keyPoints: ListChecks,
  actionItems: ClipboardCheck,
  details: FileText,
  other: FileText,
};

/** Markdown-lite inline: **bold** and (p. N) citation chips. */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /\*\*([^*]+)\*\*|\(p\.\s*(\d+)\)/g;
  let last = 0;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      nodes.push(
        <strong key={`${keyBase}-b${n}`} className="font-semibold">
          {m[1]}
        </strong>,
      );
    } else if (m[2] !== undefined) {
      nodes.push(
        <span
          key={`${keyBase}-c${n}`}
          className="mx-0.5 inline-flex items-center rounded-full bg-primary/10 px-1.5 py-px text-[11px] font-semibold text-primary"
        >
          p.&nbsp;{m[2]}
        </span>,
      );
    }
    last = m.index + m[0].length;
    n += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/* --------------------- lazy PDF export (main thread) ------------------- */

const A4 = { w: 595.28, h: 841.89 } as const;
const PDF_MARGIN = 48;

/** WinAnsi sanitizer (translate worker recipe) for latin-font draws. */
function latinSafe(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    if (
      ch === "\n" ||
      ch === "\t" ||
      (code >= 0x20 && code <= 0xff) ||
      code === 0x2018 ||
      code === 0x2019 ||
      code === 0x201c ||
      code === 0x201d ||
      code === 0x2013 ||
      code === 0x2014 ||
      code === 0x2026 ||
      code === 0x20ac
    ) {
      out += ch;
    } else {
      out += "?";
    }
  }
  return out;
}

interface PdfFontPair {
  latin: ConvertFace;
  deva: ConvertFace | null;
  bold: ConvertFace;
}

export function SummarizeSurface({
  files,
  setFileOrder,
  addFiles,
  onChain,
}: ToolSurfaceProps): ReactNode {
  const { t, locale } = useI18n();
  const { toast } = useToast();

  const filesSig = files.map((f) => f.id).join("|");

  const [extraction, setExtraction] = useState<{
    page: number;
    total: number;
  } | null>(null);
  const [status, setStatus] = useState<FileStatus>("pending");
  const [excerpt, setExcerpt] = useState<DocExcerpt | null>(null);
  const [language, setLanguage] = useState<"en" | "hi">(
    locale === "hi" ? "hi" : "en",
  );
  const [length, setLength] = useState<SummaryLength>("standard");
  const [pending, setPending] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [copied, setCopied] = useState(false);
  const [retryTick, setRetryTick] = useState(0);

  const workerRef = useRef<Worker | null>(null);
  const filesRef = useRef(files);
  const ranSigRef = useRef<string | null>(null);

  useEffect(() => {
    filesRef.current = files;
  });

  /* ---------- extraction worker lifecycle (signature-keyed) ---------- */

  useEffect(() => {
    const sig = `${filesSig}#${retryTick}`;
    if (files.length === 0) {
      workerRef.current?.terminate();
      workerRef.current = null;
      ranSigRef.current = null;
      setExtraction(null);
      setStatus("pending");
      setExcerpt(null);
      setSummary(null);
      return;
    }
    if (ranSigRef.current === sig) return;
    ranSigRef.current = sig;

    const currentFile = filesRef.current[0]?.file ?? null;
    setSummary(null);
    setExcerpt(null);
    setStatus("pending");
    setExtraction({ page: 0, total: 0 });

    workerRef.current?.terminate();
    // The SHARED chat extraction worker (same file, index always 0 here).
    const worker = new Worker(
      new URL("../chat-with-pdf/worker.ts", import.meta.url),
      { type: "module" },
    );
    workerRef.current = worker;
    let cancelled = false;

    const finish = (): void => {
      if (workerRef.current === worker) workerRef.current = null;
      worker.terminate();
    };

    const extract = (): Promise<
      { pages: ExtractedPage[] } | { code: "encrypted" | "corrupt" }
    > =>
      new Promise((resolve) => {
        const onMsg = (ev: MessageEvent<WorkerEvent>): void => {
          const data = ev.data;
          if (data?.index !== 0) return;
          if (data.type === "progress") {
            setExtraction({
              page: Number(data.page) || 0,
              total: Number(data.total) || 0,
            });
          } else if (data.type === "pages" && Array.isArray(data.pages)) {
            worker.removeEventListener("message", onMsg);
            resolve({ pages: data.pages });
          } else if (data.type === "error") {
            worker.removeEventListener("message", onMsg);
            resolve({
              code: data.code === "encrypted" ? "encrypted" : "corrupt",
            });
          }
        };
        worker.addEventListener("message", onMsg);
        if (!currentFile) {
          worker.removeEventListener("message", onMsg);
          resolve({ code: "corrupt" });
          return;
        }
        currentFile
          .arrayBuffer()
          .then((buf) => {
            if (cancelled) {
              worker.removeEventListener("message", onMsg);
              resolve({ code: "corrupt" });
              return;
            }
            worker.postMessage({ type: "extract", file: buf, index: 0 }, [buf]);
          })
          .catch(() => {
            worker.removeEventListener("message", onMsg);
            resolve({ code: "corrupt" });
          });
      });

    const run = async (): Promise<void> => {
      const res = await extract();
      if (cancelled) return;
      if ("pages" in res) {
        const pages = res.pages.slice(0, 200);
        if (isLikelyScanned(pages)) {
          setStatus("scanned");
        } else {
          const built = buildDocExcerpt(pages);
          setExcerpt(built);
          setStatus("ready");
        }
      } else {
        setStatus(res.code);
      }
      setExtraction(null);
      finish();
    };

    void run();

    return () => {
      cancelled = true;
      if (workerRef.current === worker) {
        workerRef.current = null;
        worker.terminate();
        if (ranSigRef.current === sig) {
          ranSigRef.current = null;
        }
      }
    };
  }, [filesSig, retryTick]);

  const sections: SummarySection[] = useMemo(
    () => (summary === null ? [] : parseSummarySections(summary)),
    [summary],
  );

  /* --------------------------- summarize --------------------------- */

  const summarize = useCallback(async (): Promise<void> => {
    if (pending || excerpt === null) return;
    setPending(true);
    setSummary(null);
    try {
      const res = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          excerpt: excerpt.excerpt,
          language,
          length,
          locale,
          docName: filesRef.current[0]?.file.name,
        }),
      });
      const data: unknown = await res.json().catch(() => null);
      const text = (data as { summary?: unknown } | null)?.summary;
      if (res.ok && typeof text === "string" && text.trim().length > 0) {
        setSummary(text.trim());
      } else {
        const code = (data as { error?: unknown } | null)?.error;
        toast({
          title: t("summarize.errTitle"),
          description:
            code === "timeout"
              ? t("summarize.errTimeout")
              : code === "badRequest"
                ? t("summarize.errBadRequest")
                : code === "aiNotConfigured"
                  ? t("summarize.errNotConfigured")
                  : t("summarize.errSend"),
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: t("summarize.errTitle"),
        description: t("summarize.errSend"),
        variant: "destructive",
      });
    } finally {
      setPending(false);
    }
  }, [pending, excerpt, language, length, locale, t, toast]);

  const copySummary = async (): Promise<void> => {
    if (summary === null) return;
    try {
      await navigator.clipboard.writeText(summary);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast({
        title: t("summarize.errTitle"),
        description: t("summarize.errSend"),
        variant: "destructive",
      });
    }
  };

  const download = (blob: Blob, name: string): void => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  const exportLabels = useCallback(
    () => ({
      title: t("summarize.exportFileTitle"),
      document: t("summarize.exportDocumentLabel"),
      generated: t("summarize.exportGenerated"),
      tldr: t("summarize.secTldr"),
      keyPoints: t("summarize.secKeyPoints"),
      actionItems: t("summarize.secActionItems"),
      details: t("summarize.secDetails"),
    }),
    [t],
  );

  const exportText = (format: "md" | "txt"): void => {
    if (sections.length === 0) return;
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const labels = exportLabels();
    const docName = filesRef.current[0]?.file.name ?? "document";
    const text =
      format === "md"
        ? buildSummaryMarkdown(docName, sections, stamp, labels)
        : buildSummaryPlainText(docName, sections, stamp, labels);
    if (text.length === 0) return;
    download(
      new Blob([text], {
        type: format === "md" ? "text/markdown" : "text/plain",
      }),
      `${summarizeBaseName(docName, language)}.${format}`,
    );
    toast({ title: t("summarize.exportDone") });
  };

  const exportPdf = async (): Promise<void> => {
    if (sections.length === 0 || generatingPdf) return;
    setGeneratingPdf(true);
    try {
      // Own engine — no pdf-lib, no fontkit, no regenerator shim.
      const { CreateContext } = await import("@/lib/own/pdf");

      const doc = CreateContext.create();
      const latin: ConvertFace = { std: "helvetica" };
      const bold: ConvertFace = { std: "helveticaBold" };
      let deva: PdfFontPair["deva"] = null;
      const docName = filesRef.current[0]?.file.name ?? "document";
      const labels = exportLabels();
      if (hasDevanagari(summary ?? "")) {
        const res = await fetch("/fonts/NotoSansDevanagari-Regular.ttf");
        if (!res.ok) throw new Error("fontFetch");
        deva = {
          ttf: doc.embedTtf(new Uint8Array(await res.arrayBuffer())),
        };
      }
      const fonts: PdfFontPair = { latin, bold, deva };

      const width = A4.w - PDF_MARGIN * 2;
      let page = doc.addPage(A4.w, A4.h);
      let y = A4.h - PDF_MARGIN;

      const fontFor = (text: string): ConvertFace =>
        hasDevanagari(text) && fonts.deva ? fonts.deva : fonts.latin;

      const draw = (
        text: string,
        font: ConvertFace,
        size: number,
        lineH: number,
        color: { r: number; g: number; b: number },
        indent = 0,
      ): void => {
        const usable = width - indent;
        let rest = text;
        while (rest.length > 0) {
          if (y - lineH < PDF_MARGIN) {
            page = doc.addPage(A4.w, A4.h);
            y = A4.h - PDF_MARGIN;
          }
          let lo = 1;
          let hi = rest.length;
          while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (faceWidth(doc, font, rest.slice(0, mid), size) <= usable) {
              lo = mid;
            } else {
              hi = mid - 1;
            }
          }
          let take = lo;
          if (take < rest.length && take > 1) {
            const cut = rest.lastIndexOf(" ", take);
            if (cut >= Math.floor(take * 0.4)) take = Math.max(1, cut);
          }
          page.drawText({
            text: rest.slice(0, take),
            x: PDF_MARGIN + indent,
            y: y - size,
            size,
            color,
            ...faceOpts(font),
          });
          y -= lineH;
          rest = rest.slice(take).trimStart();
        }
      };

      const plain = (s: string) => (fontFor(s) === fonts.latin ? latinSafe(s) : s);

      // Header block.
      draw(labels.title, fonts.bold, 16, 22, { r: 0.09, g: 0.11, b: 0.13 });
      draw(
        `${labels.document}: ${docName}  ·  ${labels.generated}: ${new Date()
          .toISOString()
          .slice(0, 16)
          .replace("T", " ")}`,
        fonts.latin,
        9,
        13,
        { r: 0.45, g: 0.47, b: 0.5 },
      );
      y -= 14;

      // Sections.
      for (const section of sections) {
        const label =
          section.key === "tldr"
            ? labels.tldr
            : section.key === "keyPoints"
              ? labels.keyPoints
              : section.key === "actionItems"
                ? labels.actionItems
                : section.key === "details"
                  ? labels.details
                  : section.header;
        if (y - 34 < PDF_MARGIN) {
          page = doc.addPage(A4.w, A4.h);
          y = A4.h - PDF_MARGIN;
        }
        y -= 10;
        draw(plain(label), fonts.bold, 12.5, 18, { r: 0.09, g: 0.11, b: 0.13 });
        y -= 3;
        for (const p of section.paragraphs) {
          draw(plain(p), fontFor(p), 10.5, 15, { r: 0.18, g: 0.2, b: 0.23 });
          y -= 3;
        }
        for (const b of section.bullets) {
          draw(
            plain(`•  ${b}`),
            fontFor(`•  ${b}`),
            10.5,
            15,
            { r: 0.18, g: 0.2, b: 0.23 },
            10,
          );
          y -= 1.5;
        }
      }

      const bytes = doc.write();
      download(
        new Blob([bytes as BlobPart], { type: "application/pdf" }),
        `${summarizeBaseName(docName, language)}.pdf`,
      );
      toast({ title: t("summarize.exportDone") });
    } catch {
      toast({
        title: t("summarize.errTitle"),
        description: t("summarize.errPdf"),
        variant: "destructive",
      });
    } finally {
      setGeneratingPdf(false);
    }
  };

  /* ------------------------------ render ---------------------------- */

  if (files.length === 0) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-border/70 bg-gradient-to-b from-primary/5 to-transparent p-6 text-center sm:p-8">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Sparkles className="h-6 w-6" aria-hidden />
          </div>
          <h2 className="mt-4 text-lg font-semibold">
            {t("summarize.heroTitle")}
          </h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            {t("summarize.heroBody")}
          </p>
          <div className="mx-auto mt-4 flex max-w-md flex-wrap items-center justify-center gap-1.5">
            <Zap className="h-3.5 w-3.5 text-primary" aria-hidden />
            <span className="text-xs text-muted-foreground">
              {t("summarize.heroFree")}
            </span>
          </div>
        </div>
        <DropZone
          labelKey="summarize.dropHere"
          multiple={false}
          maxFiles={1}
          acceptKind="pdf"
          onAccept={addFiles}
          currentCount={0}
        />
      </div>
    );
  }

  const f = files[0];
  const ready = excerpt !== null;

  return (
    <div className="space-y-3">
      {/* File card */}
      <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FileText className="h-4 w-4" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium" title={f.file.name}>
              {f.file.name}
            </p>
            {extraction !== null ? (
              <span className="flex items-center gap-1.5 text-xs text-primary">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                {extraction.total > 0
                  ? t("summarize.extractingPage", {
                      page: extraction.page,
                      total: extraction.total,
                    })
                  : t("summarize.extracting")}
              </span>
            ) : status === "ready" && excerpt ? (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <span>
                  {t("summarize.docPages", { count: excerpt.pagesTotal })}
                </span>
                <span aria-hidden>·</span>
                <span>
                  {t("summarize.docChars", { count: excerpt.totalChars })}
                </span>
                {excerpt.omittedPages > 0 && (
                  <span className="rounded-full bg-amber-500/10 px-2 py-px text-[11px] font-medium text-amber-600 dark:text-amber-400">
                    {t("summarize.pagesOmitted", {
                      count: excerpt.omittedPages,
                    })}
                  </span>
                )}
              </span>
            ) : status === "scanned" ? (
              <span className="rounded-full bg-amber-500/10 px-2 py-px text-[11px] font-medium text-amber-600 dark:text-amber-400">
                {t("summarize.noText")}
              </span>
            ) : status === "encrypted" ? (
              <span className="flex items-center gap-1 text-xs text-destructive">
                <Lock className="h-3 w-3" aria-hidden />
                {t("summarize.fileEncrypted")}
              </span>
            ) : status === "corrupt" ? (
              <span className="flex items-center gap-1 text-xs text-destructive">
                <AlertTriangle className="h-3 w-3" aria-hidden />
                {t("summarize.fileUnreadable")}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">
                {t("summarize.filePending")}
              </span>
            )}
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatBytes(f.file.size)}
          </span>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("summarize.removeFile")}
            className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-destructive"
            onClick={() => setFileOrder([])}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      </div>

      {/* Failure / scanned states */}
      {extraction === null && !ready && status !== "pending" && (
        <>
          {status === "scanned" && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-6 text-center">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-5 w-5" aria-hidden />
              </div>
              <p className="mt-3 text-sm font-medium">
                {t("summarize.scannedTitle")}
              </p>
              <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                {t("summarize.scannedBody")}
              </p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                {onChain && (
                  <Button size="sm" onClick={() => onChain("ocr-pdf")}>
                    <FileText className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                    {t("summarize.openOcr")}
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => setFileOrder([])}>
                  <FileUp className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  {t("summarize.chooseOther")}
                </Button>
              </div>
            </div>
          )}
          {(status === "encrypted" || status === "corrupt") && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                {status === "encrypted" ? (
                  <Lock className="h-5 w-5" aria-hidden />
                ) : (
                  <AlertTriangle className="h-5 w-5" aria-hidden />
                )}
              </div>
              <p className="mt-3 text-sm font-medium">
                {status === "encrypted"
                  ? t("summarize.errEncryptedTitle")
                  : t("summarize.errCorruptTitle")}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {status === "encrypted"
                  ? t("summarize.errEncryptedBody")
                  : t("summarize.errCorruptBody")}
              </p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRetryTick((n) => n + 1)}
                  disabled={pending}
                >
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  {t("summarize.retry")}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setFileOrder([])}>
                  <FileUp className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  {t("summarize.chooseOther")}
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Options + CTA */}
      {ready && (
        <div className="space-y-3 rounded-xl border border-border/70 bg-card p-4">
          <div>
            <p className="text-xs font-semibold text-foreground">
              {t("summarize.langLabel")}
            </p>
            <div
              role="radiogroup"
              aria-label={t("summarize.langLabel")}
              className="mt-1.5 grid grid-cols-2 gap-1.5"
            >
              {(["en", "hi"] as const).map((code) => (
                <button
                  key={code}
                  type="button"
                  role="radio"
                  aria-checked={language === code}
                  disabled={pending}
                  onClick={() => {
                    setLanguage(code);
                    setSummary(null);
                  }}
                  className={
                    language === code
                      ? "min-h-11 rounded-lg border border-primary/50 bg-primary/10 px-3 py-2 text-sm font-medium text-primary transition focus-visible:outline-2 focus-visible:outline-primary disabled:pointer-events-none disabled:opacity-50"
                      : "min-h-11 rounded-lg border border-border/70 bg-background/60 px-3 py-2 text-sm text-muted-foreground transition hover:border-primary/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary disabled:pointer-events-none disabled:opacity-50"
                  }
                >
                  {code === "en" ? "English" : "हिन्दी"}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground">
              {t("summarize.lengthLabel")}
            </p>
            <div
              role="radiogroup"
              aria-label={t("summarize.lengthLabel")}
              className="mt-1.5 grid grid-cols-3 gap-1.5"
            >
              {(["brief", "standard", "detailed"] as const).map((len) => (
                <button
                  key={len}
                  type="button"
                  role="radio"
                  aria-checked={length === len}
                  disabled={pending}
                  onClick={() => {
                    setLength(len);
                    setSummary(null);
                  }}
                  className={
                    length === len
                      ? "min-h-11 rounded-lg border border-primary/50 bg-primary/10 px-2 py-2 text-sm font-medium text-primary transition focus-visible:outline-2 focus-visible:outline-primary disabled:pointer-events-none disabled:opacity-50"
                      : "min-h-11 rounded-lg border border-border/70 bg-background/60 px-2 py-2 text-sm text-muted-foreground transition hover:border-primary/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary disabled:pointer-events-none disabled:opacity-50"
                  }
                >
                  {t(`summarize.len_${len}`)}
                </button>
              ))}
            </div>
          </div>
          <Button
            className="w-full"
            size="lg"
            disabled={pending}
            onClick={() => void summarize()}
          >
            {pending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                {t("summarize.pending")}
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-4 w-4" aria-hidden />
                {t("summarize.cta")}
              </>
            )}
          </Button>
          <p className="text-center text-[11px] text-muted-foreground">
            {t("summarize.disclaimer")}
          </p>
        </div>
      )}

      {/* Summary result */}
      {sections.length > 0 && (
        <div
          role="article"
          aria-label={t("summarize.resultLabel")}
          className="rounded-xl border border-border/70 bg-card"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 px-4 py-2.5">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden />
              {t("summarize.resultLabel")}
            </p>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                aria-label={t("summarize.copy")}
                onClick={() => void copySummary()}
              >
                {copied ? (
                  <>
                    <Check className="h-3 w-3" aria-hidden />
                    {t("summarize.copied")}
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" aria-hidden />
                    {t("summarize.copy")}
                  </>
                )}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                    aria-label={t("summarize.exportLabel")}
                    disabled={generatingPdf}
                  >
                    <Download className="mr-1 h-3 w-3" aria-hidden />
                    {t("summarize.exportLabel")}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => void exportPdf()}>
                    {generatingPdf
                      ? t("summarize.exportPdfBusy")
                      : t("summarize.exportPdf")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => exportText("md")}>
                    {t("summarize.exportMd")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => exportText("txt")}>
                    {t("summarize.exportTxt")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          <div className="space-y-5 p-4 sm:p-5">
            {sections.map((section, si) => {
              const Icon = SECTION_ICONS[section.key] ?? FileText;
              const label =
                section.key === "tldr"
                  ? t("summarize.secTldr")
                  : section.key === "keyPoints"
                    ? t("summarize.secKeyPoints")
                    : section.key === "actionItems"
                      ? t("summarize.secActionItems")
                      : section.key === "details"
                        ? t("summarize.secDetails")
                        : section.header;
              return (
                <section key={si} aria-label={label}>
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Icon className="h-4 w-4" aria-hidden />
                    </span>
                    {label}
                  </h3>
                  <div className="mt-2 space-y-2 pl-9 text-sm leading-relaxed text-foreground/90">
                    {section.paragraphs.map((p, pi) => (
                      <p key={pi} className="whitespace-pre-wrap">
                        {renderInline(p, `s${si}p${pi}`)}
                      </p>
                    ))}
                    {section.bullets.length > 0 && (
                      <ul className="space-y-1.5">
                        {section.bullets.map((b, bi) => (
                          <li
                            key={bi}
                            className="flex items-start gap-2"
                          >
                            <span
                              className="mt-2 size-1.5 shrink-0 rounded-full bg-primary/60"
                              aria-hidden
                            />
                            <span>{renderInline(b, `s${si}b${bi}`)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
