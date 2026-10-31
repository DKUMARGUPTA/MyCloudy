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
  ArrowRight,
  BookOpen,
  Check,
  Copy,
  FileSearch,
  FileUp,
  Loader2,
  Lock,
  Search,
  ScanText,
  ShieldAlert,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { DropZone } from "@/components/doco/tool/drop-zone";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import { formatBytes } from "@/lib/storage/recent-files";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";

/**
 * Ask PDF (chat-with-pdf, P2 / R54) — REBUILT self-dependent: BM25 smart
 * search, 100% on-device. No LLM, no provider, no network call — the
 * workspace surface IS the tool (viewerOnly, like view-pdf):
 *
 *   file → extraction worker (on-device text, page by page)
 *        → BM25 passage index (in worker memory)
 *        → query → ranked snippet cards with page badges + highlights.
 *
 * Search-grade, honestly named: every result is an exact sentence from
 * the document, ranked by BM25 — never rewritten, never invented.
 * Hooks discipline (R3 house rules): no setState during render; the
 * extraction effect keys on the file-set signature.
 */

type Phase = "empty" | "extracting" | "ready" | "encrypted" | "corrupt" | "noText";

interface WorkerEvent {
  type?: string;
  page?: number;
  total?: number;
  pages?: number;
  passages?: number;
  chars?: number;
  results?: SearchHitWire[];
  query?: string;
  code?: string;
}

/** Shape the worker posts (kept structural — no class instances). */
interface SearchHitWire {
  passageId: number;
  page: number;
  text: string;
  score: number;
}

interface QuickChip {
  id: string;
  icon: typeof Search;
}

const QUICK_CHIPS: QuickChip[] = [
  { id: "chipSummary", icon: BookOpen },
  { id: "chipDates", icon: Sparkles },
  { id: "chipNumbers", icon: FileSearch },
  { id: "chipNames", icon: ScanText },
];

/** BM25 score → 0..100% relative to the top hit (display only). */
function relevancePct(score: number, top: number): number {
  if (top <= 0) return 0;
  return Math.max(4, Math.round((score / top) * 100));
}

