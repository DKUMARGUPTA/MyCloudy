"use client";

import { useEffect, useRef } from "react";
import {
  Highlighter,
  MessageSquare,
  Minus,
  MousePointer2,
  Pencil,
  Plus,
  Redo2,
  Strikethrough,
  Trash2,
  Underline as UnderlineIcon,
  Undo2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { useI18n } from "@/components/providers/locale-provider";
import { cn } from "@/lib/utils";
import {
  COLOR_PRESETS,
  type Annotation,
  type NoteAnno,
} from "./model";

/**
 * Annotate PDF — presentational chrome (PRD §8.2). All state and pointer
 * logic lives in surface.tsx; these components receive plain props and
 * fire callbacks (the edit-pdf editor-parts pattern).
 */

export type AnnoToolId =
  | "select"
  | "highlight"
  | "underline"
  | "strikeout"
  | "note";

const TOOL_BUTTONS: { id: AnnoToolId; icon: typeof MousePointer2; key: string }[] =
  [
    { id: "select", icon: MousePointer2, key: "ann.toolSelect" },
    { id: "highlight", icon: Highlighter, key: "ann.toolHighlight" },
    { id: "underline", icon: UnderlineIcon, key: "ann.toolUnderline" },
    { id: "strikeout", icon: Strikethrough, key: "ann.toolStrike" },
    { id: "note", icon: MessageSquare, key: "ann.toolNote" },
  ];

// ---------------------------------------------------------------------------
// Toolbar: tools + colour presets + opacity
// ---------------------------------------------------------------------------

export function AnnoToolbar({
  tool,
  onTool,
  annoCount,
  color,
  onColor,
  opacity,
  onOpacity,
}: {
  tool: AnnoToolId;
  onTool: (next: AnnoToolId) => void;
  annoCount: number;
  color: string;
  onColor: (next: string) => void;
  opacity: number;
  onOpacity: (next: number) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div
      role="toolbar"
      aria-label={t("ann.toolbarLabel")}
      className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-card p-1.5"
    >
      <div className="flex items-center gap-1.5">
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
      </div>

      <div
        role="group"
        aria-label={t("ann.colorLabel")}
        className="flex items-center gap-1.5 border-l border-border pl-2"
      >
        {COLOR_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => onColor(preset.hex)}
            aria-label={t(`ann.swatch_${preset.id}`)}
            aria-pressed={color === preset.hex}
            className={cn(
              "size-7 rounded-full border-2 outline-none transition-transform hover:scale-110 focus-visible:ring-[3px] focus-visible:ring-ring/50",
              color === preset.hex
                ? "border-foreground"
                : "border-transparent"
            )}
            style={{ backgroundColor: preset.hex }}
          />
        ))}
        <label
          className="relative inline-flex size-7 cursor-pointer items-center justify-center rounded-full border border-dashed border-muted-foreground/60 text-[10px] font-semibold text-muted-foreground transition-transform hover:scale-110"
          title={t("ann.customColor")}
        >
          +
          <span className="sr-only">{t("ann.customColor")}</span>
          <input
            type="color"
            value={color}
            onChange={(event) => onColor(event.target.value)}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
            aria-label={t("ann.customColor")}
          />
        </label>
      </div>

      <div className="flex min-w-40 flex-1 items-center gap-2.5 sm:max-w-56">
        <Label
          htmlFor="ann-opacity"
          className="shrink-0 text-xs font-medium text-muted-foreground"
        >
          {t("ann.opacityLabel")}
        </Label>
        <Slider
          id="ann-opacity"
          value={[Math.round(opacity * 100)]}
          min={20}
          max={80}
          step={5}
          onValueChange={(vals) =>
            onOpacity(Math.min(0.8, Math.max(0.2, (vals[0] ?? 45) / 100)))
          }
          aria-label={t("ann.opacityLabel")}
          className="flex-1"
        />
        <span className="w-9 shrink-0 text-right text-xs font-semibold tabular-nums text-foreground">
          {Math.round(opacity * 100)}%
        </span>
      </div>

      <span className="ml-auto shrink-0 pr-1 text-xs font-medium text-muted-foreground">
        {t("ann.annoCount", { count: annoCount })}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Canvas header: undo/redo + page indicator + zoom (edit-pdf pattern)
// ---------------------------------------------------------------------------

