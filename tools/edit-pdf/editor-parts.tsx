"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeftRight,
  ArrowUp,
  ArrowDown,
  Baseline,
  Bold,
  Brush,
  Copy,
  Eraser,
  Image as ImageIcon,
  Italic,
  Layers,
  Lock,
  LockOpen,
  Minus,
  MousePointer2,
  PenLine,
  Plus,
  Redo2,
  Square,
  Trash2,
  Type,
  Underline,
  Undo2,
} from "lucide-react";

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
import { Slider } from "@/components/ui/slider";
import { useI18n } from "@/components/providers/locale-provider";
import { cn } from "@/lib/utils";
import {
  FONT_OPTIONS,
  pdfRectToDisplay,
  type EditorObject,
  type ObjRect,
  type PageView,
  type ShapeObj,
  type TextObj,
} from "./model";

/**
 * Edit PDF — presentational editor chrome (PRD §8.2.1 toolbar, properties
 * and layers panels, signature pad). All state and pointer logic lives in
 * surface.tsx; these components receive plain props and fire callbacks.
 */

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

export type ToolId =
  | "select"
  | "text"
  | "image"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "draw"
  | "whiteout"
  | "sign";

const TOOL_BUTTONS: { id: ToolId; icon: typeof Type; key: string }[] = [
  { id: "select", icon: MousePointer2, key: "editPdf.toolSelect" },
  { id: "text", icon: Type, key: "editPdf.toolText" },
  { id: "image", icon: ImageIcon, key: "editPdf.toolImage" },
  { id: "rect", icon: Square, key: "editPdf.toolRect" },
  { id: "ellipse", icon: Minus, key: "editPdf.toolEllipse" },
  { id: "line", icon: Minus, key: "editPdf.toolLine" },
  { id: "arrow", icon: ArrowUp, key: "editPdf.toolArrow" },
  { id: "draw", icon: Brush, key: "editPdf.toolDraw" },
  { id: "whiteout", icon: Eraser, key: "editPdf.toolWhiteout" },
  { id: "sign", icon: PenLine, key: "editPdf.toolSign" },
];