export function AskPdfSurface({
  files,
  addFiles,
  onChain,
}: ToolSurfaceProps): ReactNode {
  const { t } = useI18n();
  const { toast } = useToast();

  const filesSig = files.map((f) => f.id).join("|");

  const [phase, setPhase] = useState<Phase>("empty");
  const [progress, setProgress] = useState({ page: 0, total: 0 });
  const [stats, setStats] = useState({ pages: 0, passages: 0, chars: 0 });
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchHitWire[] | null>(null);
  const [lastQuery, setLastQuery] = useState("");
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const ranSigRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /* ---------- extraction + index lifecycle (signature-keyed) ----------
   *
   * The effect RETURNS a cleanup that terminates the worker it created and
   * clears the signature ref — so React StrictMode's dev double-mount
   * (effect → cleanup → effect) recreates the worker instead of leaving a
   * dead one behind the early-return guard. Same discipline for every
   * later signature change: previous worker torn down, fresh one starts.
   */

  useEffect(() => {
    if (files.length === 0) {
      workerRef.current?.terminate();
      workerRef.current = null;
      ranSigRef.current = null;
      setPhase("empty");
      setProgress({ page: 0, total: 0 });
      setStats({ pages: 0, passages: 0, chars: 0 });
      setResults(null);
      setLastQuery("");
      setQuery("");
      return;
    }
    const sig = filesSig;
    if (ranSigRef.current === sig) return;
    ranSigRef.current = sig;

    const file = files[0]?.file;
    if (!file) return;

    setPhase("extracting");
    setProgress({ page: 0, total: 0 });
    setResults(null);
    setLastQuery("");
    setQuery("");

    workerRef.current?.terminate();
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;

    worker.addEventListener("message", (ev: MessageEvent<WorkerEvent>) => {
      const data = ev.data;
      if (data?.type === "progress") {
        setProgress({
          page: Number(data.page) || 0,
          total: Number(data.total) || 0,
        });
      } else if (data?.type === "indexed") {
        setStats({
          pages: Number(data.pages) || 0,
          passages: Number(data.passages) || 0,
          chars: Number(data.chars) || 0,
        });
        setPhase("ready");
        // Autofocus the search box the moment the index is live.
        requestAnimationFrame(() => inputRef.current?.focus());
      } else if (data?.type === "results") {
        setResults(Array.isArray(data.results) ? data.results : []);
        setLastQuery(String(data.query ?? ""));
        setSearching(false);
      } else if (data?.type === "error") {
        if (data.code === "noText") setPhase("noText");
        else if (data.code === "encrypted") setPhase("encrypted");
        else setPhase("corrupt");
      }
    });

    file
      .arrayBuffer()
      .then((buf) => {
        worker.postMessage({ type: "extract", file: buf }, [buf]);
      })
      .catch(() => setPhase("corrupt"));

    return () => {
      // StrictMode-safe teardown: allow the next effect run (remount or
      // file-id change) to recreate the worker instead of leaving a dead
      // one behind the ranSigRef early-return guard.
      ranSigRef.current = null;
      if (workerRef.current === worker) workerRef.current = null;
      worker.terminate();
    };
  }, [filesSig, files]);

  /* ----------------------------- search ------------------------------ */

  const runSearch = (raw: string): void => {
    const q = raw.trim();
    if (q.length === 0 || phase !== "ready" || !workerRef.current) return;
    setSearching(true);
    setQuery(q);
    setCopiedIdx(null);
    workerRef.current.postMessage({ type: "search", query: q });
  };

  const onSearchKey = (ev: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      runSearch(query);
    }
  };

  const copyPassage = async (text: string, idx: number): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      window.setTimeout(() => setCopiedIdx(null), 1600);
    } catch {
      toast({ title: t("ask.copyFailed"), variant: "destructive" });
    }
  };

  /* ------------------------------ views ------------------------------ */

  const file = files[0]?.file;

  if (phase === "empty") {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
          <FileSearch className="h-7 w-7 text-primary" aria-hidden />
        </div>
        <div className="space-y-1 text-center">
          <h2 className="text-lg font-semibold">{t("ask.heroTitle")}</h2>
          <p className="text-sm text-muted-foreground">{t("ask.heroSub")}</p>
        </div>
        <DropZone
          labelKey="ask.dropHere"
          multiple={false}
          maxFiles={1}
          acceptKind="pdf"
          onAccept={addFiles}
          currentCount={0}
        />
        <p className="text-center text-xs text-muted-foreground">
          {t("ask.privacyNote")}
        </p>
      </div>
    );
  }

  if (phase === "extracting") {
    const pct =
      progress.total > 0
        ? Math.round((progress.page / progress.total) * 100)
        : 8;
    return (
      <div className="mx-auto w-full max-w-xl space-y-4">
        <div className="rounded-xl border bg-card p-6">
          <div className="flex items-center gap-3">
            <Loader2
              className="h-5 w-5 shrink-0 animate-spin text-primary"
              aria-hidden
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{file?.name}</p>
              <p className="text-xs text-muted-foreground">
                {progress.total > 0
                  ? t("ask.readingPages", {
                      page: String(progress.page),
                      pages: String(progress.total),
                    })
                  : t("ask.opening")}
              </p>
            </div>
          </div>
          <Progress value={pct} className="mt-4 h-1.5" aria-label={t("ask.readingAria")} />
        </div>
      </div>
    );
  }

  if (phase === "noText" || phase === "encrypted" || phase === "corrupt") {
    const isScan = phase === "noText";
    const isLock = phase === "encrypted";
    const Icon = isScan ? ScanText : isLock ? Lock : ShieldAlert;
    const titleKey = isScan
      ? "ask.noTextTitle"
      : isLock
        ? "ask.errEncryptedTitle"
        : "ask.errCorruptTitle";
    const bodyKey = isScan
      ? "ask.noTextBody"
      : isLock
        ? "ask.errEncryptedBody"
        : "ask.errCorruptBody";
    return (
      <div className="mx-auto w-full max-w-xl">
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <Icon className="h-6 w-6 text-destructive" aria-hidden />
          </div>
          <h3 className="mt-3 text-sm font-semibold">{t(titleKey)}</h3>
          <p className="mt-1.5 text-sm text-muted-foreground">{t(bodyKey)}</p>
          {isScan && onChain && (
            <Button
              size="sm"
              variant="outline"
              className="mt-4"
              onClick={() => onChain("ocr-pdf")}
            >
              <ScanText className="h-4 w-4" aria-hidden />
              {t("ask.goOcr")}
            </Button>
          )}
        </div>
      </div>
    );
  }

  /* phase === "ready" — the search surface */
  const top = results && results.length > 0 ? results[0]!.score : 0;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      {/* Document header */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <FileSearch className="h-4.5 w-4.5 text-primary" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{file?.name}</p>
            <p className="text-xs text-muted-foreground">
              {t("ask.indexedLine", {
                pages: String(stats.pages),
                passages: String(stats.passages),
              })}
              {file ? ` · ${formatBytes(file.size)}` : ""}
            </p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
          <Check className="h-3 w-3" aria-hidden />
          {t("ask.readyBadge")}
        </span>
      </div>

      {/* Search box */}
      <form
        className="flex gap-2"
        onSubmit={(ev) => {
          ev.preventDefault();
          runSearch(query);
        }}
      >
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            ref={inputRef}
            value={query}
            onChange={(ev) => setQuery(ev.target.value)}
            onKeyDown={onSearchKey}
            placeholder={t("ask.placeholder")}
            aria-label={t("ask.placeholder")}
            className="pl-9"
            maxLength={200}
          />
        </div>
        <Button type="submit" disabled={query.trim().length === 0 || searching}>
          {searching ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Search className="h-4 w-4" aria-hidden />
          )}
          <span className="hidden sm:inline">{t("ask.searchButton")}</span>
        </Button>
      </form>

      {/* Quick chips (before first search) */}
      {results === null && !searching && (
        <div className="flex flex-wrap gap-2">
          {QUICK_CHIPS.map((chip) => (
            <button
              key={chip.id}
              type="button"
              onClick={() => runSearch(t(`ask.${chip.id}`))}
              className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary"
            >
              <chip.icon className="h-3.5 w-3.5" aria-hidden />
              {t(`ask.${chip.id}`)}
            </button>
          ))}
        </div>
      )}

      {/* Searching */}
      {searching && (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          {t("ask.searching")}
        </div>
      )}

      {/* Results */}
      {!searching && results !== null && (
        <div className="space-y-3">
          <p className="text-xs font-medium text-muted-foreground">
            {results.length > 0
              ? t("ask.matchCount", {
                  count: String(results.length),
                  query: lastQuery,
                })
              : t("ask.noMatches")}
          </p>
          {results.length === 0 && (
            <div className="rounded-xl border border-dashed bg-card p-6 text-center">
              <AlertTriangle
                className="mx-auto h-6 w-6 text-muted-foreground"
                aria-hidden
              />
              <p className="mt-2 text-sm font-medium">{t("ask.noMatches")}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("ask.noMatchesBody")}
              </p>
            </div>
          )}
          {results.map((hit, idx) => (
            <article
              key={hit.passageId}
              className="group rounded-xl border bg-card p-4 transition-colors hover:border-primary/30"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                  {t("ask.pageBadge", { page: String(hit.page) })}
                </span>
                <div className="flex items-center gap-2">
                <span
                  className="text-[11px] text-muted-foreground"
                  title={t("ask.relevanceTitle")}
                >
                  {t("ask.relevance", { pct: String(relevancePct(hit.score, top)) })}
                </span>
                <button
                  type="button"
                  onClick={() => copyPassage(hit.text, idx)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted focus-visible:opacity-100 group-hover:opacity-100"
                  aria-label={t("ask.copyPassage")}
                >
                  {copiedIdx === idx ? (
                    <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
                  ) : (
                    <Copy className="h-3.5 w-3.5" aria-hidden />
                  )}
                </button>
                </div>
              </div>
              <p className="text-sm leading-relaxed text-foreground/90">
                <HighlightRuns text={hit.text} query={lastQuery} />
              </p>
            </article>
          ))}
          {results.length > 0 && (
            <p className="pt-1 text-center text-[11px] text-muted-foreground">
              {t("ask.methodNote")}
            </p>
          )}
        </div>
      )}

      {/* Chain hint */}
      {results !== null && results.length > 0 && onChain && (
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          <span className="text-xs text-muted-foreground">
            {t("ask.nextHint")}
          </span>
          <button
            type="button"
            onClick={() => onChain("summarize-pdf")}
            className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
          >
            {t("ask.goSummary")}
            <ArrowRight className="h-3 w-3" aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Snippet highlighter: windowed around the first match (the same PURE
 * buildSnippet algorithm the worker-lib ships, re-run client-side for
 * rendering — identical inputs, identical runs).
 */
function HighlightRuns({ text, query }: { text: string; query: string }): ReactNode {
  const terms = new Set(
    (query.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).filter(
      (w) => w.length > 1,
    ),
  );
  const maxChars = 340;
  const words = text.split(/(\s+)/);
  const isMatch = (word: string): boolean => {
    const cleaned = word
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}]+/gu, "");
    return cleaned.length > 0 && terms.has(cleaned);
  };
  const first = words.findIndex(isMatch);
  const start = first < 0 ? 0 : Math.max(0, first - 24);

  const out: ReactNode[] = [];
  let buf = "";
  let bufHit = false;
  let used = 0;
  let lastIdx = start - 1;
  let n = 0;
  const flush = (): void => {
    if (buf.length === 0) return;
    out.push(
      bufHit ? (
        <mark
          key={`m${n}`}
          className="rounded-sm bg-primary/15 px-0.5 font-semibold text-primary"
        >
          {buf}
        </mark>
      ) : (
        <span key={`s${n}`}>{buf}</span>
      ),
    );
    n += 1;
    buf = "";
  };
  for (let i = start; i < words.length && used < maxChars; i += 1) {
    const word = words[i]!;
    const hit = isMatch(word);
    if (buf.length > 0 && hit !== bufHit) {
      flush();
    }
    bufHit = hit;
    buf += word;
    used += word.length;
    lastIdx = i;
  }
  flush();
  if (out.length === 0) return text.slice(0, maxChars);
  return (
    <>
      {start > 0 ? "…" : null}
      {out}
      {lastIdx < words.length - 1 ? "…" : null}
    </>
  );
}
