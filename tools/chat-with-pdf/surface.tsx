"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  Bot,
  CalendarClock,
  Check,
  ClipboardCheck,
  Copy,
  Download,
  FileText,
  FileUp,
  Lightbulb,
  ListChecks,
  Loader2,
  Lock,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

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
  buildChatExport,
  buildMultiDocExcerpt,
  chatExportBaseName,
  cleanDocName,
  cleanUserText,
  isLikelyScanned,
  sanitizeChatMessages,
  type ChatDoc,
  type ChatExportFormat,
  type ChatExportLabels,
  type ChatMessage,
  type ExtractedPage,
  type MultiDocExcerpt,
} from "./model";

/**
 * Chat with PDF (R8, R9-a export, R9-b multi-file) — the workspace IS the
 * tool (viewerOnly, like view-pdf): no run step, no output file. Pipeline:
 *
 *   files (1..5) → extraction worker (on-device, page-marked text,
 *                  one file at a time, index-tagged events)
 *               → buildMultiDocExcerpt (even budget split + honest
 *                  redistribution, === FILE "name" === sections)
 *               → /api/chat (ONLY excerpt + visible history + docCount)
 *               → answer bubbles with (p. N) and ("name" p. N) chips.
 *
 * Hooks discipline (the R3 house rules): no setState during render —
 * refs are read inside callbacks and effects only; the extraction effect
 * depends on the file-set SIGNATURE (ids joined), so parent re-renders
 * with a rebuilt files array never restart an in-flight extraction.
 */

type FileStatus = "pending" | "ready" | "scanned" | "encrypted" | "corrupt";

interface WorkingExtraction {
  state: "working";
  fileIndex: number;
  fileCount: number;
  page: number;
  total: number;
}

interface WorkerEvent {
  type?: string;
  page?: number;
  total?: number;
  index?: number;
  pages?: ExtractedPage[];
  code?: "encrypted" | "corrupt";
}

const QUICK_PROMPTS = [
  { id: "summarize", icon: FileText },
  { id: "keyPoints", icon: ListChecks },
  { id: "actionItems", icon: ClipboardCheck },
  { id: "explainSimple", icon: Lightbulb },
  { id: "extractDates", icon: CalendarClock },
] as const;

/** Markdown-lite inline: **bold**, (p. N) and ("name" p. N) citation chips. */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern =
    /\*\*([^*]+)\*\*|\("([^"]+)"\s*p\.\s*(\d+)\)|\(p\.\s*(\d+)\)/g;
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
          key={`${keyBase}-fc${n}`}
          title={m[2]}
          className="mx-0.5 inline-flex max-w-[13rem] items-center gap-1 truncate rounded-full bg-primary/10 px-1.5 py-px text-[11px] font-semibold text-primary"
        >
          <span className="truncate">{m[2]}</span>
          <span aria-hidden>·</span>
          <span>p.&nbsp;{m[3]}</span>
        </span>,
      );
    } else if (m[4] !== undefined) {
      nodes.push(
        <span
          key={`${keyBase}-c${n}`}
          className="mx-0.5 inline-flex items-center rounded-full bg-primary/10 px-1.5 py-px text-[11px] font-semibold text-primary"
        >
          p.&nbsp;{m[4]}
        </span>,
      );
    }
    last = m.index + m[0].length;
    n += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Block-level answer body: paragraphs, bullet lists, numbered lists. */
