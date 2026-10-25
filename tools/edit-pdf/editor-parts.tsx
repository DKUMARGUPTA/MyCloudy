"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowLeftRight,
  ArrowUp,
  ArrowDown,
  ArrowDownToLine,
  ArrowUpToLine,
  Baseline,
  Bold,
  Brush,
  Check,
  Copy,
  Ellipsis,
  Eraser,
  FormInput,
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
  Replace,
  RotateCw,
  Square,
  TextCursorInput,
  Trash2,
  Type,
  Underline,
  Undo2,
  X,
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
import { BottomSheet } from "@/components/doco/bottom-sheet";
import { useI18n } from "@/components/providers/locale-provider";
import { cn } from "@/lib/utils";
import {
  FONT_OPTIONS,
  clampN,
  isRotatable,
  normalizeRotation,
  pdfRectToDisplay,
  pieceRect,
  type EditorObject,
  type FieldObj,
  type HarvestPiece,
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
  | "edittext"
  | "image"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "draw"
  | "whiteout"
  | "sign"
  | "field";

const TOOL_BUTTONS: { id: ToolId; icon: typeof Type; key: string }[] = [
  { id: "select", icon: MousePointer2, key: "editPdf.toolSelect" },
  { id: "text", icon: Type, key: "editPdf.toolText" },
  { id: "edittext", icon: TextCursorInput, key: "editPdf.toolEditText" },
  { id: "image", icon: ImageIcon, key: "editPdf.toolImage" },
  { id: "rect", icon: Square, key: "editPdf.toolRect" },
  { id: "ellipse", icon: Minus, key: "editPdf.toolEllipse" },
  { id: "line", icon: Minus, key: "editPdf.toolLine" },
  { id: "arrow", icon: ArrowUp, key: "editPdf.toolArrow" },
  { id: "draw", icon: Brush, key: "editPdf.toolDraw" },
  { id: "whiteout", icon: Eraser, key: "editPdf.toolWhiteout" },
  { id: "sign", icon: PenLine, key: "editPdf.toolSign" },
  { id: "field", icon: FormInput, key: "editPdf.toolField" },
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
// Mobile chrome (P8.6, PRD §8.2 — simplified bottom toolbar + More sheet)
// ---------------------------------------------------------------------------

/**
 * R6-a: Edit text is FIRST-CLASS on mobile (Smallpdf parity — Smallpdf puts
 * Edit Text right after Select). The compact short label keeps the 6 flex-1
 * buttons ≥44px wide on a 360px screen (6×44 + 6×4 gaps + 12 padding = 308).
 */
const MOBILE_TOOLS: { id: ToolId; icon: typeof Type; key: string }[] = [
  { id: "select", icon: MousePointer2, key: "editPdf.toolSelect" },
  { id: "edittext", icon: TextCursorInput, key: "editPdf.toolEditTextShort" },
  { id: "text", icon: Type, key: "editPdf.toolText" },
  { id: "draw", icon: Brush, key: "editPdf.toolDraw" },
  { id: "sign", icon: PenLine, key: "editPdf.toolSign" },
  { id: "image", icon: ImageIcon, key: "editPdf.toolImage" },
];

/** Sticky bottom toolbar for touch/small screens — 44px+ targets. */
export function MobileToolbar({
  tool,
  onTool,
  onMore,
}: {
  tool: ToolId;
  onTool: (next: ToolId) => void;
  onMore: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div
      role="toolbar"
      aria-label={t("editPdf.toolbarLabel")}
      className="sticky bottom-0 z-30 -mx-1 flex items-stretch gap-1 rounded-card border border-border bg-card/95 p-1.5 shadow-lg backdrop-blur"
    >
      {MOBILE_TOOLS.map(({ id, icon: Icon, key }) => (
        <button
          key={id}
          type="button"
          aria-pressed={tool === id}
          aria-label={t(key)}
          title={t(key)}
          onClick={() => onTool(id)}
          className={cn(
            "flex h-14 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-btn text-[10px] font-medium leading-none outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
            tool === id
              ? "bg-primary text-primary-foreground"
              : "text-foreground hover:bg-accent"
          )}
        >
          <Icon className="size-5" aria-hidden="true" />
          <span aria-hidden="true">{t(key)}</span>
        </button>
      ))}
      <button
        type="button"
        aria-label={t("editPdf.moreTools")}
        aria-haspopup="dialog"
        title={t("editPdf.moreTools")}
        onClick={onMore}
        className="flex h-14 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-btn text-[10px] font-medium leading-none text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <Ellipsis className="size-5" aria-hidden="true" />
        <span aria-hidden="true">{t("editPdf.moreTools")}</span>
      </button>
    </div>
  );
}

/** R6-a: edittext graduated to MOBILE_TOOLS — the sheet keeps the rest. */
const MORE_TOOLS: { id: ToolId; icon: typeof Type; key: string }[] = [
  { id: "rect", icon: Square, key: "editPdf.toolRect" },
  { id: "ellipse", icon: Minus, key: "editPdf.toolEllipse" },
  { id: "line", icon: Minus, key: "editPdf.toolLine" },
  { id: "arrow", icon: ArrowUp, key: "editPdf.toolArrow" },
  { id: "whiteout", icon: Eraser, key: "editPdf.toolWhiteout" },
  { id: "field", icon: FormInput, key: "editPdf.toolField" },
];

/** "More" bottom sheet — the rest of the tools + undo/redo/duplicate/
 * delete + zoom (PRD §8.2 mobile list). */
export function MoreSheet({
  open,
  onOpenChange,
  tool,
  onTool,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  canDuplicate,
  onDuplicate,
  canDelete,
  onDelete,
  zoom,
  onZoom,
  onFindReplace,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tool: ToolId;
  onTool: (next: ToolId) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  canDuplicate: boolean;
  onDuplicate: () => void;
  canDelete: boolean;
  onDelete: () => void;
  zoom: number;
  onZoom: (next: number) => void;
  onFindReplace: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const pick = (id: ToolId): void => {
    onTool(id);
    onOpenChange(false);
  };
  const row =
    "flex h-11 w-full items-center gap-3 rounded-btn px-3 text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent";
  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("editPdf.moreTools")}
    >
      <div className="flex max-h-[65vh] flex-col gap-1 overflow-y-auto pb-1 scrollbar-thin">
        {MORE_TOOLS.map(({ id, icon: Icon, key }) => (
          <button
            key={id}
            type="button"
            className={cn(
              row,
              tool === id && "bg-primary/10 font-medium text-primary"
            )}
            aria-pressed={tool === id}
            onClick={() => pick(id)}
          >
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            {t(key)}
          </button>
        ))}
        <button type="button" className={row} onClick={() => {
          onFindReplace();
          onOpenChange(false);
        }}>
          <Replace className="size-4 shrink-0" aria-hidden="true" />
          {t("editPdf.frTitle")}
        </button>

        <div
          role="group"
          aria-label={t("editPdf.undo")}
          className="mt-2 flex gap-1.5 border-t border-border pt-3"
        >
          <Button
            type="button"
            variant="outline"
            className="h-11 flex-1 rounded-btn"
            disabled={!canUndo}
            onClick={onUndo}
            aria-label={t("editPdf.undo")}
          >
            <Undo2 className="size-4" aria-hidden="true" />
            {t("editPdf.undo")}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-11 flex-1 rounded-btn"
            disabled={!canRedo}
            onClick={onRedo}
            aria-label={t("editPdf.redo")}
          >
            <Redo2 className="size-4" aria-hidden="true" />
            {t("editPdf.redo")}
          </Button>
        </div>

        <div className="flex gap-1.5">
          <Button
            type="button"
            variant="outline"
            className="h-11 flex-1 rounded-btn"
            disabled={!canDuplicate}
            onClick={onDuplicate}
            aria-label={t("editPdf.duplicate")}
          >
            <Copy className="size-4" aria-hidden="true" />
            {t("editPdf.duplicate")}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-11 flex-1 rounded-btn text-destructive hover:text-destructive"
            disabled={!canDelete}
            onClick={onDelete}
            aria-label={t("editPdf.delete")}
          >
            <Trash2 className="size-4" aria-hidden="true" />
            {t("editPdf.delete")}
          </Button>
        </div>

        <div
          role="group"
          aria-label={t("editPdf.zoomLabel")}
          className="mt-2 flex items-center gap-0.5 rounded-btn border border-border bg-background p-0.5"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 rounded-md"
            disabled={zoom <= 0.75}
            onClick={() => onZoom(Math.max(0.75, Math.round((zoom - 0.25) * 100) / 100))}
            aria-label={t("editPdf.zoomOut")}
          >
            <Minus className="size-4" aria-hidden="true" />
          </Button>
          <span className="min-w-11 text-center text-xs font-semibold tabular-nums text-foreground">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 rounded-md"
            disabled={zoom >= 3}
            onClick={() => onZoom(Math.min(3, Math.round((zoom + 0.25) * 100) / 100))}
            aria-label={t("editPdf.zoomIn")}
          >
            <Plus className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}

// ---------------------------------------------------------------------------
// Snap guides (P8.6) — 1px accent lines across the page
// ---------------------------------------------------------------------------

export function SnapGuides({
  guides,
  dispW,
  dispH,
}: {
  guides: { axis: "x" | "y"; pos: number }[];
  dispW: number;
  dispH: number;
}): React.JSX.Element | null {
  if (guides.length === 0 || dispW <= 0 || dispH <= 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-30" aria-hidden="true">
      {guides.map((g, i) =>
        g.axis === "x" ? (
          <span
            key={`x${i}`}
            className="absolute inset-y-0 w-px bg-primary"
            style={{ left: `${(g.pos / dispW) * 100}%` }}
          />
        ) : (
          <span
            key={`y${i}`}
            className="absolute inset-x-0 h-px bg-primary"
            style={{ top: `${(g.pos / dispH) * 100}%` }}
          />
        )
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Multi-selection summary (P8.6)
// ---------------------------------------------------------------------------

export function MultiSelectPanel({
  count,
  locked,
  onBringFront,
  onSendBack,
  onDuplicate,
  onDelete,
  onToggleLock,
}: {
  count: number;
  locked: boolean;
  onBringFront: () => void;
  onSendBack: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onToggleLock: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const btn =
    "flex h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-btn border border-border bg-background px-1 text-[10px] font-medium leading-none outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40";
  return (
    <section className="rounded-card border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">
        {t("editPdf.multiTitle", { n: count })}
      </h3>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {t("editPdf.multiHint")}
      </p>
      <div className="mt-3 grid grid-cols-3 gap-1.5">
        <button type="button" className={btn} onClick={onBringFront}>
          <ArrowUpToLine className="size-4" aria-hidden="true" />
          {t("editPdf.bringFront")}
        </button>
        <button type="button" className={btn} onClick={onSendBack}>
          <ArrowDownToLine className="size-4" aria-hidden="true" />
          {t("editPdf.sendBack")}
        </button>
        <button type="button" className={btn} onClick={onToggleLock}>
          {locked ? (
            <Lock className="size-4" aria-hidden="true" />
          ) : (
            <LockOpen className="size-4" aria-hidden="true" />
          )}
          {locked ? t("editPdf.unlock") : t("editPdf.lock")}
        </button>
        <button type="button" className={btn} onClick={onDuplicate}>
          <Copy className="size-4" aria-hidden="true" />
          {t("editPdf.duplicate")}
        </button>
        <button
          type="button"
          className={cn(btn, "col-span-2 text-destructive hover:bg-destructive/10")}
          onClick={onDelete}
        >
          <Trash2 className="size-4" aria-hidden="true" />
          {t("editPdf.delete")}
        </button>
      </div>
    </section>
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
  onFindReplace,
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
  onFindReplace: () => void;
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
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-9 shrink-0 rounded-btn px-2.5"
        onClick={onFindReplace}
        aria-label={t("editPdf.frTitle")}
        title={t("editPdf.frTitle")}
      >
        <Replace className="size-4" aria-hidden="true" />
        <span className="hidden md:inline">{t("editPdf.frTitle")}</span>
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
        {obj.kind === "field" ? (
          <FieldFields obj={obj} onPatch={onPatch} />
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

        {isRotatable(obj) ? (
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="ed-rot" className="text-xs font-medium text-muted-foreground">
              {t("editPdf.rotation")}
            </Label>
            <Input
              id="ed-rot"
              type="number"
              min={-180}
              max={180}
              step={1}
              value={Math.round(obj.rotation)}
              onChange={(e) => {
                const parsed = Number(e.target.value);
                if (Number.isFinite(parsed)) {
                  onPatch({ rotation: normalizeRotation(parsed) });
                }
              }}
              className="h-9 w-20 rounded-btn text-right"
              aria-label={t("editPdf.rotation")}
            />
          </div>
        ) : null}

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
  field: FormInput,
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
                  : obj.kind === "field"
                    ? obj.name.trim().slice(0, 28) || t("editPdf.kind_field")
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
// Existing-text pieces overlay (P8.3 — click-to-edit)
// ---------------------------------------------------------------------------

/**
 * Hover-able buttons over every harvested text piece. The wrapper is
 * pointer-events-none so gestures pass through to the overlay beneath;
 * only the buttons catch clicks. Vertical hit bands are padded to a
 * comfortable minimum (a raw 12pt line is ~16px on screen — too thin), so
 * the band is CENTRED on the piece to stay honest about which line you
 * hit. Keyboard users tab through pieces in reading order.
 */
export function TextPieceButtons({
  pieces,
  dispW,
  dispH,
  onPick,
}: {
  pieces: HarvestPiece[];
  dispW: number;
  dispH: number;
  onPick: (piece: HarvestPiece) => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
  if (pieces.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-30" role="presentation">
      {pieces.map((p) => {
        const rect = pieceRect(p);
        const centerY = rect.y + rect.h / 2;
        // Comfortable minimum band (display pt) centred on the piece.
        const bandH = Math.max(rect.h, 22);
        const top = Math.max(0, centerY - bandH / 2);
        const label = `${t("editPdf.pieceLabel")}: ${p.str.slice(0, 60)}`;
        return (
          <button
            key={p.index}
            type="button"
            className="pointer-events-auto absolute rounded-sm bg-transparent outline-none transition-colors hover:bg-primary/10 hover:outline-2 hover:outline-primary focus-visible:bg-primary/10 focus-visible:outline-2 focus-visible:outline-primary"
            style={{
              left: `${(rect.x / dispW) * 100}%`,
              top: `${(top / dispH) * 100}%`,
              width: `${(rect.w / dispW) * 100}%`,
              height: `${(bandH / dispH) * 100}%`,
              outlineOffset: "-1px",
            }}
            onClick={() => onPick(p)}
            aria-label={label}
            title={label}
          />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Floating text-edit mini-toolbar (R6-a — Smallpdf parity)
// ---------------------------------------------------------------------------

/** One-tap alignment cycle: left → center → right → left. */
const ALIGN_CYCLE: Record<TextObj["align"], TextObj["align"]> = {
  left: "center",
  center: "right",
  right: "left",
};

/** Preset ink swatches in the floating colour popover (model default first). */
const BAR_SWATCHES = [
  "#111827",
  "#ffffff",
  "#dc2626",
  "#ea580c",
  "#16a34a",
  "#0284c7",
  "#7c3aed",
  "#db2777",
] as const;

/**
 * Smallpdf-style floating toolbar anchored JUST ABOVE the text object being
 * inline-edited (below it when the object hugs the page top — measured, not
 * guessed). Rendered inside the canvas overlay: the wrapper is
 * pointer-events-none so canvas gestures keep working around it, and the bar
 * stops pointer propagation so the overlay's marquee/deselect handler never
 * sees a tap on it. Every control patches through the SAME onPatch/onDelete
 * path the sidebar TextFields/ActionRow use — one state, no forks.
 *
 * R6-a geometry guarantees (both measured, never guessed):
 *  - the bar is a single row (controls scroll horizontally on narrow pages
 *    instead of wrapping) so its height never doubles;
 *  - the flip-below anchor uses the inline textarea's LIVE rendered height
 *    (wrapping grows it past the object rect) so the bar can never cover
 *    the text being typed;
 *  - when neither side fits (object spans nearly the whole page) the bar
 *    pins to the page top edge rather than poking out of the overlay.
 */
export function TextEditBar({
  rect,
  dispW,
  dispH,
  scale,
  obj,
  onPatch,
  onDelete,
  editBoxRef,
}: {
  /** Display rect of the text object (pt, y down). */
  rect: ObjRect;
  dispW: number;
  dispH: number;
  /** CSS px per display pt (renderScale) — converts the bar height to pt. */
  scale: number;
  obj: TextObj;
  onPatch: (patch: Partial<EditorObject>) => void;
  onDelete: () => void;
  /** Live ref to the inline textarea — its real rendered height (wrapping
   * grows it past the object rect) feeds the flip-below anchor. */
  editBoxRef?: React.RefObject<HTMLTextAreaElement | null>;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const [swatchesOpen, setSwatchesOpen] = useState(false);
  const barBoxRef = useRef<HTMLDivElement | null>(null);
  const [barPx, setBarPx] = useState(52);
  const [liveH, setLiveH] = useState(0);

  useLayoutEffect(() => {
    const el = barBoxRef.current;
    if (!el) return;
    const measure = (): void =>
      setBarPx(el.getBoundingClientRect().height || 52);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The textarea is the thing being typed into — observe its real box.
  // Two failure modes make a plain observe-once effect stale (R6-c): the
  // ref object's identity never changes (the editing textarea may mount
  // after this bar), and React may REPLACE the textarea DOM node while
  // the bar stays mounted (the old node never resizes again, so the
  // observer goes silent and liveH freezes at a stale height — the
  // flip-below anchor then overlaps the text being typed). Sync the
  // observed element every frame while the bar is mounted: one ref
  // compare + one rect read per frame, only during an active edit.
  useLayoutEffect(() => {
    let observer: ResizeObserver | null = null;
    let observed: Element | null = null;
    let raf = 0;
    let cancelled = false;
    const tick = (): void => {
      if (cancelled) return;
      const el = editBoxRef?.current ?? null;
      if (el !== observed) {
        observer?.disconnect();
        observer = null;
        observed = el;
        if (el) {
          const measure = (): void =>
            setLiveH(el.getBoundingClientRect().height || 0);
          measure();
          observer = new ResizeObserver(measure);
          observer.observe(el);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return (): void => {
      cancelled = true;
      cancelAnimationFrame(raf);
      observer?.disconnect();
    };
  }, [editBoxRef]);

  if (dispW <= 0 || dispH <= 0) return null;

  // Anchor above the bbox with a 6px gap; flip below ONLY when the bar
  // would poke out of the page top AND below genuinely fits under the live
  // text box (bar + box heights measured in CSS px → pt via scale).
  const gapPx = 6;
  const safeScale = Math.max(scale, 0.01);
  const barPt = (barPx + gapPx) / safeScale;
  const liveBottomPt = rect.y + Math.max(rect.h, liveH / safeScale);
  const fitsAbove = rect.y - barPt >= 0;
  const fitsBelow = liveBottomPt + barPt <= dispH;
  const above = fitsAbove || !fitsBelow;
  const anchorPct = above
    ? (Math.max(rect.y, fitsAbove ? 0 : barPt) / dispH) * 100
    : (liveBottomPt / dispH) * 100;

  const clampSize = (n: number): number => clampN(Math.round(n), 4, 200);

  const iconBtn =
    "flex size-10 shrink-0 items-center justify-center rounded-btn outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:size-11";

  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-40"
      style={{
        top: `${anchorPct}%`,
        transform: above
          ? `translateY(calc(-100% - ${gapPx}px))`
          : `translateY(${gapPx}px)`,
      }}
    >
      <div className="flex justify-center px-1">
        <div
          ref={barBoxRef}
          role="toolbar"
          aria-label={t("editPdf.editBarLabel")}
          data-text-edit-bar=""
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          // Bar buttons must not steal the caret: a blur here would close
          // the inline edit (see the textarea's relatedTarget guard in
          // surface.tsx). The size number input stays focusable.
          onMouseDown={(event) => {
            if ((event.target as HTMLElement).closest("button")) {
              event.preventDefault();
            }
          }}
          className="pointer-events-auto flex max-w-full flex-nowrap items-center justify-center-safe gap-1 overflow-x-auto rounded-card border border-border bg-card/95 p-1 shadow-lg backdrop-blur [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {/* Font family — the same 4 FONT_OPTIONS as the sidebar select. */}
          <Select
            value={obj.font}
            onValueChange={(v) => onPatch({ font: v as TextObj["font"] })}
          >
            <SelectTrigger
              aria-label={t("editPdf.font")}
              className="h-10 w-28 shrink rounded-btn text-xs pointer-coarse:h-11"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FONT_OPTIONS.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  <span style={{ fontFamily: f.css }}>
                    {t(`editPdf.font_${f.id}`)}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Size stepper — the same 4..200 caps as the sidebar input. */}
          <span
            role="group"
            aria-label={t("editPdf.size")}
            className="flex items-center rounded-btn border border-border bg-background"
          >
            <button
              type="button"
              className={cn(iconBtn, "text-muted-foreground")}
              onClick={() => onPatch({ size: clampSize(obj.size - 1) })}
              aria-label={t("editPdf.sizeDecrease")}
            >
              <Minus className="size-4" aria-hidden="true" />
            </button>
            <input
              type="number"
              min={4}
              max={200}
              value={Math.round(obj.size)}
              onChange={(event) => {
                const n = Number(event.target.value);
                if (Number.isFinite(n)) onPatch({ size: clampSize(n) });
              }}
              aria-label={t("editPdf.size")}
              className="h-10 w-10 shrink-0 bg-transparent text-center text-xs font-semibold tabular-nums text-foreground outline-none pointer-coarse:h-11 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
            <button
              type="button"
              className={cn(iconBtn, "text-muted-foreground")}
              onClick={() => onPatch({ size: clampSize(obj.size + 1) })}
              aria-label={t("editPdf.sizeIncrease")}
            >
              <Plus className="size-4" aria-hidden="true" />
            </button>
          </span>

          {/* Colour: swatch button → preset popover + custom picker. */}
          <span className="relative shrink-0">
            <button
              type="button"
              className={iconBtn}
              aria-label={t("editPdf.textColor")}
              aria-expanded={swatchesOpen}
              onClick={() => setSwatchesOpen((open) => !open)}
            >
              <span
                className="size-5 rounded-full border border-border shadow-inner"
                style={{ background: obj.color }}
              />
            </button>
            {swatchesOpen ? (
              <span className="absolute left-1/2 top-full z-50 mt-1 flex -translate-x-1/2 items-center gap-1 rounded-btn border border-border bg-card p-1.5 shadow-lg">
                {BAR_SWATCHES.map((hex) => (
                  <button
                    key={hex}
                    type="button"
                    className="size-7 shrink-0 rounded-full border border-border outline-none transition-transform hover:scale-110 focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:size-8"
                    style={{ background: hex }}
                    aria-label={`${t("editPdf.textColor")} ${hex}`}
                    onClick={() => {
                      onPatch({ color: hex });
                      setSwatchesOpen(false);
                    }}
                  />
                ))}
                <input
                  type="color"
                  value={obj.color}
                  onChange={(event) => onPatch({ color: event.target.value })}
                  aria-label={t("editPdf.textColor")}
                  className="size-7 shrink-0 cursor-pointer rounded-full border border-border bg-background p-0.5"
                />
              </span>
            ) : null}
          </span>

          <span className="mx-0.5 h-6 w-px bg-border" aria-hidden="true" />

          {/* Bold toggle (Smallpdf parity; italic/underline live in the
              sidebar Properties panel). */}
          <button
            type="button"
            className={cn(
              iconBtn,
              obj.bold
                ? "bg-primary text-primary-foreground hover:bg-primary"
                : "text-foreground"
            )}
            aria-pressed={obj.bold}
            aria-label={t("editPdf.bold")}
            onClick={() => onPatch({ bold: !obj.bold })}
          >
            <Bold className="size-4" aria-hidden="true" />
          </button>

          {/* Alignment cycle button (left → center → right). */}
          <button
            type="button"
            className={cn(iconBtn, "text-foreground")}
            aria-label={t(`editPdf.align_${obj.align}`)}
            title={t(`editPdf.align_${obj.align}`)}
            onClick={() => onPatch({ align: ALIGN_CYCLE[obj.align] })}
          >
            <Baseline
              className={cn(
                "size-4",
                obj.align === "left" && "-scale-x-100",
                obj.align === "center" && "rotate-90"
              )}
              aria-hidden="true"
            />
          </button>

          {/* Delete — same undoable semantics as the sidebar ActionRow. */}
          <button
            type="button"
            className={cn(iconBtn, "text-destructive hover:bg-destructive/10")}
            aria-label={t("editPdf.delete")}
            onClick={onDelete}
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Find & replace dialog (P8.3 — same font rules as click-to-edit)
// ---------------------------------------------------------------------------

export interface FrMatchView {
  key: string;
  page: number;
  /** Excerpt split around the occurrence: [before, hit, after]. */
  before: string;
  hit: string;
  after: string;
  done: boolean;
}

export function FindReplaceDialog({
  query,
  onQuery,
  replacement,
  onReplacement,
  matchCase,
  onMatchCase,
  scanning,
  scanPage,
  scanPages,
  matches,
  hasQuery,
  onReplaceOne,
  onReplaceAll,
  onJump,
  onClose,
}: {
  query: string;
  onQuery: (next: string) => void;
  replacement: string;
  onReplacement: (next: string) => void;
  matchCase: boolean;
  onMatchCase: (next: boolean) => void;
  scanning: boolean;
  scanPage: number;
  scanPages: number;
  matches: FrMatchView[];
  hasQuery: boolean;
  onReplaceOne: () => void;
  onReplaceAll: () => void;
  onJump: (index: number) => void;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const queryRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    queryRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t("editPdf.frTitle")}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-card border border-border bg-card p-4 shadow-xl">
        <div className="flex items-center gap-2">
          <Replace className="size-4 text-primary" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-foreground">
            {t("editPdf.frTitle")}
          </h3>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="ml-auto size-8 rounded-btn"
            onClick={onClose}
            aria-label={t("editPdf.frClose")}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="mt-3 flex flex-col gap-2.5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ed-fr-find" className="text-xs font-medium text-muted-foreground">
              {t("editPdf.frFind")}
            </Label>
            <Input
              id="ed-fr-find"
              ref={queryRef}
              value={query}
              onChange={(event) => onQuery(event.target.value)}
              placeholder={t("editPdf.frFindPlaceholder")}
              className="h-9 rounded-btn"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ed-fr-repl" className="text-xs font-medium text-muted-foreground">
              {t("editPdf.frReplace")}
            </Label>
            <Input
              id="ed-fr-repl"
              value={replacement}
              onChange={(event) => onReplacement(event.target.value)}
              placeholder={t("editPdf.frReplacePlaceholder")}
              className="h-9 rounded-btn"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="ed-fr-case" className="text-xs font-medium text-muted-foreground">
              {t("editPdf.frMatchCase")}
            </Label>
            <Switch
              id="ed-fr-case"
              checked={matchCase}
              onCheckedChange={onMatchCase}
            />
          </div>
        </div>

        <div className="mt-3 min-h-24 flex-1 overflow-hidden rounded-btn border border-border bg-background">
          {scanning ? (
            <div className="flex h-24 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
              <span className="animate-pulse">{t("editPdf.frScan")}</span>
              <span className="tabular-nums">
                {scanPage} / {scanPages}
              </span>
            </div>
          ) : !hasQuery ? (
            <p className="p-3 text-xs text-muted-foreground">
              {t("editPdf.frHint")}
            </p>
          ) : matches.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">
              {t("editPdf.frNoMatches")}
            </p>
          ) : (
            <ul className="flex max-h-96 flex-col gap-1 overflow-y-auto p-1.5 scrollbar-thin">
              {matches.map((m, i) => (
                <li key={m.key}>
                  <button
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-2 rounded-btn border px-2 py-1.5 text-left text-xs outline-none transition-colors hover:bg-accent focus-visible:bg-accent",
                      m.done
                        ? "border-transparent text-muted-foreground"
                        : "border-transparent text-foreground"
                    )}
                    onClick={() => onJump(i)}
                    aria-label={`${t("editPdf.frPage", { page: m.page + 1 })}: ${m.hit}`}
                  >
                    <span className="shrink-0 rounded-chip bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary tabular-nums">
                      {t("editPdf.frPage", { page: m.page + 1 })}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      <span className="text-muted-foreground">{m.before}</span>
                      <mark className="rounded-sm bg-amber-200/80 px-0.5 text-foreground dark:bg-amber-500/40">
                        {m.hit}
                      </mark>
                      <span className="text-muted-foreground">{m.after}</span>
                    </span>
                    {m.done ? (
                      <Check
                        className="size-3.5 shrink-0 text-emerald-600"
                        aria-hidden="true"
                      />
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {hasQuery && !scanning && matches.length > 0 ? (
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            {t("editPdf.frMatchesCount", { n: matches.length })}
            {" · "}
            {t("editPdf.frNote")}
          </p>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 rounded-btn"
            disabled={scanning || matches.length === 0}
            onClick={onReplaceOne}
          >
            {t("editPdf.frReplaceOne")}
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-9 rounded-btn"
            disabled={scanning || matches.length === 0}
            onClick={onReplaceAll}
          >
            {t("editPdf.frReplaceAll")}
          </Button>
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
  rotationHandle,
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
  /** Show the rotation handle (single selection + rotatable kind). */
  rotationHandle: boolean;
  onCreateDrag: (event: React.PointerEvent<HTMLDivElement>) => void;
  onStartEdit: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void;
}): React.JSX.Element {
  const { t } = useI18n();
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
    case "field": {
      // Widget chrome preview — dashed primary border + a name tag; the
      // export gives every flavour its real AcroForm appearance.
      const isRound = obj.fieldType === "radio";
      const isCheckbox = obj.fieldType === "checkbox";
      inner = (
        <span
          className={cn(
            "block size-full border-2 border-dashed",
            isRound || isCheckbox ? "rounded-[3px]" : "rounded-[4px]",
            obj.required
              ? "border-primary/80 bg-primary/5"
              : "border-primary/50 bg-primary/5"
          )}
        >
          {isCheckbox ? (
            <svg
              className="pointer-events-none absolute inset-0 size-full"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                d="M5 12.5 10 17.5 19 6.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-primary/60"
              />
            </svg>
          ) : isRound ? (
            <span className="pointer-events-none absolute inset-[18%] rounded-full border-2 border-primary/60" />
          ) : obj.fieldType === "dropdown" ? (
            <span className="pointer-events-none absolute inset-y-0 right-0 flex w-5 items-center justify-center text-primary/70">
              <ArrowDown className="size-3.5" aria-hidden="true" />
            </span>
          ) : obj.fieldType === "multiline" ? (
            <span className="pointer-events-none absolute inset-x-1 inset-y-[30%] space-y-[0.45em]">
              <span className="block h-px bg-primary/25" />
              <span className="block h-px bg-primary/25" />
            </span>
          ) : null}
          {obj.name.trim().length > 0 && obj.w * scale > 44 ? (
            <span
              className={cn(
                "pointer-events-none absolute -top-[1.4em] left-0 max-w-full truncate rounded-chip bg-primary px-1 py-px text-[9px] font-semibold leading-tight text-primary-foreground",
                isCheckbox || isRound ? "left-[85%]" : ""
              )}
            >
              {obj.name}
            </span>
          ) : null}
        </span>
      );
      break;
    }
  }

  return (
    <div
      className={cn(
        "absolute",
        obj.locked ? "cursor-default" : "cursor-move",
        selected && "z-10"
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
      {/* P8.6: the content rotates around its center (CSS degrees are
          clockwise on screen; model rotation is visual-CCW → negate). The
          outer box stays axis-aligned so handles and hit areas don't spin. */}
      <div
        className={cn(
          "absolute inset-0",
          selected && "outline-2 outline-offset-0 outline-primary"
        )}
        style={
          obj.rotation
            ? {
                transform: `rotate(${-obj.rotation}deg)`,
                transformOrigin: "center center",
              }
            : undefined
        }
      >
        {inner}
      </div>
      {selected ? (
        <>
          {rotationHandle ? (
            <span
              data-handle="rot"
              aria-label={t("editPdf.rotation")}
              title={t("editPdf.rotation")}
              className="pointer-coarse:size-11 absolute left-1/2 top-0 z-20 flex size-6 -translate-x-1/2 -translate-y-[130%] cursor-grab items-center justify-center rounded-full border border-border bg-card shadow-sm touch-none"
            >
              <RotateCw
                className="pointer-coarse:size-5 size-3.5 text-primary"
                aria-hidden="true"
              />
            </span>
          ) : null}
          {(["nw", "ne", "sw", "se"] as const).map((edge) => (
            <span
              key={edge}
              data-handle={edge}
              className="pointer-coarse:size-11 absolute z-20 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full touch-none"
              style={{
                left: edge === "ne" || edge === "se" ? "100%" : "0%",
                top: edge === "sw" || edge === "se" ? "100%" : "0%",
                cursor: edge === "nw" || edge === "se" ? "nwse-resize" : "nesw-resize",
              }}
            >
              <span className="pointer-coarse:size-5 size-3 rounded-full border-2 border-primary bg-white" />
            </span>
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

function FieldFields({
  obj,
  onPatch,
}: {
  obj: FieldObj;
  onPatch: (patch: Partial<EditorObject>) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const isCheckbox = obj.fieldType === "checkbox";
  const isRadio = obj.fieldType === "radio";
  const isDropdown = obj.fieldType === "dropdown";
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ed-fname" className="text-xs font-medium text-muted-foreground">
          {t("editPdf.fieldName")}
        </Label>
        <Input
          id="ed-fname"
          type="text"
          value={obj.name}
          maxLength={60}
          onChange={(e) => onPatch({ name: e.target.value })}
          className="h-9 w-full rounded-btn"
        />
        {isRadio ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("editPdf.radioGroupHint")}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ed-ftype" className="text-xs font-medium text-muted-foreground">
          {t("editPdf.fieldTypeLabel")}
        </Label>
        <Select
          value={obj.fieldType}
          onValueChange={(v) => {
            const nextType = v as FieldObj["fieldType"];
            if (nextType === "checkbox" || nextType === "radio") {
              const size = Math.min(obj.w, obj.h);
              onPatch({ fieldType: nextType, w: size, h: size });
            } else {
              onPatch({ fieldType: nextType });
            }
          }}
        >
          <SelectTrigger id="ed-ftype" className="h-9 w-full rounded-btn">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["text", "multiline", "checkbox", "dropdown", "radio"] as const).map(
              (id) => (
                <SelectItem key={id} value={id}>
                  {t(`editPdf.fieldType_${id}`)}
                </SelectItem>
              )
            )}
          </SelectContent>
        </Select>
      </div>

      {isCheckbox ? (
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="ed-fchecked" className="text-xs font-medium text-muted-foreground">
            {t("editPdf.fieldChecked")}
          </Label>
          <Switch
            id="ed-fchecked"
            checked={obj.value === "on"}
            onCheckedChange={(next) => onPatch({ value: next ? "on" : "" })}
          />
        </div>
      ) : null}

      {isRadio ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ed-fopt" className="text-xs font-medium text-muted-foreground">
            {t("editPdf.fieldOptionValue")}
          </Label>
          <Input
            id="ed-fopt"
            type="text"
            value={obj.value}
            maxLength={40}
            placeholder={t("editPdf.fieldOptionPlaceholder")}
            onChange={(e) => onPatch({ value: e.target.value })}
            className="h-9 w-full rounded-btn"
          />
        </div>
      ) : null}

      {obj.fieldType === "text" || obj.fieldType === "multiline" ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ed-fval" className="text-xs font-medium text-muted-foreground">
            {t("editPdf.fieldValue")}
          </Label>
          <Input
            id="ed-fval"
            type="text"
            value={obj.value}
            maxLength={200}
            placeholder={t("editPdf.fieldValuePlaceholder")}
            onChange={(e) => onPatch({ value: e.target.value })}
            className="h-9 w-full rounded-btn"
          />
        </div>
      ) : null}

      {isDropdown ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ed-fopts" className="text-xs font-medium text-muted-foreground">
            {t("editPdf.fieldOptions")}
          </Label>
          <textarea
            id="ed-fopts"
            value={obj.options.join("\n")}
            rows={4}
            onChange={(e) =>
              onPatch({
                options: e.target.value.split("\n").map((s) => s.slice(0, 80)),
              })
            }
            placeholder={t("editPdf.fieldOptionsPlaceholder")}
            className="w-full resize-y rounded-btn border border-input bg-background px-3 py-2 text-xs text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          {obj.options.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ed-fsel" className="text-xs font-medium text-muted-foreground">
                {t("editPdf.fieldSelected")}
              </Label>
              <Select
                value={obj.value || "__none__"}
                onValueChange={(v) => onPatch({ value: v === "__none__" ? "" : v })}
              >
                <SelectTrigger id="ed-fsel" className="h-9 w-full rounded-btn">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">
                    {t("editPdf.fieldNoDefault")}
                  </SelectItem>
                  {obj.options.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="ed-freq" className="text-xs font-medium text-muted-foreground">
          {t("editPdf.fieldRequired")}
        </Label>
        <Switch
          id="ed-freq"
          checked={obj.required}
          onCheckedChange={(next) => onPatch({ required: next })}
        />
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t("editPdf.fieldHint")}
      </p>
    </>
  );
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
