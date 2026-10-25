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
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { DropZone } from "@/components/doco/tool/drop-zone";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import { formatBytes } from "@/lib/storage/recent-files";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import {
  buildDocExcerpt,
  cleanUserText,
  isLikelyScanned,
  sanitizeChatMessages,
  type ChatMessage,
  type DocExcerpt,
  type ExtractedPage,
} from "./model";

/**
 * Chat with PDF (R8) — the workspace IS the tool (viewerOnly, like
 * view-pdf): no run step, no output file. Pipeline:
 *
 *   file → extraction worker (on-device, page-marked text)
 *        → buildDocExcerpt (bounded head+tail)
 *        → /api/chat (ONLY excerpt + visible history)
 *        → streamed-in answer bubbles with (p. N) citation chips.
 *
 * Hooks discipline (the R3 house rules): no setState during render —
 * refs are read inside callbacks and effects only; the file-keyed effect
 * depends on the file ID string, so parent re-renders with a rebuilt
 * files array never restart an in-flight extraction.
 */

type Extraction =
  | { status: "working"; page: number; total: number }
  | { status: "ready"; doc: DocExcerpt; pages: number }
  | { status: "scanned" }
  | { status: "failed"; code: "encrypted" | "corrupt" };

interface WorkerEvent {
  type?: string;
  page?: number;
  total?: number;
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

/** Markdown-lite inline: **bold** and (p. N) → citation chip. */
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

export function ChatSurface({
  files,
  setFileOrder,
  addFiles,
  onChain,
}: ToolSurfaceProps): ReactNode {
  const { t, locale } = useI18n();
  const { toast } = useToast();

  const fileRef = files[0] ?? null;
  const fileId = fileRef?.id ?? null;

  const [extraction, setExtraction] = useState<Extraction | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState(false);
  const [input, setInput] = useState("");
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const extractedIdRef = useRef<string | null>(null);
  const fileObjRef = useRef<File | null>(null);
  const inputElRef = useRef<HTMLTextAreaElement>(null);
  const listEndRef = useRef<HTMLDivElement>(null);

  /* ------------ extraction worker lifecycle (file-keyed) ------------ */

  /* Fresh file object after every render — declared BEFORE the extraction
     effect so a changed fileId always reads the new bytes (R3 rule: refs
     are written in effects, never during render). */
  useEffect(() => {
    fileObjRef.current = fileRef?.file ?? null;
  });

  useEffect(() => {
    if (fileId === null) {
      workerRef.current?.terminate();
      workerRef.current = null;
      extractedIdRef.current = null;
      setExtraction(null);
      setMessages([]);
      return;
    }
    if (extractedIdRef.current === fileId) return;
    extractedIdRef.current = fileId;
    const file = fileObjRef.current;
    if (!file) return;
    setMessages([]);
    setExtraction({ status: "working", page: 0, total: 0 });

    workerRef.current?.terminate();
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;

    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };

    worker.onmessage = (ev: MessageEvent<WorkerEvent>) => {
      const data = ev.data;
      if (data?.type === "progress") {
        setExtraction({
          status: "working",
          page: Number(data.page) || 0,
          total: Number(data.total) || 0,
        });
      } else if (data?.type === "pages" && Array.isArray(data.pages)) {
        const doc = buildDocExcerpt(data.pages);
        setExtraction(
          isLikelyScanned(data.pages)
            ? { status: "scanned" }
            : { status: "ready", doc, pages: doc.pagesTotal },
        );
        finish();
      } else if (data?.type === "error") {
        setExtraction({ status: "failed", code: data.code === "encrypted" ? "encrypted" : "corrupt" });
        finish();
      }
    };
    worker.onerror = () => {
      setExtraction({ status: "failed", code: "corrupt" });
      finish();
    };

    file
      .arrayBuffer()
      .then((buf) => {
        if (workerRef.current !== worker) return; // switched away already
        worker.postMessage({ type: "extract", file: buf }, [buf]);
      })
      .catch(() => {
        setExtraction({ status: "failed", code: "corrupt" });
        finish();
      });

    return () => {
      if (workerRef.current === worker) {
        workerRef.current = null;
        worker.terminate();
        // StrictMode double-mount / fast file switches: if this run was
        // torn down before its extraction settled, release the id guard
        // so the next mount of the SAME file re-runs instead of sitting
        // on a dead worker forever.
        if (extractedIdRef.current === fileId) {
          extractedIdRef.current = null;
        }
      }
    };
  }, [fileId]);

  /* Keep the newest answer in view (scroll, never setState-in-render). */
  useEffect(() => {
    listEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages, pending]);

  /* ------------------------- chat transport ------------------------- */