export function EditorToolbar({
  tool,
  onTool,
  objectCount,
}: {
  tool: ToolId;
  onTool: (next: ToolId) => void;
  objectCount: number;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div
      role="toolbar"
      aria-label={t("editPdf.toolbarLabel")}
      className="flex items-center gap-1.5 overflow-x-auto rounded-card border border-border bg-card p-1.5 scrollbar-thin"
    >
      {TOOL_BUTTONS.map(({ id, icon: Icon, key }) => (
        <Button
          key={id}
          type="button"
          variant={tool === id ? "default" : "ghost"}
          size="sm"
          className="h-9 shrink-0 rounded-btn px-2.5"
          onClick={() => onTool(id)}
          aria-pressed={tool === id}
          title={t(key)}
        >
          <Icon className="size-4" aria-hidden="true" />
          <span className="hidden md:inline">{t(key)}</span>
        </Button>
      ))}
      <span className="ml-auto shrink-0 pl-2 pr-1 text-xs font-medium text-muted-foreground">
        {t("editPdf.objectCount", { count: objectCount })}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Canvas header: undo/redo + page indicator + zoom
// ---------------------------------------------------------------------------

export function CanvasHeader({
  page,
  pages,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  zoom,
  onZoom,
  markedCount,
}: {
  page: number;
  pages: number;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  zoom: number;
  onZoom: (next: number) => void;
  markedCount: number;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-9 rounded-btn"
        disabled={!canUndo}
        onClick={onUndo}
        aria-label={t("editPdf.undo")}
        title={t("editPdf.undo")}
      >
        <Undo2 className="size-4" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-9 rounded-btn"
        disabled={!canRedo}
        onClick={onRedo}
        aria-label={t("editPdf.redo")}
        title={t("editPdf.redo")}
      >
        <Redo2 className="size-4" aria-hidden="true" />
      </Button>
      <p className="ml-1 text-xs font-medium text-muted-foreground">
        {t("editPdf.pageOf", {
          page: page + 1,
          pages,
          objects: markedCount,
        })}
      </p>
      <div
        role="group"
        aria-label={t("editPdf.zoomLabel")}
        className="ml-auto flex items-center gap-0.5 rounded-btn border border-border bg-background p-0.5"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 rounded-md"
          disabled={zoom <= 0.75}
          onClick={() => onZoom(Math.max(0.75, Math.round((zoom - 0.25) * 100) / 100))}
          aria-label={t("editPdf.zoomOut")}
        >
          <Minus className="size-3.5" aria-hidden="true" />
        </Button>
        <span className="min-w-11 text-center text-xs font-semibold tabular-nums text-foreground">
          {Math.round(zoom * 100)}%
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 rounded-md"
          disabled={zoom >= 3}
          onClick={() => onZoom(Math.min(3, Math.round((zoom + 0.25) * 100) / 100))}
          aria-label={t("editPdf.zoomIn")}
        >
          <Plus className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small shared fields
// ---------------------------------------------------------------------------

function ColorField({
  label,
  value,
  onChange,
  allowNone,
}: {
  label: string;
  value: string | null;
  onChange: (next: string | null) => void;
  allowNone: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2">
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        {allowNone ? (
          <Switch
            checked={value !== null}
            onCheckedChange={(on) => onChange(on ? "#111827" : null)}
            aria-label={label}
            className="scale-90"
          />
        ) : null}
        <input
          type="color"
          value={value ?? "#ffffff"}
          onChange={(event) => onChange(event.target.value)}
          disabled={value === null}
          aria-label={label}
          className="size-9 cursor-pointer rounded-btn border border-border bg-background p-1 disabled:opacity-40"
        />
      </div>
    </div>
  );
}

function ActionRow({
  onRaise,
  onLower,
  onDuplicate,
  onDelete,
  locked,
  onToggleLock,
}: {
  onRaise: () => void;
  onLower: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  locked: boolean;
  onToggleLock: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-9 rounded-btn"
        onClick={onRaise}
        aria-label={t("editPdf.raise")}
        title={t("editPdf.raise")}
      >
        <ArrowUp className="size-4" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-9 rounded-btn"
        onClick={onLower}
        aria-label={t("editPdf.lower")}
        title={t("editPdf.lower")}
      >
        <ArrowDown className="size-4" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-9 rounded-btn"
        onClick={onToggleLock}
        aria-label={locked ? t("editPdf.unlock") : t("editPdf.lock")}
        title={locked ? t("editPdf.unlock") : t("editPdf.lock")}
      >
        {locked ? (
          <Lock className="size-4" aria-hidden="true" />
        ) : (
          <LockOpen className="size-4" aria-hidden="true" />
        )}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-9 rounded-btn"
        onClick={onDuplicate}
        aria-label={t("editPdf.duplicate")}
        title={t("editPdf.duplicate")}
      >
        <Copy className="size-4" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="ml-auto size-9 rounded-btn text-destructive hover:text-destructive"
        onClick={onDelete}
        aria-label={t("editPdf.delete")}
        title={t("editPdf.delete")}
      >
        <Trash2 className="size-4" aria-hidden="true" />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Properties panel
// ---------------------------------------------------------------------------

export function PropertiesPanel({
  object: obj,
  onPatch,
  onRaise,
  onLower,
  onDuplicate,
  onDelete,
  onToggleLock,
}: {
  object: EditorObject | null;
  onPatch: (patch: Partial<EditorObject>) => void;
  onRaise: () => void;
  onLower: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onToggleLock: () => void;
}): React.JSX.Element | null {
  const { t, locale } = useI18n();

  if (!obj) {
    return (
      <section className="rounded-card border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-foreground">
          {t("editPdf.propertiesTitle")}
        </h3>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {t("editPdf.propertiesHint")}
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-card border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">
        {t("editPdf.propertiesTitle")}
        <span className="ml-2 rounded-chip bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-primary">
          {t(`editPdf.kind_${obj.kind}`)}
        </span>
      </h3>

      <div className="mt-3 flex flex-col gap-3.5">
        {obj.kind === "text" ? (
          <TextFields obj={obj} onPatch={onPatch} />
        ) : null}
        {obj.kind === "rect" || obj.kind === "ellipse" || obj.kind === "line" || obj.kind === "arrow" ? (
          <ShapeFields obj={obj} onPatch={onPatch} />
        ) : null}
        {obj.kind === "draw" ? (
          <div className="flex flex-col gap-3">
            <ColorField
              label={t("editPdf.strokeColor")}
              value={obj.stroke}
              onChange={(next) => onPatch({ stroke: next ?? "#dc2626" })}
              allowNone={false}
            />
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs font-medium text-muted-foreground">
                {t("editPdf.strokeWidth")}
              </Label>
              <Input
                type="number"
                min={0.25}
                max={40}
                step={0.5}
                value={obj.strokeW}
                onChange={(e) =>
                  onPatch({ strokeW: Number(e.target.value) })
                }
                className="h-9 w-20 rounded-btn text-right"
                aria-label={t("editPdf.strokeWidth")}
              />
            </div>
          </div>
        ) : null}
        {obj.kind === "whiteout" ? (
          <ColorField
            label={t("editPdf.fill")}
            value={obj.fill}
            onChange={(next) => onPatch({ fill: next ?? "#ffffff" })}
            allowNone={false}
          />
        ) : null}
        {obj.kind === "image" ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("editPdf.imageHint")}
          </p>
        ) : null}

        <div className="flex flex-col gap-2">
          <Label className="text-xs font-medium text-muted-foreground">
            {t("editPdf.opacity")}
          </Label>
          <Slider
            value={[Math.round(obj.opacity * 100)]}
            min={10}
            max={100}
            step={5}
            onValueChange={([v]) => onPatch({ opacity: v / 100 })}
            aria-label={t("editPdf.opacity")}
          />
        </div>

        <ActionRow
          onRaise={onRaise}
          onLower={onLower}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
          locked={obj.locked}
          onToggleLock={onToggleLock}
        />
      </div>
      <p className="sr-only">{locale === "hi" ? "गुण" : "Properties"}</p>
    </section>
  );
}

function TextFields({
  obj,
  onPatch,
}: {
  obj: TextObj;
  onPatch: (patch: Partial<EditorObject>) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ed-font" className="text-xs font-medium text-muted-foreground">
          {t("editPdf.font")}
        </Label>
        <Select
          value={obj.font}
          onValueChange={(v) =>
            onPatch({ font: v as TextObj["font"] })
          }
        >
          <SelectTrigger id="ed-font" className="h-9 w-full rounded-btn">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FONT_OPTIONS.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                <span style={{ fontFamily: f.css }}>{t(`editPdf.font_${f.id}`)}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="ed-size" className="text-xs font-medium text-muted-foreground">
          {t("editPdf.size")}
        </Label>
        <Input
          id="ed-size"
          type="number"
          min={4}
          max={200}
          step={1}
          value={obj.size}
          onChange={(e) => onPatch({ size: Number(e.target.value) })}
          className="h-9 w-20 rounded-btn text-right"
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          variant={obj.bold ? "default" : "outline"}
          size="icon"
          className="size-9 rounded-btn"
          onClick={() => onPatch({ bold: !obj.bold })}
          aria-pressed={obj.bold}
          aria-label={t("editPdf.bold")}
        >
          <Bold className="size-4" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant={obj.italic ? "default" : "outline"}
          size="icon"
          className="size-9 rounded-btn font-serif italic"
          onClick={() => onPatch({ italic: !obj.italic })}
          aria-pressed={obj.italic}
          aria-label={t("editPdf.italic")}
        >
          <Italic className="size-4" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant={obj.underline ? "default" : "outline"}
          size="icon"
          className="size-9 rounded-btn underline"
          onClick={() => onPatch({ underline: !obj.underline })}
          aria-pressed={obj.underline}
          aria-label={t("editPdf.underline")}
        >
          <Underline className="size-4" aria-hidden="true" />
        </Button>
        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        {(["left", "center", "right"] as const).map((align) => (
          <Button
            key={align}
            type="button"
            variant={obj.align === align ? "default" : "outline"}
            size="icon"
            className="size-9 rounded-btn"
            onClick={() => onPatch({ align })}
            aria-pressed={obj.align === align}
            aria-label={t(`editPdf.align_${align}`)}
          >
            <Baseline
              className={cn(
                "size-4",
                align === "left" && "-scale-x-100",
                align === "center" && "rotate-90"
              )}
              aria-hidden="true"
            />
          </Button>
        ))}
      </div>
      <ColorField
        label={t("editPdf.textColor")}
        value={obj.color}
        onChange={(next) => onPatch({ color: next ?? "#111827" })}
        allowNone={false}
      />
      <ColorField
        label={t("editPdf.background")}
        value={obj.bg}
        onChange={(next) => onPatch({ bg: next })}
        allowNone
      />
    </>
  );
}

function ShapeFields({
  obj,
  onPatch,
}: {
  obj: ShapeObj;
  onPatch: (patch: Partial<EditorObject>) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const isLine = obj.kind === "line" || obj.kind === "arrow";
  return (
    <>
      {obj.kind !== "line" && obj.kind !== "arrow" ? (
        <ColorField
          label={t("editPdf.fill")}
          value={obj.fill}
          onChange={(next) => onPatch({ fill: next })}
          allowNone
        />
      ) : null}
      <ColorField
        label={t("editPdf.strokeColor")}
        value={obj.stroke}
        onChange={(next) => onPatch({ stroke: next })}
        allowNone
      />
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs font-medium text-muted-foreground">
          {t("editPdf.strokeWidth")}
        </Label>
        <Input
          type="number"
          min={0.25}
          max={40}
          step={0.5}
          value={obj.strokeW}
          onChange={(e) =>
            onPatch({ strokeW: Number(e.target.value) })
          }
          className="h-9 w-20 rounded-btn text-right"
          aria-label={t("editPdf.strokeWidth")}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="ed-dash" className="text-xs font-medium text-muted-foreground">
          {t("editPdf.dashed")}
        </Label>
        <Switch
          id="ed-dash"
          checked={obj.dash}
          onCheckedChange={(v) => onPatch({ dash: v })}
        />
      </div>
      {isLine ? (
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="ed-flip" className="text-xs font-medium text-muted-foreground">
            {t("editPdf.flip")}
          </Label>
          <Switch
            id="ed-flip"
            checked={obj.flip}
            onCheckedChange={(v) => onPatch({ flip: v })}
          />
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Layers panel
// ---------------------------------------------------------------------------

const KIND_ICONS: Record<string, typeof Type> = {
  text: Type,
  image: ImageIcon,
  rect: Square,
  ellipse: Minus,
  line: Minus,
  arrow: ArrowUp,
  draw: Brush,
  whiteout: Eraser,
};

export function LayersPanel({
  objects,
  selectedId,
  onSelect,
  onPatch,
  onRemove,
}: {
  objects: EditorObject[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPatch: (id: string, patch: Partial<EditorObject>) => void;
  onRemove: (id: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const ordered = [...objects].reverse();
  return (
    <section className="rounded-card border border-border bg-card p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Layers className="size-4 text-primary" aria-hidden="true" />
        {t("editPdf.layersTitle")}
        <span className="ml-auto text-[10px] font-medium text-muted-foreground">
          {t("editPdf.layersCount", { count: objects.length })}
        </span>
      </h3>
      {ordered.length === 0 ? (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {t("editPdf.layersHint")}
        </p>
      ) : (
        <ul className="mt-3 flex max-h-72 flex-col gap-1 overflow-y-auto scrollbar-thin">
          {ordered.map((obj) => {
            const Icon = KIND_ICONS[obj.kind] ?? Square;
            const label =
              obj.kind === "text"
                ? obj.text.split("\n")[0].slice(0, 28) || t("editPdf.kind_text")
                : obj.kind === "image"
                  ? t("editPdf.kind_image")
                  : t(`editPdf.kind_${obj.kind}`);
            return (
              <li key={obj.id}>
                <div
                  className={cn(
                    "group flex items-center gap-1.5 rounded-btn border px-2 py-1.5 transition-colors",
                    selectedId === obj.id
                      ? "border-primary/60 bg-primary/5"
                      : "border-transparent hover:bg-accent"
                  )}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-btn text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    onClick={() => onSelect(obj.id)}
                    aria-label={`${t(`editPdf.kind_${obj.kind}`)}: ${label}`}
                  >
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span
                      className={cn(
                        "truncate text-xs",
                        obj.hidden ? "text-muted-foreground line-through" : "text-foreground"
                      )}
                    >
                      {label}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="flex size-8 shrink-0 items-center justify-center rounded-btn text-muted-foreground hover:text-foreground"
                    onClick={() => onPatch(obj.id, { hidden: !obj.hidden })}
                    aria-label={obj.hidden ? t("editPdf.show") : t("editPdf.hide")}
                    title={obj.hidden ? t("editPdf.show") : t("editPdf.hide")}
                  >
                    <ArrowLeftRight
                      className={cn("size-3.5", !obj.hidden && "rotate-90")}
                      aria-hidden="true"
                    />
                  </button>
                  <button
                    type="button"
                    className="flex size-8 shrink-0 items-center justify-center rounded-btn text-muted-foreground hover:text-foreground"
                    onClick={() => onPatch(obj.id, { locked: !obj.locked })}
                    aria-label={obj.locked ? t("editPdf.unlock") : t("editPdf.lock")}
                    title={obj.locked ? t("editPdf.unlock") : t("editPdf.lock")}
                  >
                    {obj.locked ? (
                      <Lock className="size-3.5" aria-hidden="true" />
                    ) : (
                      <LockOpen className="size-3.5 opacity-50" aria-hidden="true" />
                    )}
                  </button>
                  <button
                    type="button"
                    className="flex size-8 shrink-0 items-center justify-center rounded-btn text-muted-foreground hover:text-destructive"
                    onClick={() => onRemove(obj.id)}
                    aria-label={t("editPdf.delete")}
                    title={t("editPdf.delete")}
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Signature pad
// ---------------------------------------------------------------------------

export function SignPadDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (png: Blob) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(520 * dpr);
    canvas.height = Math.round(180 * dpr);
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111827";
  }, []);

  const pointAt = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * 520,
      y: ((event.clientY - rect.top) / rect.height) * 180,
    };
  };

  const start = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    event.preventDefault();
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* synthetic pointers */
    }
    drawingRef.current = true;
    const p = pointAt(event);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  };

  const move = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!drawingRef.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const p = pointAt(event);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    if (!hasInk) setHasInk(true);
  };

  const end = (): void => {
    drawingRef.current = false;
  };

  const clear = useCallback((): void => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasInk(false);
  }, []);

  const finish = useCallback((): void => {
    const canvas = canvasRef.current;
    if (!canvas || !hasInk) return;
    // Trim to the ink bounding box (transparent PNG, tight placement).
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (data[(y * width + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX <= minX || maxY <= minY) return;
    const pad = 6;
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(width - 1, maxX + pad);
    maxY = Math.min(height - 1, maxY + pad);
    const out = document.createElement("canvas");
    out.width = maxX - minX + 1;
    out.height = maxY - minY + 1;
    out.getContext("2d")?.drawImage(
      canvas,
      minX,
      minY,
      out.width,
      out.height,
      0,
      0,
      out.width,
      out.height
    );
    out.toBlob((blob) => {
      if (blob) onDone(blob);
    }, "image/png");
  }, [hasInk, onDone]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t("editPdf.signPadTitle")}
    >
      <div className="w-full max-w-xl rounded-card border border-border bg-card p-4 shadow-xl">
        <h3 className="text-sm font-semibold text-foreground">
          {t("editPdf.signPadTitle")}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("editPdf.signPadHint")}
        </p>
        <div className="mt-3 overflow-hidden rounded-btn border border-dashed border-border bg-white">
          <canvas
            ref={canvasRef}
            className="block w-full touch-none"
            style={{ aspectRatio: "520 / 180" }}
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={end}
            onPointerLeave={end}
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={clear}>
            {t("editPdf.signClear")}
          </Button>
          <span className="ml-auto flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="button" size="sm" disabled={!hasInk} onClick={finish}>
              {t("editPdf.signDone")}
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

export interface ContextMenuState {
  x: number;
  y: number;
  objId: string;
}

export function EditorContextMenu({
  state,
  locked,
  onDuplicate,
  onBringFront,
  onSendBack,
  onToggleLock,
  onDelete,
  onClose,
}: {
  state: ContextMenuState;
  locked: boolean;
  onDuplicate: () => void;
  onBringFront: () => void;
  onSendBack: () => void;
  onToggleLock: () => void;
  onDelete: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const items: { label: string; action: () => void; danger?: boolean }[] = [
    { label: t("editPdf.bringFront"), action: onBringFront },
    { label: t("editPdf.sendBack"), action: onSendBack },
    {
      label: locked ? t("editPdf.unlock") : t("editPdf.lock"),
      action: onToggleLock,
    },
    { label: t("editPdf.duplicate"), action: onDuplicate },
    { label: t("editPdf.delete"), action: onDelete, danger: true },
  ];
  return (
    <div
      className="fixed z-50 min-w-44 overflow-hidden rounded-btn border border-border bg-card py-1 shadow-lg"
      style={{ left: state.x, top: state.y }}
      role="menu"
      aria-label={t("editPdf.menuLabel")}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={cn(
            "block w-full px-3 py-2 text-left text-xs outline-none transition-colors hover:bg-accent focus-visible:bg-accent",
            item.danger ? "text-destructive" : "text-foreground"
          )}
          onClick={() => {
            item.action();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Object rendering on the canvas (display-space, percentage positioned)
// ---------------------------------------------------------------------------

export function ObjView({
  obj,
  view,
  dispW,
  dispH,
  scale,
  selected,
  editing,
  imageUrl,
  onCreateDrag,
  onStartEdit,
  onContextMenu,
}: {
  obj: EditorObject;
  view: PageView;
  dispW: number;
  dispH: number;
  scale: number;
  selected: boolean;
  editing: boolean;
  imageUrl: string | null;
  onCreateDrag: (event: React.PointerEvent<HTMLDivElement>) => void;
  onStartEdit: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void;
}): React.JSX.Element {
  const disp = pdfRectToDisplay(obj, view);
  const boxStyle: React.CSSProperties = {
    left: `${(disp.x / dispW) * 100}%`,
    top: `${(disp.y / dispH) * 100}%`,
    width: `${(disp.w / dispW) * 100}%`,
    height: `${(disp.h / dispH) * 100}%`,
    opacity: obj.hidden ? 0.4 : obj.opacity,
  };
  const w = disp.w * scale;
  const h = disp.h * scale;

  let inner: React.JSX.Element;
  switch (obj.kind) {
    case "text":
      inner = editing ? (
        <span className="sr-only">{obj.text}</span>
      ) : (
        <span
          className="block size-full whitespace-pre-wrap break-words"
          style={{
            fontFamily: cssFor(obj.font),
            fontSize: `${obj.size * scale}px`,
            lineHeight: 1.32,
            color: obj.color,
            fontWeight: obj.bold ? 700 : 400,
            fontStyle: obj.italic ? "italic" : "normal",
            textDecoration: obj.underline ? "underline" : "none",
            textAlign: obj.align,
            padding: `${3 * scale}px`,
            background: obj.bg ?? "transparent",
            overflow: "hidden",
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onStartEdit();
          }}
        >
          {obj.text}
        </span>
      );
      break;
    case "image":
      inner = imageUrl ? (
        <img
          src={imageUrl}
          alt=""
          draggable={false}
          className="pointer-events-none size-full select-none object-fill"
        />
      ) : (
        <span className="block size-full rounded-sm bg-muted" />
      );
      break;
    case "rect":
    case "ellipse":
      inner = (
        <span
          className="block size-full"
          style={{
            borderRadius: obj.kind === "ellipse" ? "50%" : undefined,
            background: obj.fill ?? "transparent",
            border:
              obj.stroke !== null
                ? `${Math.max(1, obj.strokeW * scale)}px ${obj.dash ? "dashed" : "solid"} ${obj.stroke}`
                : undefined,
            boxSizing: "border-box",
          }}
        />
      );
      break;
    case "line":
    case "arrow": {
      const x1 = obj.flip ? 0 : w;
      const y1 = obj.flip ? h : 0;
      const x2 = obj.flip ? w : 0;
      const y2 = obj.flip ? 0 : h;
      inner = (
        <svg
          className="pointer-events-none absolute inset-0 overflow-visible"
          width={w}
          height={h}
        >
          <line
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={obj.stroke ?? "#dc2626"}
            strokeWidth={Math.max(1, obj.strokeW * scale)}
            strokeDasharray={obj.dash ? "6 4" : undefined}
            strokeLinecap="round"
          />
          {obj.kind === "arrow" ? (
            <polygon
              points={arrowHeadPoints(x1, y1, x2, y2, Math.max(6, 12 * scale))}
              fill={obj.stroke ?? "#dc2626"}
            />
          ) : null}
        </svg>
      );
      break;
    }
    case "draw":
      inner = (
        <svg
          className="pointer-events-none absolute inset-0 overflow-visible"
          width={w}
          height={h}
        >
          <polyline
            points={obj.pts
              .map(([fx, fy]) => `${fx * w},${fy * h}`)
              .join(" ")}
            fill="none"
            stroke={obj.stroke}
            strokeWidth={Math.max(1, obj.strokeW * scale)}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
      break;
    case "whiteout":
      inner = (
        <span
          className="block size-full"
          style={{ background: obj.fill }}
        />
      );
      break;
  }

  return (
    <div
      className={cn(
        "absolute",
        obj.locked ? "cursor-default" : "cursor-move",
        selected && "outline-2 outline-offset-0 outline-primary z-10"
      )}
      style={boxStyle}
      onPointerDown={onCreateDrag}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (obj.kind === "text") onStartEdit();
      }}
      onContextMenu={onContextMenu}
      data-obj-id={obj.id}
      aria-label={obj.kind === "text" ? obj.text.slice(0, 60) : obj.kind}
    >
      {inner}
      {selected ? (
        <>
          {(["nw", "ne", "sw", "se"] as const).map((edge) => (
            <span
              key={edge}
              data-handle={edge}
              className="absolute z-20 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-white"
              style={{
                left: edge === "ne" || edge === "se" ? "100%" : "0%",
                top: edge === "sw" || edge === "se" ? "100%" : "0%",
                cursor: edge === "nw" || edge === "se" ? "nwse-resize" : "nesw-resize",
                touchAction: "none",
              }}
            />
          ))}
        </>
      ) : null}
    </div>
  );
}

function cssFor(font: string): string {
  const found = FONT_OPTIONS.find((f) => f.id === font);
  return found?.css ?? "Arial, Helvetica, sans-serif";
}

function arrowHeadPoints(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  size: number
): string {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const a1 = angle + Math.PI - 0.45;
  const a2 = angle + Math.PI + 0.45;
  return [
    `${x2},${y2}`,
    `${x2 + size * Math.cos(a1)},${y2 + size * Math.sin(a1)}`,
    `${x2 + size * Math.cos(a2)},${y2 + size * Math.sin(a2)}`,
  ].join(" ");
}
