"use client";

/**
 * Create PDF live surface (PRD §7.3) — the entire product for a no-file
 * tool (the write-pdf pattern): the template cards + paper options render
 * in place of the DropZone on the landing page, with a scaled live preview
 * driven by the SAME pure layout engine as the export worker.
 *
 * Export stays honest: the surface spawns the tool's real Web Worker and
 * speaks the shared protocol directly (progress → on-device download via
 * downloadBlob + success chip). The sanitized spec rides options.doc as
 * JSON (locale included — the worker resolves planner day labels from it);
 * the run carries no files at all. Zero network with data.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { CheckCircle2, Loader2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { useI18n } from "@/components/providers/locale-provider";
import { downloadBlob } from "@/lib/files/output";
import type { WorkerResponse } from "@/lib/workers/protocol";
import {
  DEFAULT_C_SPEC,
  maxPagesFor,
  planPages,
  sanitizeCSpec,
  type CPage,
  type CSpec,
  type CTemplate,
} from "./model";

/* ------------------------------------------------------------------ */
/* Template cards (pure CSS mini previews — no images)                 */
/* ------------------------------------------------------------------ */

const TEMPLATES: { id: CTemplate; nameKey: string; descKey: string }[] = [
  { id: "blank", nameKey: "create.tplBlank", descKey: "create.tplBlankDesc" },
  { id: "lined", nameKey: "create.tplLined", descKey: "create.tplLinedDesc" },
  { id: "grid", nameKey: "create.tplGrid", descKey: "create.tplGridDesc" },
  { id: "dotted", nameKey: "create.tplDotted", descKey: "create.tplDottedDesc" },
  { id: "cornell", nameKey: "create.tplCornell", descKey: "create.tplCornellDesc" },
  { id: "planner", nameKey: "create.tplPlanner", descKey: "create.tplPlannerDesc" },
];

const THUMB_RULE = "#a6adb6";
const THUMB_GRID = "#b7bec6";
const THUMB_STRONG = "#6f7680";
const THUMB_MARGIN = "#e05252";
const THUMB_FAINT = "#dfe3e8";

/** A hairline at `pos`% along `dir` (used for the cornell mini preview). */
function hairline(dir: "to right" | "to bottom" | "to top", pos: number, color: string): string {
  return `linear-gradient(${dir}, transparent 0 ${pos}%, ${color} ${pos}% calc(${pos}% + 1px), transparent calc(${pos}% + 1px))`;
}

function TemplateThumb({ kind }: { kind: CTemplate }): JSX.Element {
  const sheet = "block h-full w-full bg-white";
  switch (kind) {
    case "blank":
      return <div className={sheet} />;
    case "lined":
      return (
        <div
          className={sheet}
          style={{
            backgroundImage: `repeating-linear-gradient(to bottom, ${THUMB_RULE} 0 1px, transparent 1px 7px), ${hairline("to right", 12, THUMB_MARGIN)}`,
          }}
        />
      );
    case "grid":
      return (
        <div
          className={sheet}
          style={{
            backgroundImage: `repeating-linear-gradient(to bottom, ${THUMB_GRID} 0 1px, transparent 1px 7px), repeating-linear-gradient(to right, ${THUMB_GRID} 0 1px, transparent 1px 7px)`,
          }}
        />
      );
    case "dotted":
      return (
        <div
          className={sheet}
          style={{
            backgroundImage: `radial-gradient(circle, #9aa1a9 1px, transparent 1.3px)`,
            backgroundSize: "7px 7px",
            backgroundPosition: "3px 3px",
          }}
        />
      );
    case "cornell":
      return (
        <div
          className={sheet}
          style={{
            backgroundImage: `${hairline("to right", 40, THUMB_STRONG)}, ${hairline("to top", 22, THUMB_STRONG)}, ${hairline("to bottom", 11, THUMB_STRONG)}, ${hairline("to right", 7, THUMB_MARGIN)}`,
          }}
        />
      );
    case "planner":
      return (
        <div className={`${sheet} flex flex-col`}>
          {Array.from({ length: 7 }, (_, i) => (
            <div
              key={i}
              className="flex flex-1 items-start gap-1 border-b border-[#c6ccd3] pl-1 pt-1 last:border-b-0"
            >
              <span className="block h-1 w-3 rounded-full bg-[#9aa1a9]" />
              <span className="block h-1 flex-1 rounded-full bg-[#e2e6ea]" />
            </div>
          ))}
        </div>
      );
  }
}

