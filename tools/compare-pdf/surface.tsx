"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  ArrowDownRight,
  Columns2,
  FileDiff,
  FileX,
  Layers,
  Loader2,
  LockKeyhole,
  TriangleAlert,
} from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { PDF_DOC_PARAMS, loadPdfjs } from "@/lib/pdf/pdfjs";
import { formatBytes } from "@/lib/storage/recent-files";
import { DropZone } from "@/components/doco/tool/drop-zone";
import { cn } from "@/lib/utils";
import {
  CMP_IDS,
  PIXEL_THRESHOLD,
  buildPairSims,
  classifyPair,
  diffWordStats,
  groupHunks,
  joinPageText,
  MAX_HUNKS,
  pairPages,
  pixelDiff,
  resolveCompareOptions,
  wordDiff,
  type DiffOp,
  type PagePair,
  type PairStatus,
  type RawTextItem,
  type TextHunk,
} from "./engine";

/**
 * Compare PDFs surface (PRD §8.5) — the interactive product:
 *
 *  - SIDE BY SIDE: every page pair in one lazy-rendered list — scrolling
 *    is the sync scroll (both pages of a pair always travel together).
 *  - OVERLAY: red/green/purple pixel diff per pair (pdf.js renders both
 *    pages on demand, the engine diffs the pixels — same function the
 *    report worker uses).
 *  - TEXT: the word-level change list with jump-to-pair buttons.
 *
 * Controls (sensitivity, ignore case/whitespace, page mapping) serialize
 * into the shared option values (bookmark effect pattern) so the worker
 * run reports exactly what was on screen. The run writes the exportable
 * PDF report.
 */

type ViewMode = "split" | "overlay" | "text";

type ProbeStatus = "working" | "done" | "encrypted" | "error";

interface ProbeState {
  file: File;
  status: ProbeStatus;
  pageCount: number;
}

interface PairInfo {
  pair: PagePair;
  sim: number;
  status: PairStatus;
}

interface PairStat {
  removed: number;
  added: number;
  hunks: TextHunk[];
}

/** Lazy visibility window (px) around the viewport for canvas rows. */
const OBSERVE_MARGIN = "1200px";
/** Overlay render cap (CSS px) keeps mobile pixel buffers bounded. */
const OVERLAY_MAX_W = 1000;
const STATS_DEBOUNCE_MS = 250;

