"use client";

/**
 * Write PDF — presentational editor chrome (the edit-pdf
 * editor-parts.tsx pattern): template picker, toolbar, page-setup panel,
 * per-block views (uncontrolled contentEditable text blocks, table grid,
 * image blocks, dividers, page breaks), the add-block menu and the
 * paginated live preview. All state + handlers live in surface.tsx; these
 * components stay dumb and typed.
 */

import {
  useEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  Bold,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  Eye,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Italic,
  List,
  ListOrdered,
  Loader2,
  Minus,
  PencilLine,
  Pilcrow,
  Plus,
  Redo2,
  Settings2,
  Table as TableIcon,
  TextQuote,
  Trash2,
  Underline,
  Undo2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "@/components/providers/locale-provider";
import type { L10n } from "@/lib/tools/registry";
import type { WAlign, WFamily } from "./model";
import type { TemplateId } from "./templates";

/* ------------------------------------------------------------------ */
/* Run ↔ DOM html conversion (the editor's source of truth is the      */
/* contentEditable DOM while typing; the model is parsed on input)     */
/* ------------------------------------------------------------------ */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Model runs → contentEditable innerHTML (b/i/u + coloured spans). */
export function runsToHtml(runs: {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
}[]): string {
  let html = "";
  for (const run of runs) {
    if (run.text.length === 0) continue;
    let piece = escapeHtml(run.text);
    if (run.color) piece = `<span style="color:${run.color}">${piece}</span>`;
    if (run.underline) piece = `<u>${piece}</u>`;
    if (run.italic) piece = `<i>${piece}</i>`;
    if (run.bold) piece = `<b>${piece}</b>`;
    html += piece;
  }
  return html;
}

function rgbToHex(color: string): string | undefined {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (match) {
    let hex = match[1];
    if (hex.length === 3) {
      hex = hex
        .split("")
        .map((ch) => ch + ch)
        .join("");
    }
    return `#${hex.toLowerCase()}`;
  }
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(color.trim());
  if (rgb) {
    const r = Number(rgb[1]);
    const g = Number(rgb[2]);
    const b = Number(rgb[3]);
    if (r <= 255 && g <= 255 && b <= 255) {
      return `#${[r, g, b]
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("")}`;
    }
  }
  return undefined;
}

interface ParseStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color?: string;
}

/** contentEditable DOM → model runs (adjacent same-style text merges). */
export function parseEditableRuns(el: HTMLElement): {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
}[] {
  const runs: {
    text: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    color?: string;
  }[] = [];
  const push = (text: string, style: ParseStyle): void => {
    const last = runs[runs.length - 1];
    if (
      last &&
      (last.bold ?? false) === style.bold &&
      (last.italic ?? false) === style.italic &&
      (last.underline ?? false) === style.underline &&
      (last.color ?? "") === (style.color ?? "")
    ) {
      last.text += text;
      return;
    }
    runs.push({
      text,
      ...(style.bold ? { bold: true } : {}),
      ...(style.italic ? { italic: true } : {}),
      ...(style.underline ? { underline: true } : {}),
      ...(style.color !== undefined ? { color: style.color } : {}),
    });
  };

  const walk = (node: Node, style: ParseStyle): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? "").replace(/\s*\n\s*/g, " ");
      if (text.length > 0) push(text, style);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as HTMLElement;
    const tag = element.tagName;
    if (tag === "BR") {
      const last = runs[runs.length - 1];
      if (last && !last.text.endsWith(" ")) last.text += " ";
      else if (!last) push(" ", style);
      return;
    }
    const next: ParseStyle = { ...style };
    if (tag === "B" || tag === "STRONG") next.bold = true;
    if (tag === "I" || tag === "EM") next.italic = true;
    if (tag === "U") next.underline = true;
    if (tag === "SPAN" || tag === "FONT") {
      // styleWithCSS formatting: font-weight/font-style/text-decoration
      const inline = element.style;
      if (inline) {
        const weight = String(inline.fontWeight ?? "");
        if (weight === "bold" || (Number(weight) >= 600 && weight !== "")) {
          next.bold = true;
        }
        if (inline.fontStyle === "italic") next.italic = true;
        if (String(inline.textDecoration ?? "").includes("underline")) {
          next.underline = true;
        }
      }
      const attr = element.getAttribute("color");
      const hex =
        (inline?.color ? rgbToHex(inline.color) : undefined) ??
        (attr ? rgbToHex(attr) : undefined);
      if (hex && hex !== "#000000") next.color = hex;
      else if (hex === "#000000") next.color = undefined;
    }
    for (const child of node.childNodes) walk(child, next);
  };

  const base: ParseStyle = { bold: false, italic: false, underline: false };
  for (const child of el.childNodes) walk(child, base);
  return runs.filter((run) => run.text.length > 0);
}