/* ------------------------------------------------------------------ */
/* Small field helper                                                  */
/* ------------------------------------------------------------------ */

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Scaled live preview page (same pure plan the worker paints)         */
/* ------------------------------------------------------------------ */

const PREVIEW_HELV = 'Helvetica, Arial, "Liberation Sans", sans-serif';
const PREVIEW_DEVA = '"CreatePdfDeva", "Noto Sans Devanagari", sans-serif';

function PreviewPage({
  page,
  pageW,
  pageH,
  scale,
}: {
  page: CPage;
  pageW: number;
  pageH: number;
  scale: number;
}): JSX.Element {
  return (
    <>
      {page.rects.map((rect, i) => (
        <div
          key={`r${i}`}
          className="absolute"
          style={{
            left: rect.x * scale,
            top: (pageH - rect.y - rect.h) * scale,
            width: rect.w * scale,
            height: rect.h * scale,
            backgroundColor: rect.color,
          }}
        />
      ))}
      {page.lines.map((line, i) => {
        const horizontal = Math.abs(line.y2 - line.y1) < 0.5;
        const thickness = Math.max(1, (line.width ?? 0.7) * scale);
        return horizontal ? (
          <div
            key={`l${i}`}
            className="absolute"
            style={{
              left: Math.min(line.x1, line.x2) * scale,
              top: (pageH - line.y1) * scale - thickness / 2,
              width: Math.abs(line.x2 - line.x1) * scale,
              height: thickness,
              backgroundColor: line.color,
            }}
          />
        ) : (
          <div
            key={`l${i}`}
            className="absolute"
            style={{
              left: line.x1 * scale - thickness / 2,
              top: (pageH - Math.max(line.y1, line.y2)) * scale,
              width: thickness,
              height: Math.abs(line.y2 - line.y1) * scale,
              backgroundColor: line.color,
            }}
          />
        );
      })}
      {page.dots.map((dot, i) => {
        const size = Math.max(2, dot.r * 2 * scale);
        return (
          <div
            key={`d${i}`}
            className="absolute rounded-full"
            style={{
              left: dot.x * scale - size / 2,
              top: (pageH - dot.y) * scale - size / 2,
              width: size,
              height: size,
              backgroundColor: dot.color,
            }}
          />
        );
      })}
      {page.labels.map((label, i) => (
        <span
          key={`t${i}`}
          className="absolute whitespace-pre"
          style={{
            left: label.x * scale,
            top: (pageH - label.y - label.size * 0.8) * scale,
            fontSize: `${label.size * scale}px`,
            lineHeight: `${label.size * scale}px`,
            fontFamily:
              label.font === "noto" ? PREVIEW_DEVA : PREVIEW_HELV,
            color: label.color,
          }}
        >
          {label.text}
        </span>
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Surface                                                             */
/* ------------------------------------------------------------------ */

export function CreateSurface(props: ToolSurfaceProps): JSX.Element {
  void props;
  const { t, locale } = useI18n();
  const { toast } = useToast();

  const [spec, setSpec] = useState<CSpec>(DEFAULT_C_SPEC);
  const [pct, setPct] = useState<number | null>(null);
  const [done, setDone] = useState<{ name: string; pages: number } | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const previewWrapRef = useRef<HTMLDivElement>(null);
  const [previewScale, setPreviewScale] = useState(0.5);

  /** The spec the run/preview use — locale always injected from the UI. */
  const liveSpec = useMemo(
    () => sanitizeCSpec({ ...spec, locale }),
    [spec, locale]
  );
  const plan = useMemo(() => planPages(liveSpec), [liveSpec]);
  const maxPages = maxPagesFor(spec.template);

  /* Devanagari preview font (self-hosted Noto — write-pdf recipe). */
  useEffect(() => {
    const face = new FontFace(
      "CreatePdfDeva",
      "url(/fonts/NotoSansDevanagari-Regular.ttf)"
    );
    document.fonts.add(face);
    void face.load().catch(() => undefined);
    return () => {
      document.fonts.delete(face);
    };
  }, []);

  /* Preview scale: fit the page into the measured column width. */
  useEffect(() => {
    const el = previewWrapRef.current;
    if (!el) return;
    const update = (): void => {
      const w = el.clientWidth;
      if (w > 0) {
        // fit the column width, capped at 560 px so desktop stays tidy
        setPreviewScale(Math.min(w / plan.width, 560 / plan.width, 1));
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [plan.width]);

  const patch = useCallback((part: Partial<CSpec>): void => {
    setSpec((current) => ({ ...current, ...part }));
  }, []);

  const pickTemplate = useCallback((template: CTemplate): void => {
    setSpec((current) => ({
      ...current,
      template,
      // planner is capped at 12 (one week per page)
      pages: Math.min(current.pages, maxPagesFor(template)),
    }));
  }, []);

  const setPages = useCallback((raw: string): void => {
    const n = Number.parseInt(raw, 10);
    setSpec((current) => ({
      ...current,
      pages:
        Number.isFinite(n)
          ? Math.min(Math.max(n, 1), maxPagesFor(current.template))
          : 1,
    }));
  }, []);

  /* ---------------------- export (surface-driven run) --------------- */

  const createPdf = useCallback((): void => {
    if (workerRef.current) return;
    setPct(0);
    setDone(null);
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
          const output = data.outputs[0];
          setPct(null);
          if (output) {
            downloadBlob(output.blob, output.name);
            setDone({
              name: output.name,
              pages: data.detail?.pages ?? plan.pages.length,
            });
            toast({
              title: t("create.doneTitle"),
              description: t("create.doneDesc", { name: output.name }),
            });
          }
          cleanup();
          return;
        }
        if (data.type === "error") {
          setPct(null);
          toast({
            title: t("tool.errorTitle"),
            description: t(data.code, { detail: data.detail ?? "" }),
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
      toolId: "create-pdf",
      options: { doc: JSON.stringify(liveSpec) },
      files: [],
    });
  }, [t, toast, liveSpec, plan.pages.length]);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  const busy = pct !== null;
  const triggerClass = "h-11 w-full rounded-btn text-sm";
  const showSpacing = spec.template === "lined";
  const showGrid = spec.template === "grid";
  const showMarginLine =
    spec.template === "lined" || spec.template === "cornell";
  const showHeaderLine = spec.template === "cornell";

  return (
    <div className="flex flex-col gap-6">
      {/* template picker */}
      <section
        aria-label={t("create.tplLabel")}
        className="grid grid-cols-2 gap-3 sm:grid-cols-3"
      >
        {TEMPLATES.map((template) => {
          const selected = spec.template === template.id;
          return (
            <button
              key={template.id}
              type="button"
              aria-pressed={selected}
              onClick={() => pickTemplate(template.id)}
              className={
                "group flex min-h-28 flex-col gap-2 rounded-card border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 " +
                (selected
                  ? "border-primary bg-accent/50"
                  : "border-border bg-card hover:border-primary/40 hover:bg-accent/40")
              }
            >
              <span className="block aspect-[3/4] w-full max-w-24 overflow-hidden rounded-sm border border-border bg-white">
                <TemplateThumb kind={template.id} />
              </span>
              <span>
                <span className="block text-sm font-semibold text-foreground">
                  {t(template.nameKey)}
                </span>
                <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                  {t(template.descKey)}
                </span>
              </span>
            </button>
          );
        })}
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-6">
        {/* live preview (page 1 — every page of a run is identical) */}
        <figure className="flex min-w-0 flex-col items-center gap-2">
          <div
            ref={previewWrapRef}
            className="flex w-full justify-center overflow-hidden"
          >
            <div
              role="img"
              aria-label={t("create.previewLabel")}
              className="relative shrink-0 overflow-hidden rounded-sm border border-border bg-white shadow-md"
              style={{
                width: plan.width * previewScale,
                height: plan.height * previewScale,
              }}
            >
              <PreviewPage
                page={plan.pages[0]}
                pageW={plan.width}
                pageH={plan.height}
                scale={previewScale}
              />
            </div>
          </div>
          <figcaption className="text-xs text-muted-foreground">
            {t("create.previewPage", { total: plan.pages.length })}
          </figcaption>
        </figure>

        {/* options */}
        <fieldset className="flex flex-col gap-4 rounded-card border border-border bg-card p-4">
          <legend className="px-1 text-sm font-semibold text-foreground">
            {t("create.optionsTitle")}
          </legend>

          <Field label={t("create.sizeLabel")}>
            <Select
              value={spec.pageSize}
              onValueChange={(v) => patch({ pageSize: v as CSpec["pageSize"] })}
            >
              <SelectTrigger className={triggerClass} aria-label={t("create.sizeLabel")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="a4">{t("create.sizeA4")}</SelectItem>
                <SelectItem value="letter">{t("create.sizeLetter")}</SelectItem>
                <SelectItem value="a5">{t("create.sizeA5")}</SelectItem>
                <SelectItem value="legal">{t("create.sizeLegal")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field label={t("create.orientLabel")}>
            <Select
              value={spec.orientation}
              onValueChange={(v) =>
                patch({ orientation: v as CSpec["orientation"] })
              }
            >
              <SelectTrigger className={triggerClass} aria-label={t("create.orientLabel")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="portrait">
                  {t("create.orientPortrait")}
                </SelectItem>
                <SelectItem value="landscape">
                  {t("create.orientLandscape")}
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field label={t("create.pagesLabel")}>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={maxPages}
              value={spec.pages}
              onChange={(e) => setPages(e.target.value)}
              aria-label={t("create.pagesLabel")}
              className="h-11 rounded-btn"
            />
            {spec.template === "planner" ? (
              <p className="text-xs text-muted-foreground">
                {t("create.pagesHint")}
              </p>
            ) : null}
          </Field>

          <Field label={t("create.marginLabel")}>
            <Select
              value={spec.margin}
              onValueChange={(v) => patch({ margin: v as CSpec["margin"] })}
            >
              <SelectTrigger className={triggerClass} aria-label={t("create.marginLabel")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("create.marginNone")}</SelectItem>
                <SelectItem value="narrow">{t("create.marginNarrow")}</SelectItem>
                <SelectItem value="normal">{t("create.marginNormal")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {showSpacing ? (
            <Field label={t("create.spacingLabel")}>
              <Select
                value={spec.lineSpacing}
                onValueChange={(v) =>
                  patch({ lineSpacing: v as CSpec["lineSpacing"] })
                }
              >
                <SelectTrigger className={triggerClass} aria-label={t("create.spacingLabel")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="college">
                    {t("create.spacingCollege")}
                  </SelectItem>
                  <SelectItem value="wide">{t("create.spacingWide")}</SelectItem>
                  <SelectItem value="narrow">
                    {t("create.spacingNarrow")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
          ) : null}

          {showGrid ? (
            <Field label={t("create.gridLabel")}>
              <Select
                value={spec.gridSize}
                onValueChange={(v) => patch({ gridSize: v as CSpec["gridSize"] })}
              >
                <SelectTrigger className={triggerClass} aria-label={t("create.gridLabel")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="5mm">{t("create.grid5")}</SelectItem>
                  <SelectItem value="2.5mm">{t("create.grid2")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          ) : null}

          {showMarginLine ? (
            <div className="flex items-center justify-between gap-3 rounded-btn border border-border px-3 py-2">
              <Label className="text-sm font-normal text-foreground">
                {t("create.marginLineLabel")}
              </Label>
              <Switch
                checked={spec.marginLine}
                onCheckedChange={(v) => patch({ marginLine: v })}
                aria-label={t("create.marginLineLabel")}
              />
            </div>
          ) : null}

          {showHeaderLine ? (
            <div className="flex items-center justify-between gap-3 rounded-btn border border-border px-3 py-2">
              <Label className="text-sm font-normal text-foreground">
                {t("create.headerLineLabel")}
              </Label>
              <Switch
                checked={spec.headerLine}
                onCheckedChange={(v) => patch({ headerLine: v })}
                aria-label={t("create.headerLineLabel")}
              />
            </div>
          ) : null}
        </fieldset>
      </div>

      {/* CTA */}
      <div className="flex flex-col items-center gap-2">
        <Button
          type="button"
          size="touch"
          onClick={createPdf}
          disabled={busy}
          className="w-full max-w-sm rounded-btn font-semibold"
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Sparkles className="size-4" aria-hidden="true" />
          )}
          {busy ? t("create.creating") : t("create.cta")}
        </Button>
        <p className="text-xs text-muted-foreground">{t("create.pickHint")}</p>
      </div>

      {/* progress */}
      {pct !== null ? (
        <div
          className="flex items-center gap-2 rounded-card border border-border bg-card p-3 text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span>{t("create.creating")}</span>
        </div>
      ) : null}

      {/* success chip */}
      {done ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-card p-3 text-sm text-foreground"
          role="status"
        >
          <CheckCircle2
            className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
            aria-hidden="true"
          />
          <span className="font-medium">{done.name}</span>
          <span className="text-xs text-muted-foreground">
            {t("create.doneDetail", { pages: done.pages })}
          </span>
        </div>
      ) : null}
    </div>
  );
}