  const request = async (history: ChatMessage[]): Promise<void> => {
    const current = extraction;
    const docFile = fileObjRef.current;
    if (current?.status !== "ready" || !docFile) return;
    setPending(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: sanitizeChatMessages(history),
          docExcerpt: current.doc.excerpt,
          docName: docFile.name,
          locale,
        }),
      });
      const data: unknown = await res.json().catch(() => null);
      const answer = (data as { answer?: unknown } | null)?.answer;
      if (res.ok && typeof answer === "string" && answer.trim().length > 0) {
        setMessages((prev) => [...prev, { role: "assistant", content: answer.trim() }]);
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
    if (pending || extraction?.status !== "ready" || text.length === 0) return;
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

  const retryExtraction = (): void => {
    const file = fileObjRef.current;
    if (!file) return;
    setExtraction({ status: "working", page: 0, total: 0 });
    workerRef.current?.terminate();
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    worker.onmessage = (ev: MessageEvent<WorkerEvent>) => {
      const data = ev.data;
      if (data?.type === "progress") {
        setExtraction({
          status: "working",
          page: Number(data.page) || 0,
          total: Number(data.total) || 0,
        });
      } else if (data?.type === "pages" && Array.isArray(data.pages)) {
        const doc = buildDocExcerpt(data.pages);
        setExtraction(
          isLikelyScanned(data.pages)
            ? { status: "scanned" }
            : { status: "ready", doc, pages: doc.pagesTotal },
        );
        worker.terminate();
      } else if (data?.type === "error") {
        setExtraction({ status: "failed", code: data.code === "encrypted" ? "encrypted" : "corrupt" });
        worker.terminate();
      }
    };
    worker.onerror = () => {
      setExtraction({ status: "failed", code: "corrupt" });
      worker.terminate();
    };
    file
      .arrayBuffer()
      .then((buf) => {
        if (workerRef.current !== worker) return;
        worker.postMessage({ type: "extract", file: buf }, [buf]);
      })
      .catch(() => {
        setExtraction({ status: "failed", code: "corrupt" });
        worker.terminate();
      });
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

  if (!fileRef) {
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
          multiple={false}
          maxFiles={1}
          acceptKind="pdf"
          onAccept={addFiles}
          currentCount={0}
        />
      </div>
    );
  }

  const ready = extraction?.status === "ready";
  const trimmed =
    ready && extraction.doc.omittedPages > 0 ? extraction.doc : null;

  return (
    <div className="space-y-3">
      {/* Document header */}
      <div className="flex items-center gap-3 rounded-xl border border-border/70 bg-card p-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <FileText className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={fileRef.file.name}>
            {fileRef.file.name}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span>{formatBytes(fileRef.file.size)}</span>
            {extraction?.status === "ready" && (
              <>
                <span aria-hidden>·</span>
                <span>
                  {t("chat.docPages", {
                    count: (extraction as { status: "ready"; doc: DocExcerpt; pages: number }).pages,
                  })}
                </span>
                <span aria-hidden>·</span>
                <span>
                  {t("chat.docChars", {
                    count: (extraction as { status: "ready"; doc: DocExcerpt; pages: number }).doc.totalChars,
                  })}
                </span>
              </>
            )}
            {trimmed && (
              <span className="rounded-full bg-amber-500/10 px-2 py-px text-[11px] font-medium text-amber-600 dark:text-amber-400">
                {t("chat.pagesOmitted", { count: trimmed.omittedPages })}
              </span>
            )}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("chat.removeFile")}
          className="h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-destructive"
          onClick={() => setFileOrder([])}
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      {/* Extraction states */}
      {extraction?.status === "working" && (
        <div className="rounded-xl border border-border/70 bg-card p-6 text-center">
          <Loader2
            className="mx-auto h-6 w-6 animate-spin text-primary"
            aria-hidden
          />
          <p className="mt-3 text-sm font-medium">
            {extraction.total > 0
              ? t("chat.extractingPage", {
                  page: extraction.page,
                  total: extraction.total,
                })
              : t("chat.extracting")}
          </p>
          {extraction.total > 0 && (
            <div className="mx-auto mt-3 h-1.5 w-48 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{
                  width: `${Math.min(100, Math.round((extraction.page / extraction.total) * 100))}%`,
                }}
              />
            </div>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            {t("chat.deviceOnly")}
          </p>
        </div>
      )}

      {extraction?.status === "failed" && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            {extraction.code === "encrypted" ? (
              <Lock className="h-5 w-5" aria-hidden />
            ) : (
              <AlertTriangle className="h-5 w-5" aria-hidden />
            )}
          </div>
          <p className="mt-3 text-sm font-medium">
            {extraction.code === "encrypted"
              ? t("chat.errEncryptedTitle")
              : t("chat.errCorruptTitle")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {extraction.code === "encrypted"
              ? t("chat.errEncryptedBody")
              : t("chat.errCorruptBody")}
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={retryExtraction}
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

      {extraction?.status === "scanned" && (
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

      {/* Chat panel */}
      {ready && (
        <div className="flex flex-col rounded-xl border border-border/70 bg-card">
          {messages.length === 0 ? (
            <div className="p-4 sm:p-6">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" aria-hidden />
                <p className="text-sm font-medium">{t("chat.askAnything")}</p>
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
              {messages.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground"
                  onClick={() => setMessages([])}
                >
                  <RefreshCw className="mr-1 h-3 w-3" aria-hidden />
                  {t("chat.newChat")}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