/* ------------------------------------------------------------------ */
/* Tiny shared bits                                                    */
/* ------------------------------------------------------------------ */

export function IconBtn({
  label,
  onClick,
  active,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active === true}
      disabled={disabled === true}
      onClick={onClick}
      className={
        "inline-flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40 md:size-8 " +
        (active === true ? "bg-accent text-foreground" : "")
      }
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Template picker (landing state of the tool)                         */
/* ------------------------------------------------------------------ */

const TEMPLATE_META: Record<
  TemplateId,
  { name: L10n; desc: L10n; icon: ReactNode }
> = {
  blank: {
    name: { en: "Blank document", hi: "ख़ाली दस्तावेज़" },
    desc: {
      en: "Start from an empty A4 page and just write.",
      hi: "ख़ाली A4 पेज से शुरू करें और सीधे लिखें।",
    },
    icon: <Pilcrow className="size-5" aria-hidden="true" />,
  },
  letter: {
    name: { en: "Letter", hi: "पत्र" },
    desc: {
      en: "Formal letter with date, recipient and subject.",
      hi: "औपचारिक पत्र — दिनांक, प्राप्तकर्ता और विषय के साथ।",
    },
    icon: <PencilLine className="size-5" aria-hidden="true" />,
  },
  application: {
    name: { en: "Application (Hindi)", hi: "आवेदन (हिंदी)" },
    desc: {
      en: "Classic Indian application — सेवा में, विषय, धन्यवाद.",
      hi: "क्लासिक भारतीय आवेदन — सेवा में, विषय, धन्यवाद।",
    },
    icon: <TextQuote className="size-5" aria-hidden="true" />,
  },
  offer: {
    name: { en: "Offer letter", hi: "ऑफ़र लेटर" },
    desc: {
      en: "Job offer with terms, conditions and salary line.",
      hi: "नौकरी का ऑफ़र — शर्तें, नियम और वेतन पंक्ति के साथ।",
    },
    icon: <List className="size-5" aria-hidden="true" />,
  },
  report: {
    name: { en: "Report", hi: "रिपोर्ट" },
    desc: {
      en: "Sections, a table, a page break — quarterly report bones.",
      hi: "सेक्शन, टेबल, पेज ब्रेक — त्रैमासिक रिपोर्ट का ढाँचा।",
    },
    icon: <TableIcon className="size-5" aria-hidden="true" />,
  },
};

export function TemplatePicker({
  onPick,
}: {
  onPick: (id: TemplateId) => void;
}) {
  const { locale } = useI18n();
  return (
    <div
      role="group"
      aria-label="Templates"
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
    >
      {(Object.keys(TEMPLATE_META) as TemplateId[]).map((id) => {
        const meta = TEMPLATE_META[id];
        return (
          <button
            key={id}
            type="button"
            onClick={() => onPick(id)}
            className="group flex min-h-28 flex-col items-start gap-3 rounded-card border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <span className="flex size-10 items-center justify-center rounded-btn bg-primary/10 text-primary transition-transform group-hover:scale-105">
              {meta.icon}
            </span>
            <span>
              <span className="block text-sm font-semibold text-foreground">
                {meta.name[locale]}
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                {meta.desc[locale]}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Uncontrolled contentEditable text block                             */
/* ------------------------------------------------------------------ */

const FONT_FAMILY_CSS: Record<WFamily, string> = {
  sans: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  serif: '"Times New Roman", Times, "Liberation Serif", serif',
  mono: '"Courier New", Courier, "Liberation Mono", monospace',
};

export function fontFamilyCss(family: WFamily): string {
  return FONT_FAMILY_CSS[family];
}

export function EditableText({
  html,
  version,
  className,
  style,
  placeholder,
  ariaLabel,
  autoFocusToken,
  onInput,
  onKeyDown,
  onFocusBlock,
}: {
  html: string;
  /** Bump to force innerHTML re-sync (undo/redo, turn-into, template). */
  version: number;
  className?: string;
  style?: CSSProperties;
  placeholder: string;
  ariaLabel: string;
  /** When this number changes, the block takes focus with caret at end. */
  autoFocusToken?: number;
  onInput: (element: HTMLDivElement) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onFocusBlock: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.innerHTML !== html) el.innerHTML = html;
  }, [version]);

  useEffect(() => {
    if (autoFocusToken === undefined || autoFocusToken === 0) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [autoFocusToken]);

  return (
    <div
      ref={ref}
      role="textbox"
      aria-multiline="true"
      aria-label={ariaLabel}
      contentEditable
      suppressContentEditableWarning
      spellCheck
      data-placeholder={placeholder}
      className={
        "min-h-6 w-full whitespace-pre-wrap break-words rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 empty:before:text-muted-foreground/60 empty:before:content-[attr(data-placeholder)] " +
        (className ?? "")
      }
      style={style}
      onFocus={onFocusBlock}
      onInput={(event) => onInput(event.currentTarget)}
      onKeyDown={onKeyDown}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Preview                                                             */
/* ------------------------------------------------------------------ */

export const PREVIEW_DEVA_FAMILY =
  '"DocoWriteDeva", "Noto Sans Devanagari", sans-serif';

export function previewCssFamily(
  family: WFamily,
  script: "std" | "noto"
): string {
  if (script === "noto") return PREVIEW_DEVA_FAMILY;
  return FONT_FAMILY_CSS[family];
}

/* ------------------------------------------------------------------ */
/* Block shells + kind views                                           */
/* ------------------------------------------------------------------ */

export function BlockShell({
  children,
  controls,
}: {
  children: ReactNode;
  controls: ReactNode;
}) {
  return (
    <div className="group relative flex flex-col gap-1">
      {children}
      <div className="flex flex-wrap items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 max-md:opacity-100">
        {controls}
      </div>
    </div>
  );
}

export function RailButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled === true}
      onClick={onClick}
      className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}

export function RailControls({
  onUp,
  onDown,
  onDuplicate,
  onDelete,
  t,
  first,
  last,
}: {
  onUp: () => void;
  onDown: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  t: (key: string) => string;
  first: boolean;
  last: boolean;
}) {
  return (
    <>
      <RailButton label={t("write.moveUp")} onClick={onUp} disabled={first}>
        <ChevronUp className="size-4" aria-hidden="true" />
      </RailButton>
      <RailButton label={t("write.moveDown")} onClick={onDown} disabled={last}>
        <ChevronDown className="size-4" aria-hidden="true" />
      </RailButton>
      <RailButton label={t("write.duplicate")} onClick={onDuplicate}>
        <Copy className="size-4" aria-hidden="true" />
      </RailButton>
      <RailButton label={t("write.delete")} onClick={onDelete}>
        <Trash2 className="size-4" aria-hidden="true" />
      </RailButton>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Add-block menu (dropdown handled by the surface via shadcn)          */
/* ------------------------------------------------------------------ */

export const BLOCK_MENU_ITEMS: {
  kind: string;
  labelKey: string;
  icon: ReactNode;
}[] = [
  { kind: "p", labelKey: "write.blockP", icon: <Pilcrow className="size-4" aria-hidden="true" /> },
  { kind: "h1", labelKey: "write.blockH1", icon: <Heading1 className="size-4" aria-hidden="true" /> },
  { kind: "h2", labelKey: "write.blockH2", icon: <Heading2 className="size-4" aria-hidden="true" /> },
  { kind: "h3", labelKey: "write.blockH3", icon: <Heading3 className="size-4" aria-hidden="true" /> },
  { kind: "bullet", labelKey: "write.blockBullet", icon: <List className="size-4" aria-hidden="true" /> },
  { kind: "numbered", labelKey: "write.blockNumbered", icon: <ListOrdered className="size-4" aria-hidden="true" /> },
  { kind: "quote", labelKey: "write.blockQuote", icon: <TextQuote className="size-4" aria-hidden="true" /> },
  { kind: "table", labelKey: "write.blockTable", icon: <TableIcon className="size-4" aria-hidden="true" /> },
  { kind: "image", labelKey: "write.blockImage", icon: <ImageIcon className="size-4" aria-hidden="true" /> },
  { kind: "hr", labelKey: "write.blockHr", icon: <Minus className="size-4" aria-hidden="true" /> },
  { kind: "pagebreak", labelKey: "write.blockBreak", icon: <ArrowDownToLine className="size-4" aria-hidden="true" /> },
];

/* ------------------------------------------------------------------ */
/* Toolbar buttons (surface passes handlers + state)                   */
/* ------------------------------------------------------------------ */

export function ToolbarDivider() {
  return <span className="mx-1 hidden h-5 w-px bg-border sm:block" aria-hidden="true" />;
}

export function ModeToggle({
  mode,
  onMode,
  t,
}: {
  mode: "edit" | "preview";
  onMode: (mode: "edit" | "preview") => void;
  t: (key: string) => string;
}) {
  return (
    <div
      role="group"
      aria-label={t("write.modeLabel")}
      className="inline-flex overflow-hidden rounded-btn border border-border"
    >
      <button
        type="button"
        aria-pressed={mode === "edit"}
        onClick={() => onMode("edit")}
        className={
          "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 " +
          (mode === "edit"
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-foreground")
        }
      >
        <PencilLine className="size-3.5" aria-hidden="true" />
        {t("write.modeEdit")}
      </button>
      <button
        type="button"
        aria-pressed={mode === "preview"}
        onClick={() => onMode("preview")}
        className={
          "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 " +
          (mode === "preview"
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-foreground")
        }
      >
        <Eye className="size-3.5" aria-hidden="true" />
        {t("write.modePreview")}
      </button>
    </div>
  );
}

export function ExportButton({
  onClick,
  busy,
  t,
}: {
  onClick: () => void;
  busy: boolean;
  t: (key: string) => string;
}) {
  return (
    <Button
      type="button"
      size="touch"
      onClick={onClick}
      disabled={busy}
      className="rounded-btn font-semibold"
    >
      {busy ? (
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        <Download className="size-4" aria-hidden="true" />
      )}
      {busy ? t("write.exporting") : t("write.export")}
    </Button>
  );
}

export function HistoryButtons({
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  t,
}: {
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  t: (key: string) => string;
}) {
  return (
    <div className="flex items-center gap-0.5">
      <IconBtn label={t("write.undo")} onClick={onUndo} disabled={!canUndo}>
        <Undo2 className="size-4" aria-hidden="true" />
      </IconBtn>
      <IconBtn label={t("write.redo")} onClick={onRedo} disabled={!canRedo}>
        <Redo2 className="size-4" aria-hidden="true" />
      </IconBtn>
    </div>
  );
}

export function SetupToggle({
  open,
  onToggle,
  t,
}: {
  open: boolean;
  onToggle: () => void;
  t: (key: string) => string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={
        "inline-flex items-center gap-1.5 rounded-btn border border-border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 " +
        (open
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground")
      }
    >
      <Settings2 className="size-3.5" aria-hidden="true" />
      {t("write.setupTitle")}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Page setup panel                                                    */
/* ------------------------------------------------------------------ */

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

export function PageSetupPanel({
  setup,
  onChange,
  t,
}: {
  setup: {
    pageSize: string;
    landscape: boolean;
    margins: string;
    headerText: string;
    footerText: string;
    pageNumbers: string;
    pageNumFormat: string;
  };
  onChange: (patch: Record<string, string | boolean>) => void;
  t: (key: string) => string;
}) {
  const triggerClass = "h-8 rounded-btn text-xs";
  return (
    <div className="grid gap-3 rounded-card border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
      <Field label={t("write.setupSize")}>
        <Select
          value={setup.pageSize}
          onValueChange={(v) => onChange({ pageSize: v })}
        >
          <SelectTrigger className={triggerClass} aria-label={t("write.setupSize")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="a4">{t("write.sizeA4")}</SelectItem>
            <SelectItem value="letter">{t("write.sizeLetter")}</SelectItem>
            <SelectItem value="a5">{t("write.sizeA5")}</SelectItem>
            <SelectItem value="legal">{t("write.sizeLegal")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label={t("write.setupOrientation")}>
        <Select
          value={setup.landscape ? "landscape" : "portrait"}
          onValueChange={(v) => onChange({ landscape: v === "landscape" })}
        >
          <SelectTrigger
            className={triggerClass}
            aria-label={t("write.setupOrientation")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="portrait">{t("write.orientPortrait")}</SelectItem>
            <SelectItem value="landscape">{t("write.orientLandscape")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label={t("write.setupMargins")}>
        <Select
          value={setup.margins}
          onValueChange={(v) => onChange({ margins: v })}
        >
          <SelectTrigger
            className={triggerClass}
            aria-label={t("write.setupMargins")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="normal">{t("write.marginNormal")}</SelectItem>
            <SelectItem value="narrow">{t("write.marginNarrow")}</SelectItem>
            <SelectItem value="wide">{t("write.marginWide")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label={t("write.setupPageNumbers")}>
        <Select
          value={setup.pageNumbers}
          onValueChange={(v) => onChange({ pageNumbers: v })}
        >
          <SelectTrigger
            className={triggerClass}
            aria-label={t("write.setupPageNumbers")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{t("write.pnNone")}</SelectItem>
            <SelectItem value="center">{t("write.pnCenter")}</SelectItem>
            <SelectItem value="right">{t("write.pnRight")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label={t("write.setupPnFormat")}>
        <Select
          value={setup.pageNumFormat}
          onValueChange={(v) => onChange({ pageNumFormat: v })}
        >
          <SelectTrigger
            className={triggerClass}
            aria-label={t("write.setupPnFormat")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="n">{t("write.pnFormatN")}</SelectItem>
            <SelectItem value="nOfN">{t("write.pnFormatNOfN")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label={t("write.setupHeader")}>
        <Input
          value={setup.headerText}
          onChange={(e) => onChange({ headerText: e.target.value })}
          placeholder={t("write.setupHeaderPh")}
          className="h-8 rounded-btn text-xs"
        />
      </Field>
      <Field label={t("write.setupFooter")}>
        <Input
          value={setup.footerText}
          onChange={(e) => onChange({ footerText: e.target.value })}
          placeholder={t("write.setupFooterPh")}
          className="h-8 rounded-btn text-xs"
        />
      </Field>
      <p className="self-end text-[11px] leading-relaxed text-muted-foreground">
        {t("write.setupVars")}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Formatting toolbar (contextual — acts on focused block / selection)  */
/* ------------------------------------------------------------------ */

export function FormatToolbar({
  bold,
  italic,
  underline,
  onFormat,
  family,
  onFamily,
  align,
  onAlign,
  size,
  onSize,
  onColor,
  color,
  kind,
  onKind,
  t,
  textFocused,
}: {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  onFormat: (cmd: "bold" | "italic" | "underline") => void;
  family: WFamily;
  onFamily: (family: WFamily) => void;
  align: WAlign;
  onAlign: (align: WAlign) => void;
  size: number | null;
  onSize: (size: number) => void;
  onColor: (hex: string) => void;
  color: string;
  kind: string;
  onKind: (kind: string) => void;
  t: (key: string) => string;
  textFocused: boolean;
}) {
  const triggerClass = "h-8 rounded-btn text-xs";
  const kindValue = ["p", "h1", "h2", "h3", "bullet", "numbered", "quote"].includes(kind)
    ? kind
    : "p";
  return (
    <div
      role="toolbar"
      aria-label={t("write.toolbarLabel")}
      className="flex flex-wrap items-center gap-0.5 rounded-card border border-border bg-card p-1.5"
    >
      <IconBtn
        label={t("write.bold")}
        onClick={() => onFormat("bold")}
        active={bold}
        disabled={!textFocused}
      >
        <Bold className="size-4" aria-hidden="true" />
      </IconBtn>
      <IconBtn
        label={t("write.italic")}
        onClick={() => onFormat("italic")}
        active={italic}
        disabled={!textFocused}
      >
        <Italic className="size-4" aria-hidden="true" />
      </IconBtn>
      <IconBtn
        label={t("write.underline")}
        onClick={() => onFormat("underline")}
        active={underline}
        disabled={!textFocused}
      >
        <Underline className="size-4" aria-hidden="true" />
      </IconBtn>
      <ToolbarDivider />
      <label
        className="relative inline-flex size-11 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-within:outline-none focus-within:ring-[3px] focus-within:ring-ring/50 md:size-8"
        title={t("write.color")}
      >
        <span
          className="size-4 rounded-full border border-border"
          style={{ backgroundColor: color }}
          aria-hidden="true"
        />
        <span className="sr-only">{t("write.color")}</span>
        <input
          type="color"
          value={color}
          onChange={(e) => onColor(e.target.value)}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
          disabled={!textFocused}
        />
      </label>
      <ToolbarDivider />
      <Select value={kindValue} onValueChange={onKind}>
        <SelectTrigger className={triggerClass + " w-28"} aria-label={t("write.turnInto")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="p">{t("write.blockP")}</SelectItem>
          <SelectItem value="h1">{t("write.blockH1")}</SelectItem>
          <SelectItem value="h2">{t("write.blockH2")}</SelectItem>
          <SelectItem value="h3">{t("write.blockH3")}</SelectItem>
          <SelectItem value="bullet">{t("write.blockBullet")}</SelectItem>
          <SelectItem value="numbered">{t("write.blockNumbered")}</SelectItem>
          <SelectItem value="quote">{t("write.blockQuote")}</SelectItem>
        </SelectContent>
      </Select>
      <Select value={family} onValueChange={(v) => onFamily(v as WFamily)}>
        <SelectTrigger className={triggerClass + " w-24"} aria-label={t("write.family")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="sans">{t("write.familySans")}</SelectItem>
          <SelectItem value="serif">{t("write.familySerif")}</SelectItem>
          <SelectItem value="mono">{t("write.familyMono")}</SelectItem>
        </SelectContent>
      </Select>
      {kindValue === "p" && size !== null ? (
        <Select
          value={String(size)}
          onValueChange={(v) => onSize(Number(v))}
        >
          <SelectTrigger className={triggerClass + " w-16"} aria-label={t("write.size")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[9, 10, 11, 12, 14, 16, 18].map((s) => (
              <SelectItem key={s} value={String(s)}>
                {s} pt
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <ToolbarDivider />
      <IconBtn
        label={t("write.alignLeft")}
        onClick={() => onAlign("left")}
        active={align === "left"}
      >
        <AlignLeft className="size-4" aria-hidden="true" />
      </IconBtn>
      <IconBtn
        label={t("write.alignCenter")}
        onClick={() => onAlign("center")}
        active={align === "center"}
      >
        <AlignCenter className="size-4" aria-hidden="true" />
      </IconBtn>
      <IconBtn
        label={t("write.alignRight")}
        onClick={() => onAlign("right")}
        active={align === "right"}
      >
        <AlignRight className="size-4" aria-hidden="true" />
      </IconBtn>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Table editor                                                        */
/* ------------------------------------------------------------------ */

export function TableEditor({
  rows,
  header,
  onCell,
  onAddRow,
  onAddCol,
  onDelRow,
  onDelCol,
  onToggleHeader,
  t,
}: {
  rows: string[][];
  header: boolean;
  onCell: (r: number, c: number, value: string) => void;
  onAddRow: () => void;
  onAddCol: () => void;
  onDelRow: () => void;
  onDelCol: () => void;
  onToggleHeader: (header: boolean) => void;
  t: (key: string) => string;
}) {
  const cols = rows[0]?.length ?? 0;
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto scrollbar-thin rounded-card border border-border">
        <table className="w-full border-collapse text-xs">
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td
                    key={c}
                    className="border border-border p-0 align-top"
                    style={
                      header && r === 0
                        ? { backgroundColor: "var(--muted)" }
                        : undefined
                    }
                  >
                    <input
                      value={cell}
                      onChange={(e) => onCell(r, c, e.target.value)}
                      aria-label={t("write.tableCell").replace("{r}", String(r + 1)).replace("{c}", String(c + 1))}
                      className="w-full min-w-24 bg-transparent px-2 py-1.5 text-xs text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <RailButton label={t("write.tableAddRow")} onClick={onAddRow}>
          <Plus className="size-4" aria-hidden="true" />
          <span className="sr-only">{t("write.tableAddRow")}</span>
        </RailButton>
        <span className="text-[11px] text-muted-foreground">{t("write.tableAddRow")}</span>
        <RailButton label={t("write.tableAddCol")} onClick={onAddCol}>
          <Plus className="size-4" aria-hidden="true" />
        </RailButton>
        <span className="text-[11px] text-muted-foreground">{t("write.tableAddCol")}</span>
        <RailButton label={t("write.tableDelRow")} onClick={onDelRow}>
          <Minus className="size-4" aria-hidden="true" />
        </RailButton>
        <RailButton label={t("write.tableDelCol")} onClick={onDelCol}>
          <Minus className="size-4 rotate-45" aria-hidden="true" />
        </RailButton>
        <label className="ml-2 flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={header}
            onChange={(e) => onToggleHeader(e.target.checked)}
            className="size-4 accent-[var(--primary)]"
          />
          {t("write.tableHeader")}
        </label>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Export progress + done chip                                          */
/* ------------------------------------------------------------------ */

export function ExportProgress({ pct, t }: { pct: number; t: (key: string) => string }) {
  return (
    <div className="flex items-center gap-2 rounded-card border border-border bg-card p-3 text-xs text-muted-foreground">
      <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span>{t("write.exporting")}</span>
    </div>
  );
}
