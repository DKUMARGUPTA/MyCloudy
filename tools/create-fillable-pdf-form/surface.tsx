"use client";

/**
 * Create fillable PDF form surface (P3-FORM — the 65th tool).
 *
 * landingSurface + fullWidthSurface (create-invoice pattern): no files,
 * the surface owns BOTH the landing template picker and the builder
 * workspace. The "Save as PDF" button spawns the worker directly.
 *
 *  - CANVAS: the exact A4 replica at px geometry (794×1123 CSS px =
 *    595.28×841.89 pt ×0.75), scaled to fit. Static text wraps with the
 *    SAME pure wrapText + measurer recipe the PDF painter uses, so the
 *    preview is what prints.
 *  - STATE: survives remounts through the serialized "form" option
 *    (create-card pattern — one commit path, onChange never inside a
 *    setState updater); the draft autosaves to localStorage
 *    (dp_form_draft) and up to 30 named forms live in dp_form_saved.
 *  - TEST FILL: field boxes become real HTML inputs; calculation rules
 *    run through the SAME emitted JavaScript the PDF carries (new
 *    Function + a mock getField over the test values) — what you test
 *    is what Acrobat runs.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  AlignLeft,
  Calendar,
  ChevronDown,
  Copy,
  FileDown,
  Files,
  Hash,
  Heading1,
  Loader2,
  Minus,
  MousePointer2,
  RotateCcw,
  Save,
  Sigma,
  Square,
  SquareCheck,
  TextCursorInput,
  Trash2,
  TriangleAlert,
  Type,
  Variable,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ToastAction } from "@/components/ui/toast";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { downloadBlob } from "@/lib/files/output";
import type { WorkerResponse } from "@/lib/workers/protocol";
import {
  boxRect,
  compileRules,
  exportValueFor,
  docIsEmpty,
  formWarnings,
  isFieldEl,
  labelHeight,
  lineHeight,
  makeField,
  makeStatic,
  MARGIN_PX,
  STATIC_DEFAULTS,
  FIELD_DEFAULTS,
  heightForOptions,
  MAX_OPTIONS,
  MAX_RULES,
  nextId,
  nextSlot,
  PAGE_H_PX,
  PAGE_W_PX,
  parseFormDoc,
  radioRows,
  slugify,
  snap,
  uniqueName,
  wrapText,
  type FieldEl,
  type FieldKind,
  type FormDoc,
  type FormElement,
  type StaticEl,
  type StaticKind,
} from "./model";
import {
  instantiateTemplate,
  TEMPLATES,
  type TemplateSpec,
} from "./templates";

/* ------------------------------------------------------------------ */
/* localStorage (draft + named saved forms)                              */
/* ------------------------------------------------------------------ */

const DRAFT_KEY = "dp_form_draft";
const SAVED_KEY = "dp_form_saved";
const MAX_SAVED = 30;

interface SavedForm {
  name: string;
  ts: number;
  doc: FormDoc;
}

function readDraft(): FormDoc | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const doc = parseFormDoc(raw);
    return docIsEmpty(doc) ? null : doc;
  } catch {
    return null;
  }
}