function AnswerBody({ content }: { content: string }): ReactNode {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let buf: string[] = [];
  let key = 0;

  const flushParagraph = (): void => {
    if (buf.length === 0) return;
    const text = buf.join(" ").trim();
    buf = [];
    if (text.length === 0) return;
    blocks.push(
      <p key={`p${key++}`} className="whitespace-pre-wrap">
        {renderInline(text, `p${key}`)}
      </p>,
    );
  };

  let listItems: { text: string; ordered: boolean }[] = [];
  const flushList = (): void => {
    if (listItems.length === 0) return;
    const ordered = listItems[0].ordered;
    const items = listItems.map((li, i) => (
      <li key={`li${key}-${i}`} className="pl-1">
        {renderInline(li.text, `li${key}-${i}`)}
      </li>
    ));
    listItems = [];
    blocks.push(
      ordered ? (
        <ol key={`ol${key++}`} className="ml-4 list-decimal space-y-1">
          {items}
        </ol>
      ) : (
        <ul key={`ul${key++}`} className="ml-4 list-disc space-y-1">
          {items}
        </ul>
      ),
    );
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim().length === 0) {
      flushParagraph();
      flushList();
      continue;
    }
    const bullet = /^(?:[-*•])\s+(.*)$/.exec(line.trim());
    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(line.trim());
    if (bullet) {
      flushParagraph();
      listItems.push({ text: bullet[1], ordered: false });
    } else if (numbered) {
      flushParagraph();
      listItems.push({ text: numbered[2], ordered: true });
    } else {
      flushList();
      buf.push(line);
    }
  }
  flushParagraph();
  flushList();
  return <div className="space-y-2 text-sm leading-relaxed">{blocks}</div>;
}

const MAX_CHAT_FILES = 5;