export function CompareSurface({
  files,
  values,
  onChange,
  setFileOrder,
  setRunBlocked,
  addFiles,
}: ToolSurfaceProps): React.JSX.Element | null {
  const { t } = useI18n();

  const fileA = files[0]?.file ?? null;
  const fileB = files[1]?.file ?? null;

  /* ---------------- controls (mirrored into option values) ---------------- */

  const initial = resolveCompareOptions(values);
  const [viewMode, setViewMode] = useState<ViewMode>("split");
  const [sensitivity, setSensitivity] = useState(initial.sensitivity);
  const [ignoreCase, setIgnoreCase] = useState(initial.ignoreCase);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(
    initial.ignoreWhitespace
  );
  const [mapping, setMapping] = useState(initial.mapping);

  // Serialization effect — the worker run reports what the screen showed.
  useEffect(() => {
    onChange(CMP_IDS.sensitivity, sensitivity);
    onChange(CMP_IDS.ignoreCase, ignoreCase);
    onChange(CMP_IDS.ignoreWhitespace, ignoreWhitespace);
    onChange(CMP_IDS.pageMapping, mapping);
  }, [
    sensitivity,
    ignoreCase,
    ignoreWhitespace,
    mapping,
    onChange,
  ]);

  /* ---------------- probes (both files, unlock-pdf pattern) ---------------- */

  const [probeA, setProbeA] = useState<ProbeState | null>(null);
  const [probeB, setProbeB] = useState<ProbeState | null>(null);
  const docARef = useRef<PDFDocumentProxy | null>(null);
  const docBRef = useRef<PDFDocumentProxy | null>(null);
  // Extracted page texts live in STATE, not refs — the pairing memo and the
  // stats effect read them, and the React compiler forbids ref reads in
  // render (useMemo included).
  const [textsA, setTextsA] = useState<string[]>([]);
  const [textsB, setTextsB] = useState<string[]>([]);

  const probe = useCallback(
    async (
      file: File | null,
      setProbe: (state: ProbeState | null) => void,
      setDoc: (doc: PDFDocumentProxy | null) => void,
      setTexts: (texts: string[]) => void
    ): Promise<void> => {
      if (file === null) {
        setProbe(null);
        setDoc(null);
        setTexts([]);
        return;
      }
      await Promise.resolve(); // microtask reset — never synchronous
      setProbe({ file, status: "working", pageCount: 0 });
      try {
        const pdfjs = await loadPdfjs();
        const data = new Uint8Array(await file.arrayBuffer());
        const doc = await pdfjs.getDocument({ data, ...PDF_DOC_PARAMS })
          .promise;
        const texts: string[] = [];
        for (let page = 1; page <= doc.numPages; page += 1) {
          const pdfPage = await doc.getPage(page);
          const content = await pdfPage.getTextContent();
          pdfPage.cleanup();
          texts.push(
            joinPageText(content.items as RawTextItem[])
          );
        }
        setDoc(doc);
        setTexts(texts);
        setProbe({ file, status: "done", pageCount: doc.numPages });
      } catch (cause: unknown) {
        setDoc(null);
        setTexts([]);
        const name =
          cause !== null && typeof cause === "object" && "name" in cause
            ? String((cause as { name: unknown }).name)
            : "";
        setProbe({
          file,
          status: name === "PasswordException" ? "encrypted" : "error",
          pageCount: 0,
        });
      }
    },
    []
  );

  useEffect(() => {
    void probe(fileA, setProbeA, (d) => (docARef.current = d), setTextsA);
    return () => {
      docARef.current?.destroy().catch(() => undefined);
      docARef.current = null;
    };
  }, [fileA, probe]);

  useEffect(() => {
    void probe(fileB, setProbeB, (d) => (docBRef.current = d), setTextsB);
    return () => {
      docBRef.current?.destroy().catch(() => undefined);
      docBRef.current = null;
    };
  }, [fileB, probe]);

  const activeA = probeA !== null && probeA.file === fileA ? probeA : null;
  const activeB = probeB !== null && probeB.file === fileB ? probeB : null;
  const bothReady =
    activeA?.status === "done" && activeB?.status === "done";

  /* ---------------- pairing + classification (memoized) ---------------- */

  const pairInfos: PairInfo[] = useMemo(() => {
    if (!bothReady) return [];
    const sims = buildPairSims(textsA, textsB, {
      ignoreCase,
      ignoreWhitespace,
    });
    const plan = pairPages(
      textsA.length,
      textsB.length,
      (i, j) => sims[i][j],
      mapping
    );
    return plan.pairs.map((pair) => {
      const sim =
        pair.kind === "both"
          ? sims[(pair.a ?? 1) - 1][(pair.b ?? 1) - 1]
          : 0;
      return {
        pair,
        sim,
        status: classifyPair(pair, sim, sensitivity),
      };
    });
  }, [bothReady, textsA, textsB, mapping, sensitivity, ignoreCase, ignoreWhitespace]);

  const counts = useMemo(() => {
    const out = { equal: 0, similar: 0, different: 0, added: 0, removed: 0 };
    for (const info of pairInfos) out[info.status] += 1;
    return out;
  }, [pairInfos]);

  /* ---------------- per-pair word stats (async, chunked) ---------------- */

  const [pairStats, setPairStats] = useState<PairStat[] | null>(null);
  const [statsWorking, setStatsWorking] = useState(false);
  const [statsCapped, setStatsCapped] = useState(false);

  useEffect(() => {
    if (!bothReady) {
      // Reset on a microtask — never synchronously in the effect body.
      let cancelled = false;
      void Promise.resolve().then(() => {
        if (!cancelled) {
          setPairStats(null);
          setStatsCapped(false);
        }
      });
      return () => {
        cancelled = true;
      };
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        setStatsWorking(true);
        const prep = { ignoreCase, ignoreWhitespace };
        const out: PairStat[] = new Array(pairInfos.length);
        let hunkBudget = MAX_HUNKS;
        let capped = false;
        for (let i = 0; i < pairInfos.length; i += 1) {
          if (cancelled) return;
          const { pair } = pairInfos[i];
          if (pair.kind === "added" || pair.kind === "removed") {
            const text =
              pair.kind === "added"
                ? textsB[(pair.b ?? 1) - 1]
                : textsA[(pair.a ?? 1) - 1];
            const words = text.split(/\s+/).filter(Boolean).length;
            out[i] = {
              removed: pair.kind === "removed" ? words : 0,
              added: pair.kind === "added" ? words : 0,
              hunks: [],
            };
          } else if (pairInfos[i].status === "equal") {
            out[i] = { removed: 0, added: 0, hunks: [] };
          } else {
            let ops: DiffOp[] = [];
            try {
              ops = wordDiff(
                textsA[(pair.a ?? 1) - 1],
                textsB[(pair.b ?? 1) - 1],
                prep
              ).ops;
            } catch {
              ops = [];
            }
            const stats = diffWordStats(ops);
            const hunks = groupHunks(ops, undefined, Math.max(0, hunkBudget));
            hunkBudget -= hunks.length;
            if (hunkBudget <= 0) capped = true;
            out[i] = { ...stats, hunks };
          }
          // Yield to the UI thread between pairs.
          if (i % 3 === 2) await new Promise((r) => setTimeout(r, 0));
        }
        if (cancelled) return;
        setPairStats(out);
        setStatsCapped(capped);
        setStatsWorking(false);
      })();
    }, STATS_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setStatsWorking(false);
    };
  }, [
    pairInfos,
    bothReady,
    textsA,
    textsB,
    ignoreCase,
    ignoreWhitespace,
  ]);

  /* ---------------- run gating ---------------- */

  useEffect(() => {
    setRunBlocked(files.length < 2 ? "compare.errorNeedTwo" : null);
    return () => setRunBlocked(null);
  }, [files.length, setRunBlocked]);

  /* ---------------- jump-to-pair ---------------- */

  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const jumpToPair = useCallback((pairIndex: number): void => {
    setViewMode("split");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const row = rowRefs.current.get(pairIndex);
        row?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }, []);

  /* ---------------- width (canvas render target) ---------------- */

  const rootRef = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = rootRef.current;
    if (el === null) return;
    const observer = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      setWidth((prev) => (Math.abs(prev - w) > 32 ? w : prev));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const removeFile = useCallback(
    (id: string): void => {
      setFileOrder(files.filter((item) => item.id !== id));
    },
    [files, setFileOrder]
  );

  /* ---------------- render ---------------- */

  if (files.length === 0) return null;

  return (
    <section
      ref={rootRef}
      aria-label={t("compare.surfaceLabel")}
      className="flex flex-col gap-3"
    >
      {/* Role headers */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <RoleFileHeader
          roleKey="compare.original"
          file={fileA}
          pageCount={activeA?.pageCount ?? 0}
          status={activeA?.status ?? "none"}
          onRemove={files[0] ? () => removeFile(files[0].id) : undefined}
        />
        <RoleFileHeader
          roleKey="compare.revised"
          file={fileB}
          pageCount={activeB?.pageCount ?? 0}
          status={activeB?.status ?? "none"}
          onRemove={files[1] ? () => removeFile(files[1].id) : undefined}
        />
      </div>

      {/* Second file prompt */}
      {files.length < 2 ? (
        <>
          <p className="flex items-start gap-2 rounded-card border border-dashed border-border bg-muted/30 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
            <FileDiff className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {t("compare.addSecond")}
          </p>
          <DropZone
            labelKey="compare.dropSecond"
            multiple={false}
            maxFiles={2}
            acceptKind="pdf"
            onAccept={addFiles}
            currentCount={files.length}
            className="py-2"
          />
        </>
      ) : null}

      {/* Probe status */}
      <div aria-live="polite">
        {activeA !== null && activeA.status === "working" ? (
          <p
            role="status"
            className="flex items-center gap-2 rounded-card border border-border bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground"
          >
            <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
            {t("compare.reading")}
          </p>
        ) : null}
        {probeIssue(activeA, "compare.probeEncryptedA", "compare.probeErrorA", t)}
        {probeIssue(activeB, "compare.probeEncryptedB", "compare.probeErrorB", t)}
      </div>

      {bothReady ? (
        <>
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-card p-2">
            <div
              role="tablist"
              aria-label={t("compare.viewLabel")}
              className="flex overflow-hidden rounded-btn border border-border"
            >
              <ViewTab
                active={viewMode === "split"}
                onClick={() => setViewMode("split")}
                label={t("compare.viewSplit")}
                icon={<Columns2 className="size-3.5" aria-hidden="true" />}
              />
              <ViewTab
                active={viewMode === "overlay"}
                onClick={() => setViewMode("overlay")}
                label={t("compare.viewOverlay")}
                icon={<Layers className="size-3.5" aria-hidden="true" />}
              />
              <ViewTab
                active={viewMode === "text"}
                onClick={() => setViewMode("text")}
                label={t("compare.viewText")}
                icon={<FileDiff className="size-3.5" aria-hidden="true" />}
              />
            </div>
            <div className="flex overflow-hidden rounded-btn border border-border">
              {(["low", "medium", "high"] as const).map((level) => (
                <button
                  key={level}
                  type="button"
                  onClick={() => setSensitivity(level)}
                  aria-pressed={sensitivity === level}
                  title={t("compare.sensitivity")}
                  className={cn(
                    "min-h-9 px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    sensitivity === level
                      ? "bg-primary text-primary-foreground"
                      : "bg-card text-muted-foreground hover:bg-muted"
                  )}
                >
                  {t(`compare.sens_${level}`)}
                </button>
              ))}
            </div>
            <div className="flex overflow-hidden rounded-btn border border-border">
              {(
                [
                  ["smart", "compare.mapSmart"],
                  ["position", "compare.mapPosition"],
                ] as const
              ).map(([mode, key]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setMapping(mode)}
                  aria-pressed={mapping === mode}
                  className={cn(
                    "min-h-9 px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    mapping === mode
                      ? "bg-primary text-primary-foreground"
                      : "bg-card text-muted-foreground hover:bg-muted"
                  )}
                >
                  {t(key)}
                </button>
              ))}
            </div>
            <label className="flex min-h-9 cursor-pointer select-none items-center gap-2 px-1 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="size-4 accent-[var(--primary)]"
                checked={ignoreCase}
                onChange={(event) => setIgnoreCase(event.target.checked)}
              />
              {t("compare.ignoreCase")}
            </label>
            <label className="flex min-h-9 cursor-pointer select-none items-center gap-2 px-1 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="size-4 accent-[var(--primary)]"
                checked={ignoreWhitespace}
                onChange={(event) => setIgnoreWhitespace(event.target.checked)}
              />
              {t("compare.ignoreWs")}
            </label>
          </div>

          {/* Summary chips */}
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {t("compare.pairsSummary", {
                pairs: pairInfos.length,
                equal: counts.equal,
                similar: counts.similar,
                changed: counts.different,
                added: counts.added,
                removed: counts.removed,
              })}
            </span>
            {statsWorking ? (
              <span className="flex items-center gap-1 text-muted-foreground">
                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                {t("compare.computingChanges")}
              </span>
            ) : null}
          </p>

          {/* Views */}
          {viewMode === "split" ? (
            <div className="flex flex-col gap-4">
              {pairInfos.map((info, index) => (
                <SplitPairRow
                  key={`${info.pair.a}-${info.pair.b}-${index}`}
                  info={info}
                  index={index}
                  docARef={docARef}
                  docBRef={docBRef}
                  width={width}
                  registerRef={(el) => {
                    if (el === null) rowRefs.current.delete(index);
                    else rowRefs.current.set(index, el);
                  }}
                />
              ))}
            </div>
          ) : null}

          {viewMode === "overlay" ? (
            <div className="flex flex-col gap-4">
              <OverlayLegend />
              {pairInfos.map((info, index) => (
                <OverlayPairRow
                  key={`${info.pair.a}-${info.pair.b}-${index}`}
                  info={info}
                  index={index}
                  docARef={docARef}
                  docBRef={docBRef}
                  width={width}
                  sensitivity={sensitivity}
                  stat={pairStats?.[index] ?? null}
                  registerRef={(el) => {
                    if (el === null) rowRefs.current.delete(index);
                    else rowRefs.current.set(index, el);
                  }}
                />
              ))}
            </div>
          ) : null}

          {viewMode === "text" ? (
            <TextChangesView
              pairInfos={pairInfos}
              pairStats={pairStats}
              statsCapped={statsCapped}
              statsWorking={statsWorking}
              onJump={jumpToPair}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export default CompareSurface;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function probeIssue(
  probe: ProbeState | null,
  encryptedKey: string,
  errorKey: string,
  t: (key: string) => string
): React.JSX.Element | null {
  if (probe === null) return null;
  if (probe.status === "encrypted") {
    return (
      <p className="flex items-start gap-2 rounded-card border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
        <LockKeyhole className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        {t(encryptedKey)}
      </p>
    );
  }
  if (probe.status === "error") {
    return (
      <p className="flex items-start gap-2 rounded-card border border-border bg-muted/40 px-4 py-2.5 text-xs leading-relaxed text-muted-foreground">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        {t(errorKey)}
      </p>
    );
  }
  return null;
}

function ViewTab({
  active,
  onClick,
  label,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex min-h-9 items-center gap-1.5 px-3 text-xs font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-card text-muted-foreground hover:bg-muted"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function RoleFileHeader({
  roleKey,
  file,
  pageCount,
  status,
  onRemove,
}: {
  roleKey: string;
  file: File | null;
  pageCount: number;
  status: ProbeStatus | "none";
  onRemove?: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-3 rounded-card border border-border bg-card px-4 py-3">
      <span
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-btn text-xs font-bold uppercase tracking-wide",
          roleKey === "compare.original"
            ? "bg-muted text-muted-foreground"
            : "bg-primary/10 text-primary"
        )}
        aria-hidden="true"
      >
        {roleKey === "compare.original" ? "A" : "B"}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t(roleKey)}
        </p>
        {file !== null ? (
          <p className="truncate text-sm font-semibold text-foreground" title={file.name}>
            {file.name}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("compare.waitingFile")}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {status === "done" && pageCount > 0 && file !== null
            ? t("compare.pages", {
                count: pageCount,
                size: formatBytes(file.size),
              })
            : status === "working"
              ? t("compare.reading")
              : ""}
        </p>
      </div>
      {onRemove !== undefined && file !== null ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("tool.removeFileLabel", { name: file.name })}
          className="flex size-9 shrink-0 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <FileX className="size-4" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function statusBadgeClasses(status: PairStatus): string {
  switch (status) {
    case "equal":
      return "bg-muted text-muted-foreground";
    case "similar":
      return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "different":
      return "bg-purple-500/10 text-purple-700 dark:text-purple-300";
    case "added":
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "removed":
      return "bg-red-500/10 text-red-700 dark:text-red-300";
  }
}

function PairChip({
  info,
  index,
}: {
  info: PairInfo;
  index: number;
}): React.JSX.Element {
  const { t } = useI18n();
  const left = info.pair.a === null ? "—" : `p${info.pair.a}`;
  const right = info.pair.b === null ? "—" : `p${info.pair.b}`;
  const alike =
    info.pair.kind === "both" ? ` · ${Math.round(info.sim * 100)}%` : "";
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="rounded-chip bg-cat-view/10 px-2 py-0.5 font-semibold tabular-nums text-cat-view">
        {t("compare.pairChip", { index: index + 1 })} {left} ↔ {right}
        {alike}
      </span>
      <span
        className={cn(
          "rounded-chip px-2 py-0.5 text-[11px] font-semibold",
          statusBadgeClasses(info.status)
        )}
      >
        {t(`compare.status_${info.status}`)}
      </span>
    </p>
  );
}

/** Hook: observe an element, true while near the viewport. */
function useNearViewport<T extends HTMLElement>(): {
  ref: (el: T | null) => void;
  near: boolean;
} {
  const [near, setNear] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const ref = useCallback((el: T | null): void => {
    observerRef.current?.disconnect();
    if (el === null) {
      setNear(false);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setNear(entry.isIntersecting);
      },
      { rootMargin: OBSERVE_MARGIN }
    );
    observer.observe(el);
    observerRef.current = observer;
  }, []);
  useEffect(() => {
    return () => observerRef.current?.disconnect();
  }, []);
  return { ref, near };
}

/* ------------------------------------------------------------------ */
/* Split view                                                          */
/* ------------------------------------------------------------------ */

function SplitPairRow({
  info,
  index,
  docARef,
  docBRef,
  width,
  registerRef,
}: {
  info: PairInfo;
  index: number;
  docARef: React.RefObject<PDFDocumentProxy | null>;
  docBRef: React.RefObject<PDFDocumentProxy | null>;
  width: number;
  registerRef: (el: HTMLDivElement | null) => void;
}): React.JSX.Element {
  return (
    <div
      ref={registerRef}
      data-pair={index}
      className="flex scroll-mt-24 flex-col gap-2 rounded-card border border-border bg-card p-3"
    >
      <PairChip info={info} index={index} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {info.pair.a !== null ? (
          <PagePane
            docRef={docARef}
            page={info.pair.a}
            roleKey="compare.original"
            width={width}
          />
        ) : (
          <MissingPane roleKey="compare.notInOriginal" />
        )}
        {info.pair.b !== null ? (
          <PagePane
            docRef={docBRef}
            page={info.pair.b}
            roleKey="compare.revised"
            width={width}
          />
        ) : (
          <MissingPane roleKey="compare.notInRevised" />
        )}
      </div>
    </div>
  );
}

function PagePane({
  docRef,
  page,
  roleKey,
  width,
}: {
  docRef: React.RefObject<PDFDocumentProxy | null>;
  page: number;
  roleKey: string;
  width: number;
}): React.JSX.Element {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { ref: watchRef, near } = useNearViewport<HTMLDivElement>();

  useEffect(() => {
    if (!near || width <= 0) return;
    let cancelled = false;
    void (async () => {
      const doc = docRef.current;
      const canvas = canvasRef.current;
      if (doc === null || canvas === null) return;
      try {
        const pdfPage = await doc.getPage(page);
        if (cancelled) return;
        const base = pdfPage.getViewport({ scale: 1 });
        const scale = width / base.width;
        const viewport = pdfPage.getViewport({ scale });
        const dpr = Math.min(
          typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
          2
        );
        canvas.width = Math.max(1, Math.round(viewport.width * dpr));
        canvas.height = Math.max(1, Math.round(viewport.height * dpr));
        canvas.style.width = `${Math.round(viewport.width)}px`;
        canvas.style.height = `${Math.round(viewport.height)}px`;
        canvas.style.display = "block";
        canvas.style.maxWidth = "100%";
        const context = canvas.getContext("2d");
        if (context === null) return;
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        await pdfPage.render({
          canvasContext: context,
          viewport,
        }).promise;
        pdfPage.cleanup();
      } catch {
        // A failed render leaves the skeleton — the worker run still
        // reports honestly.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [near, width, page, docRef]);

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t(roleKey)} · p{page}
      </p>
      <div
        ref={watchRef}
        className="flex min-h-40 items-center justify-center overflow-hidden rounded-btn border border-border bg-muted/30"
      >
        {!near ? (
          <Loader2
            className="size-5 animate-spin text-muted-foreground"
            aria-hidden="true"
          />
        ) : null}
        <canvas
          ref={canvasRef}
          className="max-w-full"
          aria-label={t("compare.pageCanvasLabel", { page })}
          hidden={!near}
        />
      </div>
    </div>
  );
}

function MissingPane({ roleKey }: { roleKey: string }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t(roleKey)}
      </p>
      <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-btn border border-dashed border-border bg-muted/20 px-3 py-8 text-center">
        <FileX className="size-5 text-muted-foreground" aria-hidden="true" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t(roleKey)}
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Overlay view                                                        */
/* ------------------------------------------------------------------ */

function OverlayLegend(): React.JSX.Element {
  const { t } = useI18n();
  const items = [
    { color: "bg-red-500", key: "compare.legendRemoved" },
    { color: "bg-emerald-500", key: "compare.legendAdded" },
    { color: "bg-purple-500", key: "compare.legendModified" },
    { color: "bg-white border border-border", key: "compare.legendSame" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-card border border-border bg-card px-4 py-2.5 text-xs text-muted-foreground">
      {items.map((item) => (
        <span key={item.key} className="flex items-center gap-1.5">
          <span
            className={cn("size-2.5 rounded-full", item.color)}
            aria-hidden="true"
          />
          {t(item.key)}
        </span>
      ))}
    </div>
  );
}

/** Blit raw RGBA pixels onto a 2d context (ImageData-safe for TS). */
function putPixels(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  pixels: Uint8ClampedArray,
  w: number,
  h: number
): void {
  const image = ctx.createImageData(w, h);
  image.data.set(pixels);
  ctx.putImageData(image, 0, 0);
}

function OverlayPairRow({
  info,
  index,
  docARef,
  docBRef,
  width,
  sensitivity,
  stat,
  registerRef,
}: {
  info: PairInfo;
  index: number;
  docARef: React.RefObject<PDFDocumentProxy | null>;
  docBRef: React.RefObject<PDFDocumentProxy | null>;
  width: number;
  sensitivity: "low" | "medium" | "high";
  stat: PairStat | null;
  registerRef: (el: HTMLDivElement | null) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { ref: watchRef, near } = useNearViewport<HTMLDivElement>();
  const [pct, setPct] = useState<string | null>(null);

  useEffect(() => {
    if (!near || width <= 0) return;
    let cancelled = false;
    void (async () => {
      const docA = docARef.current;
      const docB = docBRef.current;
      const canvas = canvasRef.current;
      if (canvas === null) return;
      try {
        const renderW = Math.min(width, OVERLAY_MAX_W);
        const render = async (
          doc: PDFDocumentProxy | null,
          page: number | null
        ): Promise<{ w: number; h: number; data: Uint8ClampedArray } | null> => {
          if (doc === null || page === null) return null;
          const pdfPage = await doc.getPage(page);
          const base = pdfPage.getViewport({ scale: 1 });
          const scale = renderW / base.width;
          const viewport = pdfPage.getViewport({ scale });
          const w = Math.max(1, Math.round(viewport.width));
          const h = Math.max(1, Math.round(viewport.height));
          const off = new OffscreenCanvas(w, h);
          const ctx = off.getContext("2d");
          if (ctx === null) return null;
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, w, h);
          await pdfPage.render({
            canvasContext: ctx as unknown as CanvasRenderingContext2D,
            viewport,
          }).promise;
          pdfPage.cleanup();
          return { w, h, data: ctx.getImageData(0, 0, w, h).data };
        };
        if (info.pair.kind === "both") {
          const imgA = await render(docA, info.pair.a);
          const imgB = await render(docB, info.pair.b);
          if (cancelled || imgA === null || imgB === null) return;
          // Different page grids → stretch B onto A's grid.
          let dataB = imgB.data;
          if (imgB.w !== imgA.w || imgB.h !== imgA.h) {
            const off = new OffscreenCanvas(imgA.w, imgA.h);
            const ctx = off.getContext("2d");
            if (ctx === null) return;
            const srcCanvas = new OffscreenCanvas(imgB.w, imgB.h);
            const srcCtx = srcCanvas.getContext("2d");
            if (srcCtx === null) return;
            srcCtx.putImageData(
              (() => {
                const img = srcCtx.createImageData(imgB.w, imgB.h);
                img.data.set(imgB.data);
                return img;
              })(),
              0,
              0
            );
            ctx.drawImage(srcCanvas, 0, 0, imgA.w, imgA.h);
            dataB = ctx.getImageData(0, 0, imgA.w, imgA.h).data;
          }
          const outcome = pixelDiff(
            imgA.data,
            dataB,
            PIXEL_THRESHOLD[sensitivity]
          );
          if (cancelled) return;
          canvas.width = imgA.w;
          canvas.height = imgA.h;
          canvas.style.width = "100%";
          canvas.style.maxWidth = `${imgA.w}px`;
          const ctx = canvas.getContext("2d");
          if (ctx === null) return;
          putPixels(ctx, outcome.out, imgA.w, imgA.h);
          const percent = outcome.changedRatio * 100;
          setPct(
            percent < 0.1
              ? percent.toFixed(2)
              : percent < 10
                ? percent.toFixed(1)
                : Math.round(percent).toString()
          );
        } else {
          // Added / removed page: the page itself with a colored frame.
          const doc = info.pair.kind === "added" ? docB : docA;
          const pageNum = (info.pair.kind === "added"
            ? info.pair.b
            : info.pair.a) as number;
          const img = await render(doc, pageNum);
          if (cancelled || img === null) return;
          canvas.width = img.w;
          canvas.height = img.h;
          canvas.style.width = "100%";
          canvas.style.maxWidth = `${img.w}px`;
          const ctx = canvas.getContext("2d");
          if (ctx === null) return;
          putPixels(ctx, img.data, img.w, img.h);
          const stroke =
            info.pair.kind === "added"
              ? "rgba(16, 163, 74, 0.9)"
              : "rgba(222, 52, 52, 0.9)";
          ctx.strokeStyle = stroke;
          ctx.lineWidth = Math.max(3, Math.round(img.w * 0.008));
          ctx.strokeRect(
            ctx.lineWidth / 2,
            ctx.lineWidth / 2,
            img.w - ctx.lineWidth,
            img.h - ctx.lineWidth
          );
        }
      } catch {
        // Skeleton stays; the run still reports honestly.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    near,
    width,
    sensitivity,
    info.pair,
    docARef,
    docBRef,
  ]);

  return (
    <div
      ref={registerRef}
      data-pair={index}
      className="flex scroll-mt-24 flex-col gap-2 rounded-card border border-border bg-card p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PairChip info={info} index={index} />
        <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          {pct !== null ? (
            <span className="rounded-chip bg-purple-500/10 px-2 py-0.5 font-semibold tabular-nums text-purple-700 dark:text-purple-300">
              {t("compare.pixelsChanged", { pct })}
            </span>
          ) : null}
          {stat !== null && (stat.removed > 0 || stat.added > 0) ? (
            <span className="rounded-chip bg-muted px-2 py-0.5 font-semibold tabular-nums">
              −{stat.removed} / +{stat.added}
            </span>
          ) : null}
        </p>
      </div>
      <div
        ref={watchRef}
        className="flex min-h-40 items-center justify-center overflow-hidden rounded-btn border border-border bg-muted/30"
      >
        {!near ? (
          <Loader2
            className="size-5 animate-spin text-muted-foreground"
            aria-hidden="true"
          />
        ) : null}
        <canvas
          ref={canvasRef}
          className="h-auto max-w-full"
          aria-label={t("compare.overlayCanvasLabel", {
            index: index + 1,
          })}
          hidden={!near}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Text changes view                                                   */
/* ------------------------------------------------------------------ */

function TextChangesView({
  pairInfos,
  pairStats,
  statsCapped,
  statsWorking,
  onJump,
}: {
  pairInfos: PairInfo[];
  pairStats: PairStat[] | null;
  statsCapped: boolean;
  statsWorking: boolean;
  onJump: (pairIndex: number) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  if (pairStats === null) {
    return (
      <p
        role="status"
        className="flex items-center gap-2 rounded-card border border-border bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground"
      >
        <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
        {t("compare.computingChanges")}
      </p>
    );
  }
  const changed = pairInfos
    .map((info, i) => ({ info, i, stat: pairStats[i] }))
    .filter(
      (entry): entry is { info: PairInfo; i: number; stat: PairStat } =>
        entry.stat !== undefined &&
        (entry.stat.removed > 0 || entry.stat.added > 0)
    );
  if (changed.length === 0) {
    return (
      <p className="flex items-start gap-2 rounded-card border border-border bg-muted/40 px-4 py-3 text-sm leading-relaxed text-muted-foreground">
        <FileDiff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {t("compare.noChanges")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {statsWorking ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          {t("compare.computingChanges")}
        </p>
      ) : null}
      <ul
        className="flex max-h-[32rem] flex-col gap-2 overflow-y-auto scrollbar-thin pr-1"
        aria-label={t("compare.changesLabel")}
      >
        {changed.map(({ info, i, stat }) => (
          <li
            key={`${info.pair.a}-${info.pair.b}-${i}`}
            className="flex flex-col gap-2 rounded-card border border-border bg-card p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="rounded-chip bg-cat-view/10 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-cat-view">
                  {info.pair.a === null ? "new" : `p${info.pair.a}`} ↔{" "}
                  {info.pair.b === null ? "—" : `p${info.pair.b}`}
                </span>
                <span
                  className={cn(
                    "rounded-chip px-2 py-0.5 text-[11px] font-semibold",
                    statusBadgeClasses(info.status)
                  )}
                >
                  {t(`compare.status_${info.status}`)}
                </span>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  −{stat.removed} / +{stat.added}
                </span>
              </div>
              <button
                type="button"
                onClick={() => onJump(i)}
                className="flex min-h-9 items-center gap-1.5 rounded-btn border border-border bg-background px-2.5 text-xs font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <ArrowDownRight className="size-3.5" aria-hidden="true" />
                {t("compare.jumpPages")}
              </button>
            </div>
            <ul className="flex max-h-96 flex-col gap-1.5 overflow-y-auto scrollbar-thin pr-1">
              {stat.hunks.length === 0 ? (
                <li className="text-xs leading-relaxed text-muted-foreground">
                  {t("compare.hunksOverflow")}
                </li>
              ) : (
                stat.hunks.map((hunk, hunkIndex) => (
                  <HunkRow key={hunkIndex} hunk={hunk} />
                ))
              )}
            </ul>
          </li>
        ))}
      </ul>
      {statsCapped ? (
        <p className="text-xs text-muted-foreground">
          {t("compare.hunksCapped", { count: MAX_HUNKS })}
        </p>
      ) : null}
    </div>
  );
}

function HunkRow({ hunk }: { hunk: TextHunk }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <li className="flex flex-col gap-1">
      {hunk.kind !== "add" ? (
        <p
          className="rounded-btn border border-red-500/20 bg-red-500/5 px-2.5 py-1.5 text-sm leading-relaxed text-red-800 break-words dark:text-red-300"
          aria-label={t("compare.removedLabel")}
        >
          <span className="mr-1 font-bold select-none" aria-hidden="true">−</span>
          {hunk.before}
        </p>
      ) : null}
      {hunk.kind !== "del" ? (
        <p
          className="rounded-btn border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-1.5 text-sm leading-relaxed text-emerald-800 break-words dark:text-emerald-300"
          aria-label={t("compare.addedLabel")}
        >
          <span className="mr-1 font-bold select-none" aria-hidden="true">+</span>
          {hunk.after}
        </p>
      ) : null}
    </li>
  );
}