function readSaved(): SavedForm[] {
  try {
    const list = JSON.parse(localStorage.getItem(SAVED_KEY) || "[]");
    if (!Array.isArray(list)) return [];
    return list
      .filter(
        (x): x is SavedForm =>
          typeof x === "object" &&
          x !== null &&
          typeof (x as SavedForm).name === "string"
      )
      .slice(0, MAX_SAVED);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Canvas measurer (Noto registered on the main thread — card pattern) */
/* ------------------------------------------------------------------ */

let measureCanvas: HTMLCanvasElement | null = null;

function canvasMeasure(text: string, fs: number): number {
  if (typeof document === "undefined") return text.length * fs * 0.55;
  if (!measureCanvas) measureCanvas = document.createElement("canvas");
  const ctx = measureCanvas.getContext("2d");
  if (!ctx) return text.length * fs * 0.55;
  ctx.font = `${fs}px "Noto Sans Devanagari","Nirmala UI",system-ui,sans-serif`;
  return ctx.measureText(text).width;
}

/* ------------------------------------------------------------------ */
/* Small shared bits                                                    */
/* ------------------------------------------------------------------ */

const TOOL_BTN =
  "h-11 min-h-11 gap-1.5 rounded-btn px-3 text-xs font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50";
const SMALL_BTN =
  "flex h-11 min-h-11 items-center justify-center gap-1.5 rounded-btn border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50";

const STATIC_TOOL: { kind: StaticKind; key: string; Icon: typeof Type }[] = [
  { kind: "heading", key: "form.addHeading", Icon: Heading1 },
  { kind: "text", key: "form.addText", Icon: Type },
  { kind: "divider", key: "form.addDivider", Icon: Minus },
  { kind: "box", key: "form.addBox", Icon: Square },
];

const FIELD_TOOL: { kind: FieldKind; key: string; defKey: string; Icon: typeof Type }[] = [
  { kind: "text", key: "form.addTextField", defKey: "form.defText", Icon: TextCursorInput },
  { kind: "multiline", key: "form.addMultiline", defKey: "form.defMultiline", Icon: AlignLeft },
  { kind: "number", key: "form.addNumber", defKey: "form.defNumber", Icon: Hash },
  { kind: "date", key: "form.addDate", defKey: "form.defDate", Icon: Calendar },
  { kind: "checkbox", key: "form.addCheckbox", defKey: "form.defCheckbox", Icon: SquareCheck },
  { kind: "radio", key: "form.addRadio", defKey: "form.defRadio", Icon: Variable },
  { kind: "dropdown", key: "form.addDropdown", defKey: "form.defDropdown", Icon: ChevronDown },
];

function kindLabelKey(el: FormElement): string {
  if (!isFieldEl(el)) {
    return (
      {
        heading: "form.addHeading",
        text: "form.addText",
        divider: "form.addDivider",
        box: "form.addBox",
      } as Record<StaticKind, string>
    )[el.kind];
  }
  return (
    {
      text: "form.defText",
      multiline: "form.defMultiline",
      number: "form.defNumber",
      date: "form.defDate",
      checkbox: "form.defCheckbox",
      radio: "form.defRadio",
      dropdown: "form.defDropdown",
    } as Record<FieldKind, string>
  )[el.kind];
}

function clampX(x: number): number {
  return Math.max(0, Math.min(snap(x), PAGE_W_PX - 8));
}
function clampY(y: number): number {
  return Math.max(0, Math.min(snap(y), PAGE_H_PX - 8));
}

/* ------------------------------------------------------------------ */
/* Element preview (the exact A4 replica)                               */
/* ------------------------------------------------------------------ */

interface DragState {
  id: string;
  mode: "move" | "e" | "s";
  dx: number;
  dy: number;
}

interface ElViewProps {
  el: FormElement;
  selected: boolean;
  scale: number;
  testFill: boolean;
  testValue: string;
  calcValue: string;
  onTest: (name: string, value: string) => void;
  onSelect: (id: string) => void;
  onDragStart: (
    e: ReactPointerEvent<HTMLElement>,
    el: FormElement,
    mode: "move" | "e" | "s"
  ) => void;
  onDragMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onDragEnd: (e: ReactPointerEvent<HTMLElement>) => void;
}

function ElView(props: ElViewProps): ReactNode {
  const {
    el,
    selected,
    testFill,
    testValue,
    calcValue,
    onTest,
    onDragStart,
    onDragMove,
    onDragEnd,
  } = props;

  const handlers = {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (testFill) return;
      onDragStart(e, el, "move");
    },
    onPointerMove: onDragMove,
    onPointerUp: onDragEnd,
    onPointerCancel: onDragEnd,
  };

  const box: CSSProperties = {
    position: "absolute",
    left: el.x,
    top: el.y,
    width: el.w,
    height: el.h,
    cursor: testFill ? "default" : "move",
    touchAction: "none",
    zIndex: selected ? 30 : 5,
  };

  const selCls = selected
    ? "outline-2 outline-primary"
    : "hover:outline-1 hover:outline-primary/40";

  /* ---------- statics ---------- */
  if (!isFieldEl(el)) {
    const s = el as StaticEl;
    if (s.kind === "divider") {
      return (
        <div
          {...handlers}
          style={box}
          className={selCls}
          data-el-id={el.id}
          aria-label={s.kind}
        >
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: s.h / 2 - 0.5,
              borderTop: "1px solid rgb(140 143 147)",
            }}
          />
        </div>
      );
    }
    if (s.kind === "box") {
      return (
        <div
          {...handlers}
          style={box}
          className={`rounded-[2px] border border-[rgb(140_143_147)] ${selCls}`}
          data-el-id={el.id}
          aria-label={s.kind}
        />
      );
    }
    const lines = wrapText(s.text, s.w, s.fs, canvasMeasure);
    return (
      <div
        {...handlers}
        style={{ ...box, height: Math.max(s.h, lines.length * lineHeight(s.fs)) }}
        className={selCls}
        data-el-id={el.id}
        aria-label={s.kind}
      >
        {lines.map((line, i) => (
          <div
            key={i}
            style={{
              fontSize: s.fs,
              lineHeight: `${s.fs * 1.4}px`,
              whiteSpace: "pre",
              fontWeight: s.kind === "heading" ? 700 : 400,
            }}
          >
            {line === "" ? "\u00a0" : line}
          </div>
        ))}
      </div>
    );
  }

  /* ---------- fields ---------- */
  const f = el as FieldEl;
  const lh = labelHeight(f);
  const br = boxRect(f);

  const testInput = (kind: FieldKind): ReactNode => {
    if (!testFill) return null;
    const base =
      "h-full w-full border-0 bg-transparent px-1.5 text-[12px] outline-none";
    if (kind === "multiline") {
      return (
        <textarea
          value={testValue}
          onChange={(e) => onTest(f.name, e.target.value)}
          className={`${base} resize-none py-0.5`}
          aria-label={f.label || f.name}
        />
      );
    }
    if (kind === "checkbox") {
      return (
        <input
          type="checkbox"
          checked={testValue === "on"}
          onChange={(e) => onTest(f.name, e.target.checked ? "on" : "")}
          className="size-full accent-[rgb(30_120_90)]"
          aria-label={f.label || f.name}
        />
      );
    }
    if (kind === "dropdown") {
      return (
        <select
          value={testValue}
          onChange={(e) => onTest(f.name, e.target.value)}
          className={`${base} cursor-pointer`}
          aria-label={f.label || f.name}
        >
          <option value=""></option>
          {f.options.map((opt, i) => (
            <option key={i} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    }
    const isCalc = calcValue !== "";
    return (
      <input
        type={kind === "number" ? "text" : "text"}
        inputMode={kind === "number" ? "decimal" : undefined}
        value={isCalc ? calcValue : testValue}
        readOnly={isCalc}
        placeholder={kind === "date" ? "dd/mm/yyyy" : undefined}
        onChange={(e) => onTest(f.name, e.target.value)}
        className={`${base} ${isCalc ? "bg-accent/40" : ""}`}
        aria-label={f.label || f.name}
        aria-readonly={isCalc}
      />
    );
  };

  return (
    <div
      {...handlers}
      style={box}
      className={selCls}
      data-el-id={el.id}
      data-field={f.name}
      aria-label={f.label || f.name}
    >
      {f.label ? (
        <div
          style={{
            fontSize: f.fs,
            lineHeight: `${lh}px`,
            whiteSpace: "nowrap",
            overflow: "hidden",
          }}
        >
          {f.label}
          {f.required ? <span className="text-destructive"> *</span> : null}
        </div>
      ) : null}

      {f.kind === "radio" ? (
        <div>
          {radioRows(f).map((row, i) => {
            const ev = exportValueFor(f.options[i] ?? "", i);
            return (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                height: row.h,
              }}
            >
              {testFill ? (
                <input
                  type="radio"
                  name={`tf-${f.name}`}
                  checked={testValue === ev}
                  onChange={() => onTest(f.name, ev)}
                  style={{ width: row.circle, height: row.circle }}
                  className="m-0 accent-[rgb(30_120_90)]"
                  aria-label={f.options[i] ?? f.name}
                />
              ) : (
                <span
                  style={{
                    width: row.circle,
                    height: row.circle,
                    borderRadius: "50%",
                    border: "1.5px solid rgb(115 120 128)",
                    display: "inline-block",
                    flex: "0 0 auto",
                  }}
                />
              )}
              <span style={{ fontSize: f.fs, lineHeight: 1.2 }}>
                {f.options[i]}
              </span>
            </div>
            );
          })}
        </div>
      ) : (
        <div
          style={{
            position: "relative",
            left: br.x - f.x,
            top: br.y - f.y,
            width: br.w,
            height: br.h,
          }}
        >
          <div
            className="rounded-[2px] border border-[rgb(158_166_179)] bg-white"
            style={{ position: "absolute", inset: 0 }}
          />
          {testInput(f.kind)}
          {f.kind === "number" && !testFill ? (
            f.format === "rupee" ? (
              <span
                style={{
                  position: "absolute",
                  right: "100%",
                  marginRight: 4,
                  top: "50%",
                  transform: "translateY(-50%)",
                  fontSize: f.fs,
                }}
              >
                ₹
              </span>
            ) : f.format === "percent" ? (
              <span
                style={{
                  position: "absolute",
                  left: "100%",
                  marginLeft: 4,
                  top: "50%",
                  transform: "translateY(-50%)",
                  fontSize: f.fs,
                }}
              >
                %
              </span>
            ) : null
          ) : null}
        </div>
      )}

      {selected && !testFill ? (
        <>
          <span
            role="button"
            aria-label="resize width"
            onPointerDown={(e) => onDragStart(e, f, "e")}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            style={{
              position: "absolute",
              right: -7,
              top: "50%",
              marginTop: -7,
              width: 14,
              height: 14,
              cursor: "ew-resize",
              touchAction: "none",
            }}
            className="rounded-sm border border-primary bg-primary-foreground shadow"
          />
          <span
            role="button"
            aria-label="resize height"
            onPointerDown={(e) => onDragStart(e, f, "s")}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            style={{
              position: "absolute",
              bottom: -7,
              left: "50%",
              marginLeft: -7,
              width: 14,
              height: 14,
              cursor: "ns-resize",
              touchAction: "none",
            }}
            className="rounded-sm border border-primary bg-primary-foreground shadow"
          />
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Surface                                                              */
/* ------------------------------------------------------------------ */

type MobileTab = "none" | "elements" | "props" | "pages" | "calc";

export function FormSurface(props: ToolSurfaceProps): ReactNode {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const { values, onChange } = props;

  /* ---------- one-time boot: serialized option + draft ---------- */
  const [boot] = useState(() => {
    let view: "home" | "edit" = "home";
    let doc: FormDoc | null = null;
    const raw = typeof values.form === "string" ? values.form : "";
    if (raw !== "") {
      try {
        const p = JSON.parse(raw) as { v?: unknown; doc?: unknown };
        if (p && typeof p === "object") {
          doc = parseFormDoc(p.doc);
          view = p.v === "edit" ? "edit" : "home";
        }
      } catch {
        /* unreadable option — fall through to the draft */
      }
    }
    if (!doc && typeof document !== "undefined") {
      const draft = readDraft();
      if (draft) {
        doc = draft;
        view = "edit";
      }
    }
    return { view, doc: doc ?? { title: "", pages: [{ id: "p1", elements: [] }], rules: [] } };
  });

  const [view, setView] = useState<"home" | "edit">(boot.view);
  const [doc, setDoc] = useState<FormDoc>(boot.doc);
  const [curPage, setCurPage] = useState(0);
  const [selId, setSelId] = useState<string | null>(null);
  const [testFill, setTestFill] = useState(false);
  const [testValues, setTestValues] = useState<Record<string, string>>({});
  const [savedList, setSavedList] = useState<SavedForm[]>(() =>
    typeof document === "undefined" ? [] : readSaved()
  );
  const [savedIdx, setSavedIdx] = useState("");
  const [saveName, setSaveName] = useState("");
  const [exportPct, setExportPct] = useState<number | null>(null);
  const [mobileTab, setMobileTab] = useState<MobileTab>("none");
  const [delPageArm, setDelPageArm] = useState(false);
  const [scale, setScale] = useState(1);
  const [fontsTick, setFontsTick] = useState(0);

  // Latest-value refs (the create-card mirror pattern): event handlers
  // read docRef/viewRef so closures never go stale. The mirrors are written
  // in EFFECTS (never during render — react-hooks/refs) and in the commit
  // paths themselves (event context); useRef initializers cover the boot.
  const docRef = useRef(doc);
  useEffect(() => {
    docRef.current = doc;
  }, [doc]);
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  const dragRef = useRef<{
    id: string;
    mode: "move" | "e" | "s";
    sx: number;
    sy: number;
    ox: number;
    oy: number;
    ow: number;
    oh: number;
  } | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const workerRef = useRef<Worker | null>(null);

  /* ---------- fonts for the preview measurer ---------- */
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

  /* ---------- option sync (event-context only — card pattern) ---------- */
  const syncOption = useCallback(
    (next: FormDoc, nextView: "home" | "edit"): void => {
      onChange("form", JSON.stringify({ v: nextView, doc: next }));
    },
    [onChange]
  );

  const commit = useCallback(
    (next: FormDoc): void => {
      docRef.current = next;
      setDoc(next);
      syncOption(next, viewRef.current);
    },
    [syncOption]
  );

  const initialSync = useRef(false);
  useEffect(() => {
    if (initialSync.current) return;
    initialSync.current = true;
    void Promise.resolve().then(() => {
      syncOption(docRef.current, viewRef.current);
    });
  }, [syncOption]);

  /* ---------- draft autosave ---------- */
  useEffect(() => {
    if (view !== "edit") return;
    const id = window.setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(doc));
      } catch {
        /* storage full — best-effort */
      }
    }, 500);
    return () => window.clearTimeout(id);
  }, [doc, view]);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  /* ---------- derived ---------- */
  const pageIdx = Math.min(curPage, doc.pages.length - 1);
  const page = doc.pages[pageIdx];
  const fields = useMemo(
    () =>
      doc.pages.flatMap((p) =>
        p.elements.filter(isFieldEl).map((el) => ({ name: el.name, kind: el.kind }))
      ),
    [doc]
  );
  const fieldByName = useMemo(() => {
    const m = new Map<string, FieldEl>();
    for (const p of doc.pages) {
      for (const el of p.elements) if (isFieldEl(el)) m.set(el.name, el);
    }
    return m;
  }, [doc]);
  const sel =
    (page?.elements.find((el) => el.id === selId) as FormElement | undefined) ??
    null;
  const calc = useMemo(() => compileRules(doc.rules, fields), [doc.rules, fields]);
  const warnings = useMemo(() => formWarnings(doc), [doc]);

  /* ---------- test-fill: run the SAME emitted JS ---------- */
  const calcValues = useMemo(() => {
    if (!testFill || !calc.ok) return {};
    const out: Record<string, string> = {};
    const mockDoc = {
      getField: (n: string): { value: string } => ({
        value: out[n] ?? testValues[n] ?? "",
      }),
    };
    for (const cr of calc.compiled) {
      try {
        const fn = new Function("event", cr.js);
        const ev = { value: 0 };
        fn.call(mockDoc, ev);
        out[cr.target] = Number(ev.value).toFixed(2);
      } catch {
        out[cr.target] = "";
      }
    }
    return out;
  }, [calc, testFill, testValues]);

  /* ---------- fit-to-width (invoice pattern) ---------- */
  const fit = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const k = Math.min(1, wrap.clientWidth / PAGE_W_PX);
    setScale((prev) => (Math.abs(prev - k) < 0.002 ? prev : k));
  }, []);
  useEffect(() => {
    if (view !== "edit") return;
    fit();
    const onResize = () => fit();
    window.addEventListener("resize", onResize);
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => fit())
        : null;
    if (ro && wrapRef.current) ro.observe(wrapRef.current);
    return () => {
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
    };
  }, [fit, view, pageIdx, doc.pages.length, mobileTab, fontsTick]);

  /* ---------- element helpers ---------- */
  const takenNames = useCallback(
    (excludeId: string | null): Set<string> => {
      const taken = new Set<string>();
      for (const p of docRef.current.pages) {
        for (const el of p.elements) {
          if (isFieldEl(el) && el.id !== excludeId) taken.add(el.name);
        }
      }
      return taken;
    },
    []
  );

  const updateEl = useCallback(
    (id: string, patch: Partial<FormElement>): void => {
      const next: FormDoc = {
        ...docRef.current,
        pages: docRef.current.pages.map((p, pi) =>
          pi !== pageIdx
            ? p
            : {
                ...p,
                elements: p.elements.map((el) =>
                  el.id !== id
                    ? el
                    : isFieldEl(el)
                      ? ({ ...el, ...patch } as FieldEl)
                      : ({ ...el, ...patch } as StaticEl)
                ),
              }
        ),
      };
      commit(next);
    },
    [commit, pageIdx]
  );

  const addElement = useCallback(
    (kind: StaticKind | FieldKind): void => {
      const p = docRef.current.pages[pageIdx];
      if (!p) return;
      let el: FormElement;
      if (
        kind === "heading" ||
        kind === "text" ||
        kind === "divider" ||
        kind === "box"
      ) {
        const d = STATIC_DEFAULTS[kind];
        const base = makeStatic(kind, nextId(), MARGIN_PX, MARGIN_PX, "");
        const slot = nextSlot(p.elements, d.w, d.h);
        el = { ...base, x: slot.x, y: slot.y };
      } else {
        const def = FIELD_DEFAULTS[kind as FieldKind];
        const label = t(
          (
            {
              text: "form.defText",
              multiline: "form.defMultiline",
              number: "form.defNumber",
              date: "form.defDate",
              checkbox: "form.defCheckbox",
              radio: "form.defRadio",
              dropdown: "form.defDropdown",
            } as Record<FieldKind, string>
          )[kind as FieldKind]
        );
        const field = makeField(
          kind as FieldKind,
          nextId(),
          MARGIN_PX,
          MARGIN_PX,
          label,
          takenNames(null)
        );
        const slot = nextSlot(p.elements, def.w, def.h);
        el = { ...field, x: slot.x, y: slot.y };
      }
      const next: FormDoc = {
        ...docRef.current,
        pages: docRef.current.pages.map((pp, pi) =>
          pi !== pageIdx ? pp : { ...pp, elements: [...pp.elements, el] }
        ),
      };
      commit(next);
      setSelId(el.id);
      setTestFill(false);
    },
    [commit, pageIdx, t, takenNames]
  );

  const deleteEl = useCallback(
    (id: string): void => {
      const page = docRef.current.pages[pageIdx];
      if (!page) return;
      const index = page.elements.findIndex((el) => el.id === id);
      if (index < 0) return;
      const removed = page.elements[index];
      const next: FormDoc = {
        ...docRef.current,
        pages: docRef.current.pages.map((p, pi) =>
          pi !== pageIdx
            ? p
            : { ...p, elements: p.elements.filter((el) => el.id !== id) }
        ),
      };
      const restore = { el: removed, index };
      commit(next);
      setSelId(null);
      toast({
        title: t("form.delete"),
        description: t(kindLabelKey(restore.el)),
        action: (
          <ToastAction
            altText={t("form.undoDelete")}
            onClick={() => {
              const back: FormDoc = {
                ...docRef.current,
                pages: docRef.current.pages.map((p, pi) =>
                  pi !== pageIdx
                    ? p
                    : {
                        ...p,
                        elements: [
                          ...p.elements.slice(0, restore.index),
                          restore.el,
                          ...p.elements.slice(restore.index),
                        ],
                      }
                ),
              };
              commit(back);
              setSelId(restore.el.id);
            }}
          >
            {t("form.undoDelete")}
          </ToastAction>
        ),
      });
    },
    [commit, pageIdx, t, toast]
  );

  const duplicateEl = useCallback(
    (id: string): void => {
      const p = docRef.current.pages[pageIdx];
      const src = p?.elements.find((el) => el.id === id);
      if (!p || !src) return;
      const copy: FormElement =
        isFieldEl(src)
          ? {
              ...(src as FieldEl),
              id: nextId(),
              name: uniqueName((src as FieldEl).name, takenNames(null)),
            }
          : { ...(src as StaticEl), id: nextId() };
      const next: FormDoc = {
        ...docRef.current,
        pages: docRef.current.pages.map((pp, pi) =>
          pi !== pageIdx ? pp : { ...pp, elements: [...pp.elements, copy] }
        ),
      };
      commit(next);
      setSelId(copy.id);
    },
    [commit, pageIdx, takenNames]
  );

  /* ---------- pointer drag / resize ---------- */
  const onDragStart = useCallback(
    (
      e: ReactPointerEvent<HTMLElement>,
      el: FormElement,
      mode: "move" | "e" | "s"
    ): void => {
      if (testFill) return;
      e.stopPropagation();
      setSelId(el.id);
      dragRef.current = {
        id: el.id,
        mode,
        sx: e.clientX,
        sy: e.clientY,
        ox: el.x,
        oy: el.y,
        ow: el.w,
        oh: el.h,
      };
      setDrag({ id: el.id, mode, dx: 0, dy: 0 });
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* pointer capture is best-effort */
      }
    },
    [testFill]
  );

  const onDragMove = useCallback((e: ReactPointerEvent<HTMLElement>): void => {
    const d = dragRef.current;
    if (!d) return;
    setDrag((prev) =>
      prev && prev.id === d.id && prev.mode === d.mode
        ? {
            ...prev,
            dx: (e.clientX - d.sx) / (scale || 1),
            dy: (e.clientY - d.sy) / (scale || 1),
          }
        : prev
    );
  }, [scale]);

  const onDragEnd = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      const d = dragRef.current;
      dragRef.current = null;
      const cur = drag;
      setDrag(null);
      if (!d || !cur || cur.id !== d.id) return;
      const p = docRef.current.pages[pageIdx];
      const el = p?.elements.find((x) => x.id === d.id);
      if (!el) return;
      let { x, y, w, h } = el;
      if (d.mode === "move") {
        x = clampX(d.ox + cur.dx);
        y = clampY(d.oy + cur.dy);
      } else if (d.mode === "e") {
        w = Math.max(16, Math.min(snap(d.ow + cur.dx), PAGE_W_PX - x));
        if (isFieldEl(el) && el.kind === "checkbox") {
          h = labelHeight(el) + w;
        }
      } else {
        h = Math.max(16, Math.min(snap(d.oh + cur.dy), PAGE_H_PX - y));
        if (isFieldEl(el) && el.kind === "checkbox") {
          w = h - labelHeight(el);
        }
      }
      if (x === el.x && y === el.y && w === el.w && h === el.h) return;
      updateEl(el.id, { x, y, w, h });
    },
    [drag, pageIdx, updateEl]
  );

  /* ---------- keyboard (nudge / delete / escape) ---------- */
  useEffect(() => {
    if (view !== "edit") return;
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === "Escape") {
        setSelId(null);
        return;
      }
      if (!selId) return;
      const p = docRef.current.pages[pageIdx];
      const el = p?.elements.find((x) => x.id === selId);
      if (!el) return;
      const step = e.shiftKey ? 8 : 1;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteEl(selId);
        return;
      }
      const moves: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const mv = moves[e.key];
      if (!mv) return;
      e.preventDefault();
      updateEl(el.id, {
        x: clampX(el.x + mv[0]),
        y: clampY(el.y + mv[1]),
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, selId, pageIdx, deleteEl, updateEl]);

  /* ---------- page ops ---------- */
  const addPage = useCallback((): void => {
    const next: FormDoc = {
      ...docRef.current,
      pages: [
        ...docRef.current.pages,
        { id: nextId("p"), elements: [] },
      ],
    };
    commit(next);
    setCurPage(next.pages.length - 1);
    setSelId(null);
  }, [commit]);

  const duplicatePage = useCallback((): void => {
    const p = docRef.current.pages[pageIdx];
    if (!p) return;
    const copy = {
      id: nextId("p"),
      elements: p.elements.map((el) => ({ ...el, id: nextId() })),
    };
    const pages = [...docRef.current.pages];
    pages.splice(pageIdx + 1, 0, copy);
    commit({ ...docRef.current, pages });
    setCurPage(pageIdx + 1);
  }, [commit, pageIdx]);

  const deletePage = useCallback((): void => {
    if (docRef.current.pages.length <= 1) return;
    if (!delPageArm) {
      setDelPageArm(true);
      window.setTimeout(() => setDelPageArm(false), 2500);
      return;
    }
    setDelPageArm(false);
    const pages = docRef.current.pages.filter((_, i) => i !== pageIdx);
    commit({ ...docRef.current, pages });
    setCurPage(Math.max(0, Math.min(pageIdx, pages.length - 1)));
    setSelId(null);
  }, [commit, delPageArm, pageIdx]);

  /* ---------- rules ops ---------- */
  const addRule = useCallback((): void => {
    if (docRef.current.rules.length >= MAX_RULES) return;
    commit({
      ...docRef.current,
      rules: [
        ...docRef.current.rules,
        { id: nextId("r"), target: "", expr: "" },
      ],
    });
  }, [commit]);

  const setRule = useCallback(
    (id: string, patch: { target?: string; expr?: string }): void => {
      commit({
        ...docRef.current,
        rules: docRef.current.rules.map((r) =>
          r.id === id ? { ...r, ...patch } : r
        ),
      });
    },
    [commit]
  );

  const removeRule = useCallback(
    (id: string): void => {
      commit({
        ...docRef.current,
        rules: docRef.current.rules.filter((r) => r.id !== id),
      });
    },
    [commit]
  );

  /* ---------- templates / new / saved ---------- */
  const loadTemplate = useCallback(
    (spec: TemplateSpec): void => {
      const docNext = instantiateTemplate(
        spec,
        spec.id === "blank" ? t("form.untitled") : t(spec.nameKey),
        t
      );
      docRef.current = docNext;
      setDoc(docNext);
      setView("edit");
      viewRef.current = "edit";
      syncOption(docNext, "edit");
      setCurPage(0);
      setSelId(null);
      setTestFill(false);
      setTestValues({});
      setMobileTab("none");
    },
    [syncOption, t]
  );

  const onNew = useCallback((): void => {
    const fresh = instantiateTemplate(
      TEMPLATES[TEMPLATES.length - 1],
      t("form.untitled"),
      t
    );
    docRef.current = fresh;
    setDoc(fresh);
    setView("home");
    viewRef.current = "home";
    syncOption(fresh, "home");
    setCurPage(0);
    setSelId(null);
    setTestFill(false);
    setTestValues({});
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* best-effort */
    }
  }, [syncOption, t]);

  const saveCurrent = useCallback((): void => {
    const name =
      (saveName || docRef.current.title || t("form.untitled")).slice(0, 80);
    const entry: SavedForm = { name, ts: Date.now(), doc: docRef.current };
    const list = [entry, ...savedList.filter((x) => x.name !== name)].slice(
      0,
      MAX_SAVED
    );
    setSavedList(list);
    setSaveName("");
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(list));
      toast({ title: t("form.save"), description: name });
    } catch {
      toast({
        title: t("tool.errorTitle"),
        description: t("tool.errorGeneric", { detail: "" }),
        variant: "destructive",
      });
    }
  }, [saveName, savedList, t, toast]);

  const loadSaved = useCallback(
    (idx: string): void => {
      setSavedIdx(idx);
      const entry = savedList[Number(idx)];
      if (!entry) return;
      const loaded = parseFormDoc(JSON.stringify(entry.doc));
      docRef.current = loaded;
      setDoc(loaded);
      setView("edit");
      viewRef.current = "edit";
      syncOption(loaded, "edit");
      setCurPage(0);
      setSelId(null);
      setTestFill(false);
      setTestValues({});
    },
    [savedList, syncOption]
  );

  const deleteSaved = useCallback((): void => {
    if (savedIdx === "") return;
    const list = savedList.filter((_, i) => String(i) !== savedIdx);
    setSavedList(list);
    setSavedIdx("");
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(list));
    } catch {
      /* best-effort */
    }
  }, [savedIdx, savedList]);

  /* ---------- export ---------- */
  const exportPdf = useCallback((): void => {
    if (workerRef.current) return;
    setExportPct(0);
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
          setExportPct(data.pct);
          return;
        }
        if (data.type === "result") {
          setExportPct(null);
          const output = data.outputs[0];
          if (output) {
            downloadBlob(output.blob, output.name);
            toast({
              title: t("form.doneTitle"),
              description: t("form.doneDesc", { name: output.name }),
            });
          }
          cleanup();
          return;
        }
        if (data.type === "error") {
          setExportPct(null);
          toast({
            title: t("tool.errorTitle"),
            description: t("tool.errorGeneric", { detail: "" }),
            variant: "destructive",
          });
          cleanup();
        }
      }
    );
    worker.addEventListener("error", () => {
      setExportPct(null);
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
      toolId: "create-fillable-pdf-form",
      options: { form: JSON.stringify(docRef.current) },
      files: [],
    });
  }, [t, toast]);

  /* ---------- test fill ---------- */
  const onTest = useCallback((name: string, value: string): void => {
    setTestValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  /* ---------- render: template picker ---------- */
  const homeView = (
    <section className="flex flex-col gap-6" aria-label={t("form.pickTitle")}>
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          {t("form.pickTitle")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("form.pickDesc")}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {TEMPLATES.map((spec) => (
          <article
            key={spec.id}
            className="flex flex-col gap-3 rounded-card border border-border bg-card p-4"
          >
            <div
              aria-hidden="true"
              className="flex h-24 flex-col gap-1.5 rounded-md border border-border bg-background p-3"
            >
              <span className="h-2.5 w-1/2 rounded-sm bg-foreground/70" />
              <span className="h-1.5 w-3/4 rounded-sm bg-foreground/25" />
              <span className="mt-1 h-4 w-full rounded-sm border border-[rgb(158_166_179)]" />
              <span className="h-4 w-2/3 rounded-sm border border-[rgb(158_166_179)]" />
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-full border border-[rgb(115_120_128)]" />
                <span className="size-2.5 rounded-full border border-[rgb(115_120_128)]" />
              </span>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                {t(spec.nameKey)}
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {t(spec.descKey)}
              </p>
            </div>
            <Button
              type="button"
              className={`${TOOL_BTN} mt-auto w-full font-semibold`}
              onClick={() => loadTemplate(spec)}
            >
              {t("form.use")}
            </Button>
          </article>
        ))}
      </div>

      <div className="rounded-card border border-border bg-card p-4">
        <h2 className="text-sm font-semibold text-foreground">
          {t("form.savedTitle")}
        </h2>
        {savedList.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {t("form.savedEmpty")}
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {savedList.map((entry, i) => (
              <li
                key={i}
                className="flex items-center justify-between gap-3 rounded-btn border border-border bg-background px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                  {entry.name}
                  <span className="ml-2 text-muted-foreground">
                    {new Date(entry.ts).toLocaleDateString(locale === "hi" ? "hi-IN" : "en-IN")}
                  </span>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 min-h-11 px-3 text-xs"
                  onClick={() => {
                    loadSaved(String(i));
                  }}
                >
                  {t("form.open")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );

  /* ---------- render: properties panel ---------- */
  const propsPanel = (
    <div className="flex flex-col gap-3 rounded-card border border-border bg-card p-4">
      <h2 className="text-sm font-semibold text-foreground">{t("form.props")}</h2>
      {!sel ? (
        <p className="text-xs text-muted-foreground">{t("form.propsEmpty")}</p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="rounded-btn bg-muted px-2 py-1 text-[11px] font-medium text-muted-foreground">
            {t(kindLabelKey(sel))}
          </p>
          {isFieldEl(sel) ? (
            <>
              <div>
                <Label
                  htmlFor="pr-label"
                  className="text-xs text-muted-foreground"
                >
                  {t("form.label")}
                </Label>
                <Input
                  id="pr-label"
                  className="mt-1.5 h-11 min-h-11"
                  value={sel.label}
                  onChange={(e) => {
                    const label = e.target.value.slice(0, 200);
                    const patch: Partial<FieldEl> = { label };
                    if (!sel.nameMan && label.trim() !== "") {
                      const taken = takenNames(sel.id);
                      patch.name = uniqueName(slugify(label), taken);
                    }
                    updateEl(sel.id, patch);
                  }}
                />
              </div>
              <div>
                <Label htmlFor="pr-name" className="text-xs text-muted-foreground">
                  {t("form.name")}
                </Label>
                <Input
                  id="pr-name"
                  className="mt-1.5 h-11 min-h-11 font-mono text-xs"
                  value={sel.name}
                  onChange={(e) =>
                    updateEl(sel.id, {
                      name: e.target.value.slice(0, 60),
                      nameMan: true,
                    })
                  }
                  onBlur={(e) => {
                    const clean = uniqueName(
                      slugify(e.target.value),
                      takenNames(sel.id)
                    );
                    if (clean !== e.target.value) updateEl(sel.id, { name: clean });
                  }}
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t("form.nameHint")}
                </p>
              </div>
              <label
                htmlFor="pr-required"
                className="flex items-center gap-2 text-sm"
              >
                <input
                  id="pr-required"
                  type="checkbox"
                  checked={sel.required}
                  onChange={(e) =>
                    updateEl(sel.id, { required: e.target.checked })
                  }
                  className="size-5 accent-[rgb(30_120_90)]"
                />
                {t("form.required")}
              </label>
            </>
          ) : sel.kind === "heading" || sel.kind === "text" ? (
            <div>
              <Label htmlFor="pr-text" className="text-xs text-muted-foreground">
                {t("form.text")}
              </Label>
              <Textarea
                id="pr-text"
                rows={3}
                className="mt-1.5"
                value={sel.text}
                onChange={(e) =>
                  updateEl(sel.id, { text: e.target.value.slice(0, 4000) })
                }
              />
            </div>
          ) : null}

          {isFieldEl(sel) &&
          (sel.kind === "text" || sel.kind === "multiline") ? (
            <div>
              <Label
                htmlFor="pr-maxlen"
                className="text-xs text-muted-foreground"
              >
                {t("form.maxLength")}
              </Label>
              <Input
                id="pr-maxlen"
                type="number"
                min={0}
                max={500}
                className="mt-1.5 h-11 min-h-11"
                value={sel.maxLength || ""}
                onChange={(e) =>
                  updateEl(sel.id, {
                    maxLength: Math.max(
                      0,
                      Math.min(500, Math.round(Number(e.target.value) || 0))
                    ),
                  })
                }
              />
            </div>
          ) : null}

          {isFieldEl(sel) && sel.kind === "number" ? (
            <div>
              <Label
                htmlFor="pr-format"
                className="text-xs text-muted-foreground"
              >
                {t("form.format")}
              </Label>
              <select
                id="pr-format"
                className="mt-1.5 h-11 min-h-11 w-full rounded-btn border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                value={sel.format}
                onChange={(e) =>
                  updateEl(sel.id, {
                    format: e.target.value as FieldEl["format"],
                  })
                }
              >
                <option value="plain">{t("form.formatPlain")}</option>
                <option value="rupee">{t("form.formatRupee")}</option>
                <option value="percent">{t("form.formatPercent")}</option>
              </select>
            </div>
          ) : null}

          {isFieldEl(sel) && sel.kind === "checkbox" ? (
            <div>
              <Label htmlFor="pr-size" className="text-xs text-muted-foreground">
                {t("form.size")}
              </Label>
              <Input
                id="pr-size"
                type="number"
                min={8}
                max={64}
                className="mt-1.5 h-11 min-h-11"
                value={Math.min(sel.w, sel.h - labelHeight(sel))}
                onChange={(e) => {
                  const size = Math.max(
                    8,
                    Math.min(64, Math.round(Number(e.target.value) || 16))
                  );
                  updateEl(sel.id, {
                    w: size,
                    h: labelHeight(sel) + size,
                  });
                }}
              />
            </div>
          ) : null}

          {isFieldEl(sel) && (sel.kind === "radio" || sel.kind === "dropdown") ? (
            <div>
              <Label
                htmlFor="pr-options"
                className="text-xs text-muted-foreground"
              >
                {t("form.options")}
              </Label>
              <Textarea
                id="pr-options"
                rows={5}
                className="mt-1.5 text-xs"
                value={sel.options.join("\n")}
                onChange={(e) => {
                  const options = e.target.value
                    .split("\n")
                    .map((o) => o.slice(0, 80))
                    .slice(0, MAX_OPTIONS);
                  const nonEmpty = options.filter((o) => o.trim() !== "");
                  const patch: Partial<FieldEl> = { options };
                  if (sel.kind === "radio") {
                    patch.h = heightForOptions(sel, nonEmpty.length);
                  }
                  updateEl(sel.id, patch);
                }}
              />
            </div>
          ) : null}

          <div className="grid grid-cols-3 gap-2">
            <div>
              <Label htmlFor="pr-fs" className="text-xs text-muted-foreground">
                {t("form.fontSize")}
              </Label>
              <Input
                id="pr-fs"
                type="number"
                min={6}
                max={48}
                className="mt-1.5 h-11 min-h-11"
                value={sel.fs}
                onChange={(e) =>
                  updateEl(sel.id, {
                    fs: Math.max(6, Math.min(48, Math.round(Number(e.target.value) || 12))),
                  })
                }
              />
            </div>
            <div>
              <Label htmlFor="pr-w" className="text-xs text-muted-foreground">
                {t("form.width")}
              </Label>
              <Input
                id="pr-w"
                type="number"
                min={8}
                className="mt-1.5 h-11 min-h-11"
                value={Math.round(sel.w)}
                onChange={(e) => {
                  const w = Math.max(
                    8,
                    Math.min(Math.round(Number(e.target.value) || 8), PAGE_W_PX - sel.x)
                  );
                  const patch: Partial<FormElement> = { w };
                  if (isFieldEl(sel) && sel.kind === "checkbox") {
                    (patch as Partial<FieldEl>).h = labelHeight(sel) + w;
                  }
                  updateEl(sel.id, patch);
                }}
              />
            </div>
            <div>
              <Label htmlFor="pr-h" className="text-xs text-muted-foreground">
                {t("form.height")}
              </Label>
              <Input
                id="pr-h"
                type="number"
                min={8}
                className="mt-1.5 h-11 min-h-11"
                value={Math.round(sel.h)}
                onChange={(e) =>
                  updateEl(sel.id, {
                    h: Math.max(
                      8,
                      Math.min(
                        Math.round(Number(e.target.value) || 8),
                        PAGE_H_PX - sel.y
                      )
                    ),
                  })
                }
              />
            </div>
          </div>

          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className={`${TOOL_BTN} flex-1`}
              onClick={() => duplicateEl(sel.id)}
            >
              <Copy className="size-4" aria-hidden="true" />
              {t("form.duplicate")}
            </Button>
            <Button
              type="button"
              variant="outline"
              className={`${TOOL_BTN} flex-1 text-destructive hover:text-destructive`}
              onClick={() => deleteEl(sel.id)}
            >
              <Trash2 className="size-4" aria-hidden="true" />
              {t("form.delete")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );

  /* ---------- render: calc panel ---------- */
  const numberFields = fields.filter((f) => f.kind === "number");
  const calcPanel = (
    <div className="flex flex-col gap-3 rounded-card border border-border bg-card p-4">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        <Sigma className="size-4 text-primary" aria-hidden="true" />
        {t("form.calc")}
      </h2>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t("form.calcHint")}
      </p>
      {doc.rules.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("form.calcNone")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {doc.rules.map((rule, i) => {
            const errs = calc.errors.filter((e) => e.rule === i);
            const docErrs = calc.errors.filter((e) => e.rule === -1);
            return (
              <li
                key={rule.id}
                className="flex flex-col gap-2 rounded-btn border border-border bg-background p-2"
              >
                <div className="flex items-center gap-2">
                  <select
                    aria-label={t("form.calcTarget")}
                    className="h-11 min-h-11 min-w-0 flex-1 rounded-btn border border-input bg-background px-2 text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    value={rule.target}
                    onChange={(e) => setRule(rule.id, { target: e.target.value })}
                  >
                    <option value="">{t("form.calcPick")}</option>
                    {numberFields.map((f) => (
                      <option key={f.name} value={f.name}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    aria-label={t("form.calcRemove")}
                    onClick={() => removeRule(rule.id)}
                    className="flex size-11 min-h-11 items-center justify-center rounded-btn border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </button>
                </div>
                <Input
                  aria-label={t("form.calcExpr")}
                  className="h-11 min-h-11 font-mono text-xs"
                  placeholder="qty * price"
                  value={rule.expr}
                  onChange={(e) =>
                    setRule(rule.id, { expr: e.target.value.slice(0, 300) })
                  }
                />
                {errs.length > 0 || docErrs.length > 0 ? (
                  <ul className="flex flex-col gap-1 text-[11px] text-destructive">
                    {errs.map((err, k) => (
                      <li key={k}>
                        {t(err.key, {
                          name: err.name ?? "",
                          near: err.near ?? "",
                          detail: err.detail ?? "",
                        })}
                        {err.key === "form.calcErrUnknown" && err.near
                          ? " " + t("form.calcErrNear", { near: err.near })
                          : ""}
                      </li>
                    ))}
                    {docErrs.map((err, k) => (
                      <li key={`d${k}`}>
                        {t(err.key, { detail: err.detail ?? "" })}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <Button
        type="button"
        variant="outline"
        className={`${TOOL_BTN} w-full`}
        onClick={addRule}
        disabled={doc.rules.length >= MAX_RULES || numberFields.length === 0}
      >
        {t("form.calcAdd")}
      </Button>
      {calc.ok && doc.rules.length > 0 ? (
        <p className="text-[11px] font-medium text-primary">
          {t("form.calcReady", { n: doc.rules.length })}
        </p>
      ) : null}
    </div>
  );

  /* ---------- render: pages rail ---------- */
  const pagesPanel = (
    <div className="flex flex-col gap-2 rounded-card border border-border bg-card p-4">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        <Files className="size-4 text-primary" aria-hidden="true" />
        {t("form.pageOf", {
          n: pageIdx + 1,
          total: doc.pages.length,
        })}
      </h2>
      <div className="flex flex-wrap gap-2">
        {doc.pages.map((p, i) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={i === pageIdx}
            onClick={() => {
              setCurPage(i);
              setSelId(null);
            }}
            className={
              "h-11 min-h-11 min-w-11 rounded-btn border px-3 text-xs font-medium transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 " +
              (i === pageIdx
                ? "border-primary bg-accent/60 text-foreground"
                : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground")
            }
          >
            {i + 1}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" className={TOOL_BTN} onClick={addPage}>
          {t("form.addPage")}
        </Button>
        <Button
          type="button"
          variant="outline"
          className={TOOL_BTN}
          onClick={duplicatePage}
        >
          {t("form.dupPage")}
        </Button>
        <Button
          type="button"
          variant="outline"
          className={`${TOOL_BTN} ${delPageArm ? "border-destructive text-destructive" : ""}`}
          onClick={deletePage}
          disabled={doc.pages.length <= 1}
        >
          {delPageArm ? t("form.deleteConfirm") : t("form.delPage")}
        </Button>
      </div>
    </div>
  );

  /* ---------- render: toolbar ---------- */
  const toolbar = (
    <div className="flex flex-col gap-3 rounded-card border border-border bg-card p-4">
      <h2 className="text-sm font-semibold text-foreground">
        {t("form.toolbarLabel")}
      </h2>
      <div className="grid grid-cols-2 gap-2">
        {STATIC_TOOL.map(({ kind, key, Icon }) => (
          <button
            key={kind}
            type="button"
            onClick={() => addElement(kind)}
            className={SMALL_BTN}
          >
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{t(key)}</span>
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {FIELD_TOOL.map(({ kind, key, Icon }) => (
          <button
            key={kind}
            type="button"
            onClick={() => addElement(kind)}
            className={SMALL_BTN}
          >
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{t(key)}</span>
          </button>
        ))}
      </div>
    </div>
  );

  /* ---------- render: canvas ---------- */
  const canvas = (
    <div className="flex min-w-0 flex-col gap-2">
      <div ref={wrapRef} className="min-w-0 overflow-hidden">
        <div
          style={{
            position: "relative",
            width: PAGE_W_PX,
            height: PAGE_H_PX,
            transform: `scale(${scale})`,
            transformOrigin: "0 0",
            marginBottom: -(PAGE_H_PX * (1 - scale)),
          }}
          className="rounded-sm bg-white text-[rgb(17_17_17)] shadow-md"
          onPointerDown={() => setSelId(null)}
        >
          {page && page.elements.length === 0 ? (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              className="pointer-events-none px-16 text-center text-sm text-muted-foreground"
            >
              {t("form.canvasEmpty")}
            </div>
          ) : null}
          {page?.elements.map((el) => (
            <ElView
              key={el.id}
              el={applyDrag(el, drag)}
              selected={el.id === selId}
              scale={scale}
              testFill={testFill}
              testValue={testValues[(el as FieldEl).name] ?? ""}
              calcValue={
                isFieldEl(el) ? (calcValues[el.name] ?? "") : ""
              }
              onTest={onTest}
              onSelect={setSelId}
              onDragStart={onDragStart}
              onDragMove={onDragMove}
              onDragEnd={onDragEnd}
            />
          ))}
        </div>
      </div>
    </div>
  );

  /* ---------- render: edit view ---------- */
  const editView = (
    <div className="flex flex-col gap-4">
      {/* top bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-card p-3">
        <Button
          type="button"
          variant="outline"
          className={TOOL_BTN}
          onClick={() => {
            setView("home");
            viewRef.current = "home";
            syncOption(docRef.current, "home");
          }}
        >
          <MousePointer2 className="size-4" aria-hidden="true" />
          {t("form.backHome")}
        </Button>
        <div className="min-w-40 flex-1">
          <Input
            aria-label={t("form.title")}
            placeholder={t("form.title")}
            className="h-11 min-h-11"
            value={doc.title}
            onChange={(e) =>
              commit({ ...docRef.current, title: e.target.value.slice(0, 120) })
            }
          />
        </div>
        <Button
          type="button"
          variant={testFill ? "default" : "outline"}
          aria-pressed={testFill}
          className={TOOL_BTN}
          onClick={() => {
            setTestFill((v) => !v);
            setSelId(null);
          }}
        >
          <SquareCheck className="size-4" aria-hidden="true" />
          {t("form.testFill")}
        </Button>
        {testFill ? (
          <Button
            type="button"
            variant="ghost"
            className={TOOL_BTN}
            onClick={() => setTestValues({})}
          >
            {t("form.tfClear")}
          </Button>
        ) : null}
        <Button
          type="button"
          onClick={exportPdf}
          disabled={exportPct !== null}
          className={`${TOOL_BTN} font-semibold`}
        >
          {exportPct !== null ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <FileDown className="size-4" aria-hidden="true" />
          )}
          {t("form.export")}
        </Button>
        <Button
          type="button"
          variant="outline"
          className={TOOL_BTN}
          onClick={onNew}
        >
          <RotateCcw className="size-4" aria-hidden="true" />
          {t("form.new")}
        </Button>
        <div className="flex min-w-52 flex-1 items-center gap-2">
          <Input
            aria-label={t("form.saveName")}
            placeholder={t("form.saveName")}
            className="h-11 min-h-11"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value.slice(0, 80))}
          />
          <Button
            type="button"
            variant="outline"
            className={TOOL_BTN}
            onClick={saveCurrent}
          >
            <Save className="size-4" aria-hidden="true" />
            {t("form.save")}
          </Button>
        </div>
        <select
          aria-label={t("form.open")}
          className="h-11 min-h-11 min-w-40 max-w-56 rounded-btn border border-input bg-background px-2 text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          value={savedIdx}
          onChange={(e) => loadSaved(e.target.value)}
        >
          <option value="">{t("form.open")}</option>
          {savedList.map((x, i) => (
            <option key={i} value={String(i)}>
              {x.name}
            </option>
          ))}
        </select>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-11 min-h-11"
          onClick={deleteSaved}
          disabled={savedIdx === ""}
          aria-label={t("form.delSaved")}
          title={t("form.delSaved")}
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </Button>
      </div>

      {testFill ? (
        <p className="rounded-card border border-border bg-accent/40 px-4 py-2 text-xs text-muted-foreground">
          {t("form.testFillHint")}
        </p>
      ) : null}

      {warnings.length > 0 ? (
        <div
          role="status"
          className="rounded-card border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40"
        >
          <h2 className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-amber-900 dark:text-amber-200">
            <TriangleAlert className="size-4" aria-hidden="true" />
            {t("form.warnTitle")}
          </h2>
          <ul className="list-inside list-disc space-y-0.5 text-xs text-amber-900 dark:text-amber-200">
            {warnings.map((w, i) => (
              <li key={i}>{t(w)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* mobile tabs */}
      <div className="flex gap-1 overflow-x-auto lg:hidden" role="tablist">
        {(
          [
            ["none", t("form.pageOf", { n: pageIdx + 1, total: doc.pages.length })],
            ["elements", t("form.tabElements")],
            ["props", t("form.tabProps")],
            ["pages", t("form.tabPages")],
            ["calc", t("form.tabCalc")],
          ] as [MobileTab, string][]
        ).map(([tab, label]) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={mobileTab === tab}
            onClick={() => setMobileTab(tab)}
            className={
              "h-11 min-h-11 whitespace-nowrap rounded-btn border px-3 text-xs font-medium transition-colors " +
              (mobileTab === tab
                ? "border-primary bg-accent/60 text-foreground"
                : "border-border text-muted-foreground")
            }
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(210px,260px)_minmax(0,1fr)_minmax(260px,320px)]">
        {/* min-w-0 on every grid item — the pinned create-invoice lesson:
            grid items default to min-width:auto, so the unscaled 794px
            canvas layout box blew out the mobile viewport (overflowX 420). */}
        <div
          className={
            mobileTab === "elements"
              ? "flex min-w-0 flex-col gap-4"
              : "hidden min-w-0 flex-col gap-4 lg:flex"
          }
        >
          {toolbar}
          <div className={mobileTab === "pages" ? "min-w-0" : "hidden min-w-0 lg:block"}>
            {pagesPanel}
          </div>
          <div className={mobileTab === "calc" ? "min-w-0" : "hidden min-w-0 lg:block"}>
            {calcPanel}
          </div>
        </div>
        <div className={mobileTab === "none" ? "min-w-0" : "hidden min-w-0 lg:block"}>{canvas}</div>
        <div className={mobileTab === "props" ? "min-w-0" : "hidden min-w-0 lg:block"}>
          {propsPanel}
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      {view === "home" ? homeView : editView}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Drag preview transform                                               */
/* ------------------------------------------------------------------ */

function applyDrag(el: FormElement, drag: DragState | null): FormElement {
  if (!drag || drag.id !== el.id) return el;
  if (drag.mode === "move") {
    return {
      ...el,
      x: clampX(el.x + drag.dx),
      y: clampY(el.y + drag.dy),
    };
  }
  if (drag.mode === "e") {
    const w = Math.max(16, Math.min(snap(el.w + drag.dx), PAGE_W_PX - el.x));
    if (isFieldEl(el) && el.kind === "checkbox") {
      return { ...el, w, h: labelHeight(el) + w };
    }
    return { ...el, w };
  }
  const h = Math.max(16, Math.min(snap(el.h + drag.dy), PAGE_H_PX - el.y));
  if (isFieldEl(el) && el.kind === "checkbox") {
    return { ...el, h, w: h - labelHeight(el) };
  }
  return { ...el, h };
}