export function ChatSurface({
  files,
  setFileOrder,
  addFiles,
  onChain,
}: ToolSurfaceProps): ReactNode {
  const { t, locale } = useI18n();
  const { toast } = useToast();

  const filesSig = files.map((f) => f.id).join("|");

  const [extraction, setExtraction] = useState<WorkingExtraction | null>(null);
  const [statuses, setStatuses] = useState<FileStatus[]>([]);
  const [multi, setMulti] = useState<MultiDocExcerpt | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState(false);
  const [input, setInput] = useState("");
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  const workerRef = useRef<Worker | null>(null);
  const filesRef = useRef(files);
  const ranSigRef = useRef<string | null>(null);
  const inputElRef = useRef<HTMLTextAreaElement>(null);
  const listEndRef = useRef<HTMLDivElement>(null);

  /* Fresh file array after every render — declared BEFORE the extraction
     effect so a changed signature always reads the new File objects (R3
     rule: refs are written in effects, never during render). */
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
      setStatuses([]);
      setMulti(null);
      setMessages([]);
      return;
    }
    if (ranSigRef.current === sig) return;
    ranSigRef.current = sig;

    const currentFiles = filesRef.current.slice(0, MAX_CHAT_FILES);
    setMessages([]);
    setMulti(null);
    setStatuses(currentFiles.map(() => "pending" as FileStatus));
    setExtraction({
      state: "working",
      fileIndex: 0,
      fileCount: currentFiles.length,
      page: 0,
      total: 0,
    });

    workerRef.current?.terminate();
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    let cancelled = false;

    const finish = (): void => {
      if (workerRef.current === worker) workerRef.current = null;
      worker.terminate();
    };

    /** Extract one file; resolves with its pages or an honest failure. */
    const extractOne = (
      index: number,
    ): Promise<
      { pages: ExtractedPage[] } | { code: "encrypted" | "corrupt" }
    > =>
      new Promise((resolve) => {
        const onMsg = (ev: MessageEvent<WorkerEvent>): void => {
          const data = ev.data;
          if (data?.index !== index) return;
          if (data.type === "progress") {
            setExtraction({
              state: "working",
              fileIndex: index,
              fileCount: currentFiles.length,
              page: Number(data.page) || 0,
              total: Number(data.total) || 0,
            });
          } else if (data.type === "pages" && Array.isArray(data.pages)) {
            worker.removeEventListener("message", onMsg);
            resolve({ pages: data.pages });
          } else if (data.type === "error") {
            worker.removeEventListener("message", onMsg);
            resolve({ code: data.code === "encrypted" ? "encrypted" : "corrupt" });
          }
        };
        worker.addEventListener("message", onMsg);
        const file = currentFiles[index]?.file;
        if (!file) {
          worker.removeEventListener("message", onMsg);
          resolve({ code: "corrupt" });
          return;
        }
        file
          .arrayBuffer()
          .then((buf) => {
            if (cancelled) {
              worker.removeEventListener("message", onMsg);
              resolve({ code: "corrupt" });
              return;
            }
            worker.postMessage(
              { type: "extract", file: buf, index },
              [buf],
            );
          })
          .catch(() => {
            worker.removeEventListener("message", onMsg);
            resolve({ code: "corrupt" });
          });
      });

    const run = async (): Promise<void> => {
      const nextStatuses: FileStatus[] = currentFiles.map(() => "pending");
      const docs: ChatDoc[] = [];
      for (let i = 0; i < currentFiles.length; i += 1) {
        const res = await extractOne(i);
        if (cancelled) return;
        if ("pages" in res) {
          const scanned = isLikelyScanned(res.pages);
          nextStatuses[i] = scanned ? "scanned" : "ready";
          if (!scanned) {
            docs.push({ name: currentFiles[i].file.name, pages: res.pages });
          }
        } else {
          nextStatuses[i] = res.code;
        }
        setStatuses([...nextStatuses]);
      }
      if (cancelled) return;
      setMulti(docs.length > 0 ? buildMultiDocExcerpt(docs) : null);
      setExtraction(null);
      finish();
    };

    void run();

    return () => {
      cancelled = true;
      if (workerRef.current === worker) {
        workerRef.current = null;
        worker.terminate();
        // StrictMode double-mount / fast file switches: if this run was
        // torn down before its extraction settled, release the sig guard
        // so the next mount of the SAME file set re-runs instead of
        // sitting on a dead worker forever.
        if (ranSigRef.current === sig) {
          ranSigRef.current = null;
        }
      }
    };
  }, [filesSig, retryTick]);

  /* Keep the newest answer in view (scroll, never setState-in-render). */
  useEffect(() => {
    listEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages, pending]);

  /* ------------------------- chat transport ------------------------- */

  const request = async (history: ChatMessage[]): Promise<void> => {
    const current = multi;
    if (current === null) return;
    const readyCount = statuses.filter((s) => s === "ready").length;
    const docNames = filesRef.current
      .filter((_, i) => statuses[i] === "ready")
      .map((f) => f.file.name);
    setPending(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: sanitizeChatMessages(history),
          docExcerpt: current.excerpt,
          docName: readyCount === 1 ? docNames[0] : undefined,
          docCount: Math.max(1, readyCount),
          locale,
        }),
      });
      const data: unknown = await res.json().catch(() => null);
      const answer = (data as { answer?: unknown } | null)?.answer;
      if (res.ok && typeof answer === "string" && answer.trim().length > 0) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: answer.trim() },
        ]);
      } else {
        const code = (data as { error?: unknown } | null)?.error;
        toast({
          title: t("chat.errTitle"),
          description:
            code === "timeout"
              ? t("chat.errTimeout")
              : code === "badRequest"
                ? t("chat.errBadRequest")
                : t("chat.errSend"),
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: t("chat.errTitle"),
        description: t("chat.errSend"),
        variant: "destructive",
      });
    } finally {
      setPending(false);
    }
  };

  const send = (raw: string): void => {
    const text = cleanUserText(raw);
    if (pending || multi === null || text.length === 0) return;
    const next = sanitizeChatMessages([...messages, { role: "user", content: text }]);
    setMessages(next);
    setInput("");
    const el = inputElRef.current;
    if (el) el.style.height = "auto";
    void request(next);
  };

  const regenerate = (): void => {
    if (pending) return;
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "user") {
        lastUser = i;
        break;
      }
    }
    if (lastUser === -1) return;
    const next = messages.slice(0, lastUser + 1);
    setMessages(next);
    void request(next);
  };

  /* --------------------------- R9-a: export ------------------------- */

  const exportChat = (format: ChatExportFormat): void => {
    if (messages.length === 0) return;
    const labels: ChatExportLabels = {
      title: t("chat.exportFileTitle"),
      document: t("chat.exportDocumentLabel"),
      generated: t("chat.exportGenerated"),
      you: t("chat.youLabel"),
      ai: t("chat.aiLabel"),
    };
    const text = buildChatExport(
      messages,
      filesRef.current.map((f) => f.file.name),
      labels,
      format,
    );
    if (text.length === 0) return;
    const blob = new Blob([text], {
      type: format === "markdown" ? "text/markdown" : "text/plain",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${chatExportBaseName(
      filesRef.current.map((f) => f.file.name),
    )}-chat.${format === "markdown" ? "md" : "txt"}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast({ title: t("chat.exportDone") });
  };

  const copyAnswer = async (index: number, content: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedIdx(index);
      window.setTimeout(() => {
        setCopiedIdx((cur) => (cur === index ? null : cur));
      }, 1600);
    } catch {
      toast({ title: t("chat.errTitle"), description: t("chat.errSend") });
    }
  };

  const onKeyDown = (ev: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      send(input);
    }
  };

  const autoGrow = (): void => {
    const el = inputElRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  /* ------------------------------ render ---------------------------- */

  if (files.length === 0) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-border/70 bg-gradient-to-b from-primary/5 to-transparent p-6 text-center sm:p-8">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Bot className="h-6 w-6" aria-hidden />
          </div>
          <h2 className="mt-4 text-lg font-semibold">{t("chat.heroTitle")}</h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            {t("chat.heroBody")}
          </p>
          <div className="mx-auto mt-4 flex max-w-md flex-wrap items-center justify-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden />
            <span className="text-xs text-muted-foreground">
              {t("chat.heroFree")}
            </span>
          </div>
        </div>
        <DropZone
          labelKey="chat.dropHere"
          multiple
          maxFiles={MAX_CHAT_FILES}
          acceptKind="pdf"
          onAccept={addFiles}
          currentCount={0}
        />
        <p className="text-center text-xs text-muted-foreground">
          {t("chat.multiHint")}
        </p>
      </div>
    );
  }

  const ready = multi !== null;
  const noTextCount = statuses.filter((s) => s === "scanned").length;
  const anyEncrypted = statuses.includes("encrypted");
  const anyCorrupt = statuses.includes("corrupt");
  const firstFailureCode: "encrypted" | "corrupt" | null = anyEncrypted
    ? "encrypted"
    : anyCorrupt
      ? "corrupt"
      : null;

  const statusLine = (i: number): ReactNode => {
    const st = statuses[i] ?? "pending";
    const working =
      extraction?.state === "working" && extraction.fileIndex === i;
    if (working) {
      return (
        <span className="flex items-center gap-1.5 text-xs text-primary">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          {extraction.total > 0
            ? t("chat.extractingPage", {
                page: extraction.page,
                total: extraction.total,
              })
            : t("chat.extracting")}
        </span>
      );
    }
    if (st === "ready") {
      const entry = multi?.docs.find(
        (d) => d.name === cleanDocName(files[i].file.name),
      );
      if (entry) {
        return (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span>
              {t("chat.docPages", { count: entry.pagesTotal })}
            </span>
            <span aria-hidden>·</span>
            <span>
              {t("chat.docChars", { count: entry.totalChars })}
            </span>
            {entry.omittedPages > 0 && (
              <span className="rounded-full bg-amber-500/10 px-2 py-px text-[11px] font-medium text-amber-600 dark:text-amber-400">
                {t("chat.pagesOmitted", { count: entry.omittedPages })}
              </span>
            )}
          </span>
        );
      }
      return (
        <span className="text-xs text-muted-foreground">
          {t("chat.fileReady")}
        </span>
      );
    }
    if (st === "scanned") {
      return (
        <span className="rounded-full bg-amber-500/10 px-2 py-px text-[11px] font-medium text-amber-600 dark:text-amber-400">
          {t("chat.fileNoText")}
        </span>
      );
    }
    if (st === "encrypted") {
      return (
        <span className="flex items-center gap-1 text-xs text-destructive">
          <Lock className="h-3 w-3" aria-hidden />
          {t("chat.fileEncrypted")}
        </span>
      );
    }
    if (st === "corrupt") {
      return (
        <span className="flex items-center gap-1 text-xs text-destructive">
          <AlertTriangle className="h-3 w-3" aria-hidden />
          {t("chat.fileUnreadable")}
        </span>
      );
    }
    return (
      <span className="text-xs text-muted-foreground">{t("chat.filePending")}</span>
    );
  };

  return (
    <div className="space-y-3">
      {/* Document list */}
      <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
        <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1.5">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <FileText className="h-3.5 w-3.5 text-primary" aria-hidden />
            {t("chat.docsLabel", { count: files.length })}
          </p>
          {extraction === null && files.length > 1 && (
            <p className="text-[11px] text-muted-foreground">
              {t("chat.docPages", { count: multi?.pagesIncluded ?? 0 })}
            </p>
          )}
        </div>
        <div className="divide-y divide-border/60">
          {files.map((f, i) => (
            <div key={f.id} className="flex items-center gap-2.5 px-3 py-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <FileText className="h-4 w-4" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={f.file.name}>
                  {f.file.name}
                </p>
                <p className="mt-0.5">{statusLine(i)}</p>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatBytes(f.file.size)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t("chat.removeFile")}
                className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                onClick={() =>
                  setFileOrder(files.filter((x) => x.id !== f.id))
                }
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>
          ))}
        </div>
      </div>

      {/* Add-more zone (still under the file cap) */}
      {files.length < MAX_CHAT_FILES && (
        <DropZone
          labelKey="chat.addMore"
          multiple
          maxFiles={MAX_CHAT_FILES}
          acceptKind="pdf"
          onAccept={addFiles}
          currentCount={files.length}
        />
      )}

      {/* Extraction overall progress */}
      {extraction?.state === "working" && (
        <div className="rounded-xl border border-border/70 bg-card px-4 py-3">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden />
            {t("chat.extractionFile", {
              index: extraction.fileIndex + 1,
              count: extraction.fileCount,
            })}
          </p>
          {extraction.total > 0 && (
            <div className="mx-auto mt-2.5 h-1.5 w-48 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{
                  width: `${Math.min(
                    100,
                    Math.round((extraction.page / extraction.total) * 100),
                  )}%`,
                }}
              />
            </div>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            {t("chat.deviceOnly")}
          </p>
        </div>
      )}

      {/* Failure / scanned states — only when NOTHING was extracted */}
      {extraction === null && !ready && (
        <>
          {noTextCount > 0 && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-6 text-center">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-5 w-5" aria-hidden />
              </div>
              <p className="mt-3 text-sm font-medium">
                {t("chat.scannedTitle")}
              </p>
              <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                {t("chat.scannedBody")}
              </p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                {onChain && (
                  <Button size="sm" onClick={() => onChain("ocr-pdf")}>
                    <FileText className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                    {t("chat.openOcr")}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setFileOrder([])}
                >
                  <FileUp className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  {t("chat.chooseOther")}
                </Button>
              </div>
            </div>
          )}
          {noTextCount === 0 && firstFailureCode !== null && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                {firstFailureCode === "encrypted" ? (
                  <Lock className="h-5 w-5" aria-hidden />
                ) : (
                  <AlertTriangle className="h-5 w-5" aria-hidden />
                )}
              </div>
              <p className="mt-3 text-sm font-medium">
                {firstFailureCode === "encrypted"
                  ? t("chat.errEncryptedTitle")
                  : t("chat.errCorruptTitle")}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {firstFailureCode === "encrypted"
                  ? t("chat.errEncryptedBody")
                  : t("chat.errCorruptBody")}
              </p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRetryTick((n) => n + 1)}
                  disabled={pending}
                >
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  {t("chat.retry")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setFileOrder([])}
                >
                  <FileUp className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  {t("chat.chooseOther")}
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Chat panel */}
      {ready && (
        <div className="flex flex-col rounded-xl border border-border/70 bg-card">
          {messages.length === 0 ? (
            <div className="p-4 sm:p-6">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" aria-hidden />
                <p className="text-sm font-medium">{t("chat.askAnything")}</p>
                {noTextCount > 0 && (
                  <span className="rounded-full bg-amber-500/10 px-2 py-px text-[11px] font-medium text-amber-600 dark:text-amber-400">
                    {t("chat.someNoText", { count: noTextCount })}
                  </span>
                )}
              </div>
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {QUICK_PROMPTS.map(({ id, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    disabled={pending}
                    onClick={() => send(t(`chat.qp.${id}.prompt`))}
                    className="flex items-start gap-2.5 rounded-lg border border-border/70 bg-background/60 p-3 text-left transition hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-primary disabled:pointer-events-none disabled:opacity-50"
                  >
                    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                    <span className="text-sm">{t(`chat.qp.${id}.label`)}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div
              role="log"
              aria-live="polite"
              aria-label={t("chat.messagesLabel")}
              className="scrollbar-thin max-h-[min(58vh,28rem)] space-y-3 overflow-y-auto p-4"
            >
              {messages.map((m, i) => (
                <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                  {m.role === "user" ? (
                    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-sm text-primary-foreground">
                      <p className="whitespace-pre-wrap break-words">{m.content}</p>
                    </div>
                  ) : (
                    <div className="group max-w-[92%] rounded-2xl rounded-bl-md bg-muted px-3.5 py-2.5">
                      <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        <Bot className="h-3 w-3" aria-hidden />
                        {t("chat.aiLabel")}
                      </p>
                      <AnswerBody content={m.content} />
                      <div className="mt-1.5 flex items-center gap-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                          aria-label={t("chat.copy")}
                          onClick={() => void copyAnswer(i, m.content)}
                        >
                          {copiedIdx === i ? (
                            <>
                              <Check className="h-3 w-3" aria-hidden />
                              {t("chat.copied")}
                            </>
                          ) : (
                            <>
                              <Copy className="h-3 w-3" aria-hidden />
                              {t("chat.copy")}
                            </>
                          )}
                        </Button>
                        {i === messages.length - 1 && !pending && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                            aria-label={t("chat.regenerate")}
                            onClick={regenerate}
                          >
                            <RefreshCw className="h-3 w-3" aria-hidden />
                            {t("chat.regenerate")}
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {pending && (
                <div className="flex justify-start">
                  <div className="flex items-center gap-2 rounded-2xl rounded-bl-md bg-muted px-3.5 py-3">
                    <span className="flex gap-1" aria-hidden>
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:0ms]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:150ms]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:300ms]" />
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t("chat.thinking")}
                    </span>
                  </div>
                </div>
              )}
              <div ref={listEndRef} />
            </div>
          )}

          {/* Composer */}
          <div className="border-t border-border/70 p-3">
            {messages.length > 0 && (
              <div className="scrollbar-thin mb-2 flex gap-1.5 overflow-x-auto pb-1">
                {QUICK_PROMPTS.map(({ id, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    disabled={pending}
                    onClick={() => send(t(`chat.qp.${id}.prompt`))}
                    className="flex shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-background px-2.5 py-1 text-xs text-muted-foreground transition hover:border-primary/40 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                  >
                    <Icon className="h-3 w-3 text-primary" aria-hidden />
                    {t(`chat.qp.${id}.label`)}
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2">
              <label className="sr-only" htmlFor="chat-input">
                {t("chat.placeholder")}
              </label>
              <textarea
                id="chat-input"
                ref={inputElRef}
                value={input}
                rows={1}
                placeholder={t("chat.placeholder")}
                disabled={pending}
                className="scrollbar-thin max-h-40 min-h-[2.75rem] flex-1 resize-none rounded-xl border border-border/70 bg-background px-3.5 py-2.5 text-sm outline-none transition focus:border-primary/50 focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
                onChange={(e) => {
                  setInput(e.target.value);
                  autoGrow();
                }}
                onKeyDown={onKeyDown}
              />
              <Button
                size="sm"
                className="h-11 w-11 shrink-0 p-0"
                aria-label={t("chat.send")}
                disabled={pending || input.trim().length === 0}
                onClick={() => send(input)}
              >
                {pending ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Send className="h-4 w-4" aria-hidden />
                )}
              </Button>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] text-muted-foreground">
                {t("chat.disclaimer")}
              </p>
              <div className="flex items-center gap-1">
                {messages.length > 0 && (
                  <>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                          aria-label={t("chat.exportLabel")}
                        >
                          <Download className="mr-1 h-3 w-3" aria-hidden />
                          {t("chat.exportLabel")}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => exportChat("markdown")}
                        >
                          {t("chat.exportMd")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => exportChat("txt")}>
                          {t("chat.exportTxt")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-muted-foreground"
                      onClick={() => setMessages([])}
                    >
                      <RefreshCw className="mr-1 h-3 w-3" aria-hidden />
                      {t("chat.newChat")}
                    </Button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