export function AnnoHeader({
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
        aria-label={t("ann.undo")}
        title={t("ann.undo")}
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
        aria-label={t("ann.redo")}
        title={t("ann.redo")}
      >
        <Redo2 className="size-4" aria-hidden="true" />
      </Button>
      <p className="ml-1 text-xs font-medium text-muted-foreground">
        {t("ann.pageOf", { page: page + 1, pages, count: markedCount })}
      </p>
      <div
        role="group"
        aria-label={t("ann.zoomLabel")}
        className="ml-auto flex items-center gap-0.5 rounded-btn border border-border bg-background p-0.5"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 rounded-md"
          disabled={zoom <= 0.75}
          onClick={() =>
            onZoom(Math.max(0.75, Math.round((zoom - 0.25) * 100) / 100))
          }
          aria-label={t("ann.zoomOut")}
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
          onClick={() =>
            onZoom(Math.min(3, Math.round((zoom + 0.25) * 100) / 100))
          }
          aria-label={t("ann.zoomIn")}
        >
          <Plus className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Comments rail (PRD §8.2: "comment list in sidebar")
// ---------------------------------------------------------------------------

function KindIcon({ anno }: { anno: Annotation }): React.JSX.Element {
  if (anno.kind === "note") {
    return <MessageSquare className="mt-0.5 size-4 shrink-0" aria-hidden="true" />;
  }
  if (anno.kind === "underline") {
    return <UnderlineIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />;
  }
  if (anno.kind === "strikeout") {
    return <Strikethrough className="mt-0.5 size-4 shrink-0" aria-hidden="true" />;
  }
  return <Highlighter className="mt-0.5 size-4 shrink-0" aria-hidden="true" />;
}

function kindLabelKey(anno: Annotation): string {
  if (anno.kind === "note") return "ann.kindNote";
  if (anno.kind === "underline") return "ann.kindUnderline";
  if (anno.kind === "strikeout") return "ann.kindStrike";
  return "ann.kindHighlight";
}

export function CommentsRail({
  annos,
  selectedId,
  onSelect,
  onEditNote,
  onDelete,
}: {
  annos: Annotation[];
  selectedId: string | null;
  onSelect: (id: string, page: number) => void;
  onEditNote: (id: string) => void;
  onDelete: (id: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  if (annos.length === 0) {
    return (
      <section
        aria-label={t("ann.commentsTitle")}
        className="rounded-card border border-border bg-card p-4"
      >
        <h3 className="text-sm font-semibold text-foreground">
          {t("ann.commentsTitle")}
        </h3>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {t("ann.commentsHint")}
        </p>
      </section>
    );
  }

  // Group by page, ascending; newest last within a page.
  const byPage = new Map<number, Annotation[]>();
  for (const anno of annos) {
    const list = byPage.get(anno.page);
    if (list) list.push(anno);
    else byPage.set(anno.page, [anno]);
  }
  const pageKeys = [...byPage.keys()].sort((a, b) => a - b);

  return (
    <section
      aria-label={t("ann.commentsTitle")}
      className="flex flex-col rounded-card border border-border bg-card"
    >
      <div className="border-b border-border p-4 pb-3">
        <h3 className="text-sm font-semibold text-foreground">
          {t("ann.commentsTitle")}
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("ann.annoCount", { count: annos.length })}
        </p>
      </div>
      <div className="max-h-96 overflow-y-auto scrollbar-thin">
        {pageKeys.map((page) => (
          <div key={page} className="border-b border-border last:border-b-0">
            <p className="bg-muted/50 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t("ann.pageLabel", { n: page + 1 })}
            </p>
            <ul>
              {(byPage.get(page) as Annotation[]).map((anno) => {
                const selected = anno.id === selectedId;
                const body = anno.text;
                return (
                  <li key={anno.id}>
                    <div
                      className={cn(
                        "flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/50",
                        selected && "bg-primary/10"
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className="mt-1 size-2.5 shrink-0 rounded-full ring-1 ring-inset ring-black/10"
                        style={{ backgroundColor: anno.color }}
                      />
                      <button
                        type="button"
                        className="min-w-0 flex-1 py-0.5 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:rounded-sm"
                        onClick={() => onSelect(anno.id, anno.page)}
                        aria-current={selected ? "true" : undefined}
                      >
                        <span className="sr-only">
                          {t(kindLabelKey(anno))},{" "}
                          {t("ann.pageLabel", { n: anno.page + 1 })}:{" "}
                        </span>
                        <span className="block text-xs leading-relaxed text-foreground">
                          {body.length > 0
                            ? body
                            : t("ann.fallbackRow")}
                        </span>
                      </button>
                      <span className="mt-0.5 flex shrink-0 items-center gap-1">
                        {anno.kind === "note" ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-8 rounded-md"
                            onClick={() => onEditNote(anno.id)}
                            aria-label={t("ann.editNote")}
                            title={t("ann.editNote")}
                          >
                            <Pencil className="size-3.5" aria-hidden="true" />
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-8 rounded-md text-destructive hover:text-destructive"
                          onClick={() => onDelete(anno.id)}
                          aria-label={t("ann.deleteAnno")}
                          title={t("ann.deleteAnno")}
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        </Button>
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sticky-note bubble (on-page popup editor)
// ---------------------------------------------------------------------------

export function NoteBubble({
  note,
  value,
  onChange,
  onClose,
  leftPct,
  topPct,
}: {
  note: NoteAnno;
  value: string;
  onChange: (next: string) => void;
  onClose: () => void;
  /** Bubble anchor position (percent of the overlay). */
  leftPct: number;
  topPct: number;
}): React.JSX.Element {
  const { t } = useI18n();
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [note.id]);
  return (
    <div
      className="absolute z-30 w-60 -translate-x-1/2"
      style={{
        left: `${Math.min(88, Math.max(12, leftPct))}%`,
        top: `${Math.min(78, topPct)}%`,
      }}
      role="group"
      aria-label={t("ann.noteBubbleLabel")}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div
        className="flex items-center gap-1.5 rounded-t-card border border-b-0 border-border bg-muted/70 px-2.5 py-1"
        style={{ borderBottomColor: note.color }}
      >
        <MessageSquare className="size-3.5" aria-hidden="true" />
        <span className="text-[11px] font-semibold text-muted-foreground">
          {t("ann.toolNote")}
        </span>
      </div>
      <textarea
        ref={ref}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onClose}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            (event.target as HTMLTextAreaElement).blur();
          }
          event.stopPropagation();
        }}
        placeholder={t("ann.notePlaceholder")}
        aria-label={t("ann.noteBubbleLabel")}
        rows={4}
        className="w-full resize-none rounded-b-card border border-border bg-background p-2.5 text-xs leading-relaxed text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        style={{ borderTopColor: note.color }}
      />
    </div>
  );
}
