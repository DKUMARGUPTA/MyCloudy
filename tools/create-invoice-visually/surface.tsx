"use client";

/**
 * Create invoice visually surface (RB5-a) — the WYSIWYG invoice
 * designer, 100% on-device (mode D), EN + हिंदी.
 *
 * The canvas is the FIXED A4 portrait sheet (793.7 × 1122.5 px @ 96 dpi
 * = 595.28 × 841.89 pt) shown at a CSS scale (auto-fit or zoom). Every
 * element renders at its exact canvas px box, so the exported PDF —
 * which multiplies the same numbers by 72/96 — reproduces the layout
 * the user arranged (model.buildCommands is the single shared math).
 *
 * Interactions (mouse + touch, one pointer-event path):
 *  - tap an element → select (dashed outline + mini toolbar);
 *  - drag ≥ 4 screen px → move, snapped to the 8 pt grid (model.moveElement);
 *  - corner handle → resize-lite (width everywhere, height for the logo);
 *  - keyboard: arrows nudge one grid step, Delete removes the block;
 *  - text blocks are contentEditable right on the page (the DOM is the
 *    source of truth while focused; state syncs on input, never against
 *    the caret).
 *
 * The items editor (qty × rate → computed amounts, one tax %, currency,
 * doc number) lives in the side panel; the table + totals blocks on the
 * canvas are views of that shared data — money is recomputed everywhere.
 *
 * Stepper flow: the whole doc syncs into the `canvas` option on every
 * change (create-card/resume pattern), so the ToolShell CTA runs the
 * worker through the normal processing/result phases; the in-surface
 * Download button spawns the SAME worker directly (create-resume
 * spawnRun port). The draft auto-saves to localStorage (dp_civ).
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowDown,
  ArrowUp,
  Bold,
  Italic,
  ImagePlus,
  Loader2,
  Maximize2,
  Minus,
  Plus,
  RotateCcw,
  Sigma,
  Table2,
  Trash2,
  Type,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { downloadBlob } from "@/lib/files/output";
import { resolveHeicPreview } from "@/lib/heic/heic-preview";
import type { WorkerResponse } from "@/lib/workers/protocol";
import {
  CANVAS_H_PX,
  CANVAS_W_PX,
  PX_PER_PT,
  serializeCanvas,
  deserializeCanvas,
  type CanvasElement,
  type InvoiceCanvasDoc,
} from "./types";
import {
  CELL_PAD,
  MAX_IMG_DATAURL,
  MAX_ITEMS,
  MAX_FONT,
  MIN_FONT,
  MIN_H_PX,
  CURRENCIES,
  computeTotals,
  defaults,
  deleteElement,
  bringForward,
  moveElement,
  newId,
  outputName,
  resizeElement,
  sendBackward,
  tableCols,
  updateElement,
  pxToPt,
  ptToPx,
} from "./model";

/* ------------------------------------------------------------------ */
/* Constants                                                            */
/* ------------------------------------------------------------------ */

const DRAFT_KEY = "dp_civ";
const FONT_STACK =
  '"Noto Sans Devanagari","Nirmala UI",Helvetica,Arial,sans-serif';
const COLOR_PRESETS = [
  "#111111",
  "#555555",
  "#7a2e2e",
  "#0b6b4d",
  "#0f6b6b",
  "#8a6d1e",
];
const MAX_LOGO_PX = 600;
const GRID_STEP_PX = 8 * PX_PER_PT; // one 8 pt grid step in canvas px

/* ------------------------------------------------------------------ */
/* Logo upload helpers (create-resume recipe, rectangular)             */
/* ------------------------------------------------------------------ */

function drawToPng(im: HTMLImageElement): string | null {
  const k = Math.min(1, MAX_LOGO_PX / Math.max(im.width, im.height, 1));
  const w = Math.max(1, Math.round(im.width * k));
  const h = Math.max(1, Math.round(im.height * k));
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(im, 0, 0, w, h);
  return cv.toDataURL("image/png");
}

function decodeImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = src;
  });
}

function readAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** Any raster file → ≤600 px PNG data-URL (HEIC falls back to libheif). */
async function fileToPngDataUrl(file: File): Promise<string | null> {
  const direct = await readAsDataUrl(file);
  if (direct) {
    const im = await decodeImage(direct);
    if (im) {
      const url = drawToPng(im);
      if (url) return url;
    }
  }
  // Safari photos arrive as HEIC — decode with the self-hosted WASM.
  try {
    const prev = await resolveHeicPreview(file, MAX_LOGO_PX);
    if (prev) {
      const im = await decodeImage(prev.url);
      if (im) return drawToPng(im);
    }
  } catch {
    /* fall through */
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* contentEditable text block — DOM is the truth while focused          */
/* ------------------------------------------------------------------ */

function EditableText({
  text,
  onInput,
  style,
}: {
  text: string;
  onInput: (next: string) => void;
  style: CSSProperties;
}): React.ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  // Sync state → DOM only when NOT editing (external changes: draft
  // restore, reset, locale sample swap). While focused the DOM wins,
  // so the caret never jumps mid-typing.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (document.activeElement === node) return;
    if (node.innerText !== text) node.innerText = text;
  }, [text]);
  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
      onInput={(e) => onInput(e.currentTarget.innerText.replace(/\n+$/, ""))}
      className="h-full w-full whitespace-pre-wrap break-words outline-none"
      style={style}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Surface                                                              */
/* ------------------------------------------------------------------ */

export function CreateInvoiceVisuallySurface(props: ToolSurfaceProps) {
  const { onChange } = props;
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const runLocale = locale === "hi" ? "hi" : "en";

  /* ---------- state (localStorage draft is the editor truth) ------- */
  const [doc, setDoc] = useState<InvoiceCanvasDoc>(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const run = deserializeCanvas(raw);
        if (run) return run.d;
      }
    } catch {
      /* corrupt draft → defaults */
    }
    return defaults(runLocale);
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fontsTick, setFontsTick] = useState(0);
  // wrap width via ResizeObserver subscription (setState in the observer
  // callback — the lint-clean pattern); autoK is derived during render.
  const [wrapW, setWrapW] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [zoomMode, setZoomMode] = useState<"fit" | number>("fit");

  const docRef = useRef(doc);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const scaleRef = useRef(1);
  const dragRef = useRef<{
    id: string;
    mode: "move" | "resizeW" | "resizeWH";
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    origW: number;
    origH: number;
  } | null>(null);

  const selected = doc.elements.find((e) => e.id === selectedId) ?? null;
  const totals = useMemo(
    () => computeTotals(doc.items, doc.taxPct),
    [doc.items, doc.taxPct]
  );

  /* ---------- preview font (self-hosted Devanagari, resume recipe) -- */
  useEffect(() => {
    const face = new FontFace(
      "Noto Sans Devanagari",
      "url(/fonts/NotoSansDevanagari-Regular.ttf)"
    );
    document.fonts.add(face);
    let alive = true;
    void face
      .load()
      .then(() => {
        if (alive) setFontsTick((tick) => tick + 1);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      document.fonts.delete(face);
    };
  }, []);

  /* ---------- fit-to-width (create-resume fit() port) + zoom ------- */
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWrapW(e.contentRect.width);
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);
  const autoK =
    wrapW > 0 && Number.isFinite(wrapW) ? Math.min(1, wrapW / CANVAS_W_PX) : 1;
  const scale = zoomMode === "fit" ? autoK : zoomMode;
  // CR-66 lesson: NEVER write a ref during render — sync it in an effect
  // (the drag pointermove handler reads scaleRef.current later, and every
  // state change re-runs this effect before any new pointer event lands).
  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  /* ---------- draft + option sync (create-card pattern) ----------- */
  useEffect(() => {
    docRef.current = doc;
    try {
      localStorage.setItem(
        DRAFT_KEY,
        serializeCanvas({ d: doc, labels: {}, locale: runLocale })
      );
    } catch {
      /* quota — the run option below still carries the doc */
    }
  }, [doc, runLocale]);

  const buildLabels = useCallback(
    () => ({
      desc: t("civ.descLabel"),
      qty: t("civ.qtyLabel"),
      rate: t("civ.rateLabel"),
      amount: t("civ.amountLabel"),
      subtotal: t("civ.subtotalLabel"),
      tax: t("civ.taxWord"),
      total: t("civ.totalLabel"),
    }),
    [t]
  );

  useEffect(() => {
    onChange(
      "canvas",
      serializeCanvas({
        d: docRef.current,
        labels: buildLabels(),
        locale: runLocale,
      })
    );
  }, [doc, buildLabels, runLocale, onChange]);

  /* ---------- pure model helpers bound to the current doc ---------- */
  const update = useCallback((fn: (d: InvoiceCanvasDoc) => InvoiceCanvasDoc) => {
    setDoc((prev) => fn(prev));
  }, []);

  const elName = useCallback(
    (el: CanvasElement | null): string => {
      if (!el) return "";
      switch (el.kind) {
        case "text":
          return t("civ.elText");
        case "logo":
          return t("civ.elLogo");
        case "table":
          return t("civ.elTable");
        case "totals":
          return t("civ.elTotals");
      }
    },
    [t]
  );

  /* ---------- drag machinery (crop-pdf pointer pattern) ------------ */
  const beginDrag = useCallback(
    (el: CanvasElement, mode: "move" | "resizeW" | "resizeWH") =>
      (event: ReactPointerEvent<HTMLElement>): void => {
        if (event.button !== 0) return;
        setSelectedId(el.id);
        dragRef.current = {
          id: el.id,
          mode,
          startX: event.clientX,
          startY: event.clientY,
          origX: el.x,
          origY: el.y,
          origW: el.w,
          origH: el.kind === "logo" ? el.h : 0,
        };
        try {
          sheetRef.current?.setPointerCapture(event.pointerId);
        } catch {
          /* synthetic pointers — move/up on the sheet still drive it */
        }
        // NO preventDefault: a plain tap must still focus contentEditable.
      },
    []
  );

  const onSheetPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const st = dragRef.current;
      if (!st) return;
      const k = scaleRef.current || 1;
      const dx = (event.clientX - st.startX) / k; // screen px → canvas px
      const dy = (event.clientY - st.startY) / k;
      if (!dragging && Math.abs(event.clientX - st.startX) < 4 && Math.abs(event.clientY - st.startY) < 4) {
        return; // still a tap, not a drag
      }
      if (!dragging) {
        setDragging(true);
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
      event.preventDefault();
      if (st.mode === "move") {
        update((prev) => moveElement(prev, st.id, st.origX + dx, st.origY + dy));
      } else if (st.mode === "resizeW") {
        update((prev) => resizeElement(prev, st.id, st.origW + dx));
      } else {
        update((prev) =>
          resizeElement(prev, st.id, st.origW + dx, st.origH + dy)
        );
      }
    },
    [dragging, update]
  );

  const endDrag = useCallback((): void => {
    dragRef.current = null;
    setDragging(false);
  }, []);

  const onElementKeyDown = useCallback(
    (el: CanvasElement) =>
      (event: ReactKeyboardEvent<HTMLDivElement>): void => {
        if (event.target !== event.currentTarget) return; // typing inside
        const step = GRID_STEP_PX;
        const nudge: Record<string, [number, number]> = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        };
        const d = nudge[event.key];
        if (d) {
          event.preventDefault();
          update((prev) => moveElement(prev, el.id, el.x + d[0], el.y + d[1]));
        } else if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          update((prev) => deleteElement(prev, el.id));
          setSelectedId(null);
        }
      },
    [update]
  );

  /* ---------- logo upload ------------------------------------------- */
  const onPickLogo = useCallback((): void => {
    fileInputRef.current?.click();
  }, []);

  const onLogoFile = useCallback(
    (file: File | undefined): void => {
      if (!file) return;
      if (/svg/i.test(file.type) || /\.svg$/i.test(file.name)) {
        toast({
          title: t("civ.errSvg"),
          variant: "destructive",
        });
        return;
      }
      void fileToPngDataUrl(file).then((url) => {
        if (!url) {
          toast({ title: t("civ.errImgRead"), variant: "destructive" });
          return;
        }
        if (url.length > MAX_IMG_DATAURL) {
          toast({ title: t("civ.errTooBig"), variant: "destructive" });
          return;
        }
        void decodeImage(url).then((im) => {
          const aspect = im && im.height > 0 ? im.width / im.height : 2;
          update((prev) => {
            const existing = prev.elements.find(
              (e): e is Extract<CanvasElement, { kind: "logo" }> =>
                e.kind === "logo"
            );
            if (existing) {
              return updateElement(prev, existing.id, {
                src: url,
                h: Math.max(MIN_H_PX, existing.w / aspect),
              });
            }
            const w = 96 * PX_PER_PT;
            return {
              ...prev,
              elements: [
                ...prev.elements,
                {
                  kind: "logo",
                  id: newId("logo"),
                  x: 40 * PX_PER_PT,
                  y: 32 * PX_PER_PT,
                  w,
                  h: Math.max(MIN_H_PX, w / aspect),
                  src: url,
                },
              ],
            };
          });
        });
      });
    },
    [t, toast, update]
  );

  const setLogoSize = useCallback(
    (size: number): void => {
      update((prev) => {
        const existing = prev.elements.find(
          (e): e is Extract<CanvasElement, { kind: "logo" }> => e.kind === "logo"
        );
        return existing ? updateElement(prev, existing.id, { w: size }) : prev;
      });
    },
    [update]
  );

  /* ---------- items editor ------------------------------------------ */
  const setItem = useCallback(
    (id: string, field: "desc" | "qty" | "rate", value: string | number): void => {
      update((prev) => ({
        ...prev,
        items: prev.items.map((row) =>
          row.id === id
            ? {
                ...row,
                [field]:
                  field === "desc"
                    ? String(value).slice(0, 200)
                    : Math.max(0, Number(value) || 0),
              }
            : row
        ),
      }));
    },
    [update]
  );

  const addItem = useCallback((): void => {
    update((prev) =>
      prev.items.length >= MAX_ITEMS
        ? prev
        : {
            ...prev,
            items: [...prev.items, { id: newId("r"), desc: "", qty: 1, rate: 0 }],
          }
    );
  }, [update]);

  const removeItem = useCallback(
    (id: string): void => {
      update((prev) => ({ ...prev, items: prev.items.filter((r) => r.id !== id) }));
    },
    [update]
  );

  /* ---------- add blocks -------------------------------------------- */
  const addText = useCallback((): void => {
    const id = newId("t");
    update((prev) => ({
      ...prev,
      elements: [
        ...prev.elements,
        {
          kind: "text",
          id,
          x: 40 * PX_PER_PT,
          y: 640 * PX_PER_PT,
          w: 220 * PX_PER_PT,
          text: t("civ.elText"),
          size: 10,
          bold: false,
          italic: false,
          color: "#111111",
          align: "left",
        },
      ],
    }));
    setSelectedId(id);
  }, [t, update]);

  const addBlock = useCallback(
    (kind: "table" | "totals"): void => {
      const has = doc.elements.some((e) => e.kind === kind);
      if (has) return;
      const id = kind === "table" ? "table" : "totals";
      update((prev) => ({
        ...prev,
        elements: [
          ...prev.elements,
          kind === "table"
            ? { kind: "table", id, x: 40 * PX_PER_PT, y: 288 * PX_PER_PT, w: 515 * PX_PER_PT, size: 9 }
            : { kind: "totals", id, x: 331 * PX_PER_PT, y: 368 * PX_PER_PT, w: 224 * PX_PER_PT, size: 9 },
        ],
      }));
      setSelectedId(id);
    },
    [doc.elements, update]
  );

  const resetLayout = useCallback((): void => {
    setDoc(defaults(runLocale));
    setSelectedId(null);
    toast({ title: t("civ.resetDone") });
  }, [runLocale, t, toast]);

  /* ---------- export (create-resume spawnRun port) ------------------ */
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  const spawnRun = useCallback((): void => {
    if (workerRef.current) return;
    setBusy(true);
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    const runId = Date.now();
    const cleanup = (): void => {
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
      setBusy(false);
    };
    worker.addEventListener(
      "message",
      (event: MessageEvent<WorkerResponse>) => {
        const data = event.data;
        if (!data || data.runId !== runId) return;
        if (data.type === "progress") return;
        if (data.type === "result") {
          const output = data.outputs[0];
          if (output) {
            downloadBlob(output.blob, output.name);
            toast({
              title: t("civ.doneTitle"),
              description: t("civ.doneDesc", { name: output.name }),
            });
          }
          cleanup();
          return;
        }
        toast({
          title: t("tool.errorTitle"),
          description: t(data.code, { detail: data.detail ?? "" }),
          variant: "destructive",
        });
        cleanup();
      }
    );
    worker.addEventListener("error", () => {
      toast({
        title: t("tool.errorTitle"),
        description: t("tool.errorGeneric", { detail: "" }),
        variant: "destructive",
      });
      cleanup();
    });
    worker.postMessage({
      type: "run",
      runId,
      toolId: "create-invoice-visually",
      options: {
        canvas: serializeCanvas({
          d: docRef.current,
          labels: buildLabels(),
          locale: runLocale,
        }),
      },
      files: [],
    });
  }, [buildLabels, runLocale, t, toast]);

  /* ================================================================= */
  /* Render                                                             */
  /* ================================================================= */

  const hasTable = doc.elements.some((e) => e.kind === "table");
  const hasTotals = doc.elements.some((e) => e.kind === "totals");
  const hasLogo = doc.elements.some((e) => e.kind === "logo");
  const money = (v: number): string =>
    doc.currency ? `${doc.currency} ${v.toFixed(2)}` : v.toFixed(2);

  const selStyle = (id: string): CSSProperties => ({
    outline: selectedId === id ? "2px dashed var(--primary)" : "none",
    outlineOffset: 2,
  });

  return (
    <section className="flex flex-col gap-4" aria-label={t("civ.workspace")}>
      {/* header: workspace title + actions */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">
          {t("civ.workspace")}
        </h2>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="rounded-btn"
            onClick={resetLayout}
          >
            <RotateCcw className="size-4" aria-hidden="true" />
            {t("civ.reset")}
          </Button>
          <Button
            type="button"
            size="sm"
            className="rounded-btn font-semibold"
            onClick={spawnRun}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <ArrowDownToLine className="size-4" aria-hidden="true" />
            )}
            {t("civ.download")}
          </Button>
        </div>
      </div>

      {/* toolbar for the selected block */}
      <div className="flex min-h-11 flex-wrap items-center gap-2 rounded-card border border-border bg-card p-2">
        {selected ? (
          <>
            <span className="mr-1 flex items-center gap-1.5 text-xs font-semibold text-foreground">
              {selected.kind === "text" ? (
                <Type className="size-3.5" aria-hidden="true" />
              ) : selected.kind === "table" ? (
                <Table2 className="size-3.5" aria-hidden="true" />
              ) : selected.kind === "totals" ? (
                <Sigma className="size-3.5" aria-hidden="true" />
              ) : (
                <ImagePlus className="size-3.5" aria-hidden="true" />
              )}
              {elName(selected)}
            </span>
            {selected.kind === "text" || selected.kind === "table" || selected.kind === "totals" ? (
              <span className="flex items-center gap-1" role="group" aria-label={t("civ.fontSize")}>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-7 rounded-btn"
                  aria-label={t("civ.fontSize")}
                  onClick={() =>
                    update((prev) =>
                      updateElement(prev, selected.id, {
                        size: Math.max(MIN_FONT, selected.size - 0.5),
                      })
                    )
                  }
                  disabled={selected.size <= MIN_FONT}
                >
                  <Minus className="size-3.5" aria-hidden="true" />
                </Button>
                <span className="w-10 text-center text-xs tabular-nums text-muted-foreground">
                  {selected.size.toFixed(selected.size % 1 ? 1 : 0)}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-7 rounded-btn"
                  aria-label={t("civ.fontSize")}
                  onClick={() =>
                    update((prev) =>
                      updateElement(prev, selected.id, {
                        size: Math.min(MAX_FONT, selected.size + 0.5),
                      })
                    )
                  }
                  disabled={selected.size >= MAX_FONT}
                >
                  <Plus className="size-3.5" aria-hidden="true" />
                </Button>
              </span>
            ) : null}
            {selected.kind === "text" ? (
              <>
                <Button
                  type="button"
                  variant={selected.bold ? "default" : "outline"}
                  size="icon"
                  className="size-7 rounded-btn font-bold"
                  aria-label={t("civ.bold")}
                  aria-pressed={selected.bold}
                  onClick={() =>
                    update((prev) =>
                      updateElement(prev, selected.id, { bold: !selected.bold })
                    )
                  }
                >
                  <Bold className="size-3.5" aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant={selected.italic ? "default" : "outline"}
                  size="icon"
                  className="size-7 rounded-btn italic"
                  aria-label={t("civ.italic")}
                  aria-pressed={selected.italic}
                  onClick={() =>
                    update((prev) =>
                      updateElement(prev, selected.id, { italic: !selected.italic })
                    )
                  }
                >
                  <Italic className="size-3.5" aria-hidden="true" />
                </Button>
                <span className="flex items-center gap-1" role="group" aria-label={t("civ.align")}>
                  {(
                    [
                      ["left", AlignLeft, t("civ.alignLeft")],
                      ["center", AlignCenter, t("civ.alignCenter")],
                      ["right", AlignRight, t("civ.alignRight")],
                    ] as const
                  ).map(([align, Icon, label]) => (
                    <Button
                      key={align}
                      type="button"
                      variant={selected.align === align ? "default" : "outline"}
                      size="icon"
                      className="size-7 rounded-btn"
                      aria-label={label}
                      aria-pressed={selected.align === align}
                      onClick={() =>
                        update((prev) =>
                          updateElement(prev, selected.id, { align })
                        )
                      }
                    >
                      <Icon className="size-3.5" aria-hidden="true" />
                    </Button>
                  ))}
                </span>
                <span className="flex items-center gap-1" role="group" aria-label={t("civ.color")}>
                  {COLOR_PRESETS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={`${t("civ.color")} ${c}`}
                      className="size-5 rounded-full border border-border transition-transform hover:scale-110 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      style={{
                        background: c,
                        outline:
                          selected.color.toLowerCase() === c ? "2px solid var(--primary)" : "none",
                        outlineOffset: 2,
                      }}
                      onClick={() =>
                        update((prev) => updateElement(prev, selected.id, { color: c }))
                      }
                    />
                  ))}
                  <label className="sr-only" htmlFor={`civ-color-${selected.id}`}>
                    {t("civ.color")}
                  </label>
                  <input
                    id={`civ-color-${selected.id}`}
                    type="color"
                    className="size-5 cursor-pointer rounded border border-border bg-card"
                    value={selected.color}
                    onChange={(e) =>
                      update((prev) =>
                        updateElement(prev, selected.id, { color: e.target.value })
                      )
                    }
                  />
                </span>
              </>
            ) : null}
            {selected.kind === "logo" ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="rounded-btn"
                  onClick={onPickLogo}
                >
                  <ImagePlus className="size-3.5" aria-hidden="true" />
                  {selected.src ? t("civ.logoReplace") : t("civ.addLogoBtn")}
                </Button>
                {selected.src ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="rounded-btn"
                    onClick={() =>
                      update((prev) => updateElement(prev, selected.id, { src: "" }))
                    }
                  >
                    {t("civ.logoRemove")}
                  </Button>
                ) : null}
              </>
            ) : null}
            <span className="ml-auto flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-7 rounded-btn"
                aria-label={t("civ.backward")}
                onClick={() => update((prev) => sendBackward(prev, selected.id))}
              >
                <ArrowDown className="size-3.5" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-7 rounded-btn"
                aria-label={t("civ.forward")}
                onClick={() => update((prev) => bringForward(prev, selected.id))}
              >
                <ArrowUp className="size-3.5" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-7 rounded-btn text-destructive hover:text-destructive"
                aria-label={t("civ.deleteEl")}
                onClick={() => {
                  update((prev) => deleteElement(prev, selected.id));
                  setSelectedId(null);
                }}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </Button>
            </span>
          </>
        ) : (
          <p className="px-1 text-xs text-muted-foreground">{t("civ.toolbarEmpty")}</p>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_330px]">
        {/* ---------------- canvas column ---------------- */}
        <div className="flex min-w-0 flex-col gap-2">
          {/* add + zoom row */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-btn"
              onClick={addText}
            >
              <Type className="size-3.5" aria-hidden="true" />
              {t("civ.addText")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-btn"
              onClick={() => addBlock("table")}
              disabled={hasTable}
              title={hasTable ? t("civ.onlyOnce") : undefined}
            >
              <Table2 className="size-3.5" aria-hidden="true" />
              {t("civ.addTable")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-btn"
              onClick={() => addBlock("totals")}
              disabled={hasTotals}
              title={hasTotals ? t("civ.onlyOnce") : undefined}
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {t("civ.addTotals")}
            </Button>
            {!hasLogo ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-btn"
                onClick={onPickLogo}
              >
                <ImagePlus className="size-3.5" aria-hidden="true" />
                {t("civ.addLogoBtn")}
              </Button>
            ) : null}
            <span className="ml-auto flex items-center gap-1" role="group" aria-label={t("civ.zoomFit")}>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-7 rounded-btn"
                aria-label={t("civ.zoomOut")}
                onClick={() => setZoomMode(Math.max(0.3, scale / 1.25))}
              >
                <ZoomOut className="size-3.5" aria-hidden="true" />
              </Button>
              <span className="w-11 text-center text-xs tabular-nums text-muted-foreground">
                {Math.round(scale * 100)}%
              </span>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-7 rounded-btn"
                aria-label={t("civ.zoomIn")}
                onClick={() => setZoomMode(Math.min(3, scale * 1.25))}
              >
                <ZoomIn className="size-3.5" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-7 rounded-btn"
                aria-label={t("civ.zoomFit")}
                aria-pressed={zoomMode === "fit"}
                onClick={() => setZoomMode("fit")}
              >
                <Maximize2 className="size-3.5" aria-hidden="true" />
              </Button>
            </span>
          </div>

          {/* the fixed A4 sheet */}
          <div ref={wrapRef} className="min-w-0 overflow-x-auto">
            <div
              style={{ width: CANVAS_W_PX * scale, height: CANVAS_H_PX * scale, position: "relative" }}
            >
              <div
                ref={sheetRef}
                role="region"
                aria-label={t("civ.canvasLabel")}
                className="absolute left-0 top-0 bg-white shadow-md"
                style={{
                  width: CANVAS_W_PX,
                  height: CANVAS_H_PX,
                  transform: `scale(${scale})`,
                  transformOrigin: "0 0",
                  fontFamily: FONT_STACK,
                  userSelect: dragging ? "none" : undefined,
                  cursor: dragging ? "grabbing" : undefined,
                }}
                onPointerMove={onSheetPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onPointerDown={(e) => {
                  if (e.target === e.currentTarget) setSelectedId(null);
                }}
              >
                {doc.elements.map((el) => {
                  const common = {
                    className:
                      "absolute outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                    style: {
                      left: el.x,
                      top: el.y,
                      width: el.w,
                      ...selStyle(el.id),
                    } as CSSProperties,
                    tabIndex: 0,
                    role: "group" as const,
                    "aria-label": elName(el),
                    onPointerDown: beginDrag(el, "move"),
                    onKeyDown: onElementKeyDown(el),
                  };
                  if (el.kind === "text") {
                    return (
                      <div key={el.id} {...common} data-kind="text">
                        <EditableText
                          text={el.text}
                          onInput={(next) =>
                            update((prev) => updateElement(prev, el.id, { text: next }))
                          }
                          style={{
                            fontSize: el.size * PX_PER_PT,
                            lineHeight: 1.35,
                            color: el.color,
                            fontWeight: el.bold ? 700 : 400,
                            fontStyle: el.italic ? "italic" : "normal",
                            textAlign: el.align,
                            minHeight: el.size * PX_PER_PT,
                          }}
                        />
                      </div>
                    );
                  }
                  if (el.kind === "logo") {
                    return (
                      <div key={el.id} {...common} style={{ ...common.style, height: el.h }} data-kind="logo">
                        {el.src ? (
                          <img
                            src={el.src}
                            alt={t("civ.elLogo")}
                            draggable={false}
                            className="pointer-events-none h-full w-full"
                            style={{ objectFit: "fill" }}
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={onPickLogo}
                            className="flex h-full w-full flex-col items-center justify-center gap-1 rounded-sm border border-dashed border-border bg-muted/40 text-muted-foreground transition-colors hover:bg-muted"
                          >
                            <ImagePlus className="size-4" aria-hidden="true" />
                            <span className="px-2 text-center text-[9px] leading-tight">
                              {t("civ.logoPlaceholder")}
                            </span>
                          </button>
                        )}
                        {selectedId === el.id ? (
                          <span
                            aria-hidden="true"
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              beginDrag(el, "resizeWH")(e);
                            }}
                            className="absolute -bottom-1.5 -right-1.5 size-3 cursor-nwse-resize rounded-sm border border-background"
                            style={{ background: "var(--primary)", touchAction: "none" }}
                          />
                        ) : null}
                      </div>
                    );
                  }
                  if (el.kind === "table") {
                    const headerH = Math.round(el.size * 2) * PX_PER_PT;
                    const rowH = Math.round(el.size * 1.9) * PX_PER_PT;
                    const fs = el.size * PX_PER_PT;
                    const cols = tableCols(0, pxToPt(el.w));
                    const cell = (anchorPt: number, wPx: number): CSSProperties => ({
                      position: "absolute",
                      top: 0,
                      bottom: 0,
                      left: ptToPx(anchorPt) - wPx,
                      width: wPx,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "flex-end",
                      overflow: "hidden",
                      whiteSpace: "nowrap",
                    });
                    const descCell: CSSProperties = {
                      position: "absolute",
                      top: 0,
                      bottom: 0,
                      left: ptToPx(cols.descX),
                      width: Math.max(40, ptToPx(cols.qtyR) - ptToPx(cols.descX) - 8),
                      display: "flex",
                      alignItems: "center",
                      overflow: "hidden",
                      whiteSpace: "nowrap",
                    };
                    return (
                      <div
                        key={el.id}
                        {...common}
                        data-kind="table"
                        style={{ ...common.style, outline: selectedId === el.id ? "2px dashed var(--primary)" : "0.75pt solid #b9c0bb", outlineOffset: selectedId === el.id ? 2 : 0, fontSize: fs, lineHeight: 1.35 }}
                      >
                        <div
                          style={{
                            position: "relative",
                            height: headerH,
                            background: "#e9ede9",
                            fontWeight: 700,
                            color: "#111111",
                          }}
                        >
                          <span style={{ ...descCell, justifyContent: "flex-start" }}>
                            {t("civ.descLabel")}
                          </span>
                          <span style={cell(cols.qtyR, el.w * 0.12)}>{t("civ.qtyLabel")}</span>
                          <span style={cell(cols.rateR, el.w * 0.15)}>{t("civ.rateLabel")}</span>
                          <span style={cell(cols.amtR, el.w * 0.18)}>{t("civ.amountLabel")}</span>
                        </div>
                        {doc.items.map((row) => (
                          <div
                            key={row.id}
                            style={{
                              position: "relative",
                              height: rowH,
                              borderBottom: "0.5pt solid #b9c0bb",
                              color: "#111111",
                            }}
                          >
                            <span style={{ ...descCell, justifyContent: "flex-start" }}>
                              {row.desc}
                            </span>
                            <span style={cell(cols.qtyR, el.w * 0.12)}>
                              {String(row.qty)}
                            </span>
                            <span style={cell(cols.rateR, el.w * 0.15)}>
                              {row.rate.toFixed(2)}
                            </span>
                            <span style={cell(cols.amtR, el.w * 0.18)}>
                              {money(row.qty * row.rate)}
                            </span>
                          </div>
                        ))}
                        {doc.items.length === 0 ? (
                          <div
                            style={{
                              position: "relative",
                              height: rowH,
                              color: "#999999",
                            }}
                          >
                            <span style={{ ...descCell, justifyContent: "flex-start" }}>
                              {t("civ.emptyItems")}
                            </span>
                          </div>
                        ) : null}
                        {selectedId === el.id ? (
                          <span
                            aria-hidden="true"
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              beginDrag(el, "resizeW")(e);
                            }}
                            className="absolute -bottom-1.5 -right-1.5 size-3 cursor-nwse-resize rounded-sm border border-background"
                            style={{ background: "var(--primary)", touchAction: "none" }}
                          />
                        ) : null}
                      </div>
                    );
                  }
                  if (el.kind === "totals") {
                    const rowH = Math.round(el.size * 1.7) * PX_PER_PT;
                    const fs = el.size * PX_PER_PT;
                    const rows: { label: string; value: string; strong: boolean }[] = [
                      { label: t("civ.subtotalLabel"), value: money(totals.subtotal), strong: false },
                      {
                        label: `${t("civ.taxWord")} (${doc.taxPct}%)`,
                        value: money(totals.tax),
                        strong: false,
                      },
                      { label: t("civ.totalLabel"), value: money(totals.total), strong: true },
                    ];
                    return (
                      <div
                        key={el.id}
                        {...common}
                        data-kind="totals"
                        style={{
                          ...common.style,
                          fontSize: fs,
                          lineHeight: 1.35,
                        }}
                      >
                        {rows.map((row, i) => (
                          <div
                            key={row.label}
                            style={{
                              position: "relative",
                              height: rowH,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              borderTop: row.strong ? "1pt solid #333333" : undefined,
                              color: row.strong ? "#111111" : "#555555",
                              fontWeight: row.strong ? 700 : 400,
                            }}
                          >
                            <span>{row.label}</span>
                            <span style={{ paddingRight: CELL_PAD * PX_PER_PT }}>
                              {row.value}
                            </span>
                          </div>
                        ))}
                        {selectedId === el.id ? (
                          <span
                            aria-hidden="true"
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              beginDrag(el, "resizeW")(e);
                            }}
                            className="absolute -bottom-1.5 -right-1.5 size-3 cursor-nwse-resize rounded-sm border border-background"
                            style={{ background: "var(--primary)", touchAction: "none" }}
                          />
                        ) : null}
                      </div>
                    );
                  }
                  return null;
                })}
              </div>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">{t("civ.canvasNote")}</p>
        </div>

        {/* ---------------- side panel: items + settings ---------------- */}
        <aside className="flex min-w-0 flex-col gap-4">
          <section
            className="rounded-card border border-border bg-card p-4"
            aria-labelledby="civ-items-title"
          >
            <h3 id="civ-items-title" className="text-sm font-semibold text-foreground">
              {t("civ.itemsTitle")}
            </h3>
            <p className="mt-1 text-[11px] text-muted-foreground">{t("civ.itemsHint")}</p>
            <ul className="mt-3 flex max-h-96 flex-col gap-2 overflow-y-auto scrollbar-thin pr-1">
              {doc.items.length === 0 ? (
                <li className="rounded-btn border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                  {t("civ.emptyItems")}
                </li>
              ) : null}
              {doc.items.map((row, i) => (
                <li key={row.id} className="flex flex-wrap items-center gap-1.5">
                  <span className="w-4 shrink-0 text-xs tabular-nums text-muted-foreground">
                    {i + 1}
                  </span>
                  <Input
                    defaultValue={row.desc}
                    aria-label={`${t("civ.descLabel")} ${i + 1}`}
                    className="min-w-0 flex-1 rounded-btn text-xs"
                    maxLength={200}
                    onBlur={(e) => setItem(row.id, "desc", e.target.value)}
                  />
                  <Input
                    type="number"
                    min={0}
                    step="any"
                    defaultValue={row.qty}
                    aria-label={`${t("civ.qtyLabel")} ${i + 1}`}
                    className="w-14 rounded-btn text-xs tabular-nums"
                    onChange={(e) => setItem(row.id, "qty", e.target.value)}
                    onBlur={(e) => {
                      e.target.value = String(row.qty);
                    }}
                  />
                  <Input
                    type="number"
                    min={0}
                    step="any"
                    defaultValue={row.rate}
                    aria-label={`${t("civ.rateLabel")} ${i + 1}`}
                    className="w-20 rounded-btn text-xs tabular-nums"
                    onChange={(e) => setItem(row.id, "rate", e.target.value)}
                    onBlur={(e) => {
                      e.target.value = String(row.rate);
                    }}
                  />
                  <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {(row.qty * row.rate).toFixed(2)}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0 rounded-btn text-muted-foreground hover:text-destructive"
                    aria-label={t("civ.removeItem")}
                    onClick={() => removeItem(row.id)}
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3 w-full rounded-btn"
              onClick={addItem}
              disabled={doc.items.length >= MAX_ITEMS}
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {t("civ.addItem")}
            </Button>
            <dl className="mt-3 space-y-1 border-t border-border pt-3 text-xs">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">{t("civ.subtotalLabel")}</dt>
                <dd className="tabular-nums">{money(totals.subtotal)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">
                  {t("civ.taxWord")} ({doc.taxPct}%)
                </dt>
                <dd className="tabular-nums">{money(totals.tax)}</dd>
              </div>
              <div className="flex justify-between font-semibold">
                <dt>{t("civ.totalLabel")}</dt>
                <dd className="tabular-nums">{money(totals.total)}</dd>
              </div>
            </dl>
          </section>

          <section
            className="rounded-card border border-border bg-card p-4"
            aria-labelledby="civ-settings-title"
          >
            <h3 id="civ-settings-title" className="text-sm font-semibold text-foreground">
              {t("civ.settingsTitle")}
            </h3>
            <div className="mt-3 grid gap-3">
              <div className="grid grid-cols-2 items-end gap-3">
                <div>
                  <Label htmlFor="civ-tax" className="text-xs">
                    {t("civ.taxLabel")}
                  </Label>
                  <Input
                    id="civ-tax"
                    type="number"
                    min={0}
                    max={50}
                    step={0.5}
                    defaultValue={doc.taxPct}
                    className="mt-1 rounded-btn text-xs tabular-nums"
                    onChange={(e) =>
                      update((prev) => ({
                        ...prev,
                        taxPct: Math.max(0, Math.min(50, Number(e.target.value) || 0)),
                      }))
                    }
                  />
                </div>
                <div>
                  <span className="text-xs font-medium">{t("civ.currencyLabel")}</span>
                  <div className="mt-1 flex gap-1" role="group" aria-label={t("civ.currencyLabel")}>
                    {CURRENCIES.map((c) => (
                      <button
                        key={c || "none"}
                        type="button"
                        aria-label={c || "—"}
                        aria-pressed={doc.currency === c}
                        onClick={() => update((prev) => ({ ...prev, currency: c }))}
                        className={
                          "h-8 min-w-8 rounded-btn border px-2 text-xs font-semibold transition-colors " +
                          (doc.currency === c
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-background text-foreground hover:bg-accent")
                        }
                      >
                        {c || "—"}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div>
                <Label htmlFor="civ-docno" className="text-xs">
                  {t("civ.docNoLabel")}
                </Label>
                <Input
                  id="civ-docno"
                  defaultValue={doc.docNumber}
                  className="mt-1 rounded-btn text-xs"
                  maxLength={40}
                  onBlur={(e) =>
                    update((prev) => ({ ...prev, docNumber: e.target.value }))
                  }
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t("civ.docNoHint")} → {outputName(doc)}.pdf
                </p>
              </div>
            </div>
          </section>
        </aside>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,.heic,.heif"
        className="hidden"
        onChange={(e) => {
          onLogoFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </section>
  );
}
