"use client";

import { useId, useState } from "react";
import {
  Hash,
  Languages,
  Layers,
  ListOrdered,
  TriangleAlert,
  Type,
} from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/components/providers/locale-provider";
import type { ToolPanelProps } from "@/lib/tools/panel-types";
import { cn } from "@/lib/utils";
import {
  WM_COLORS,
  WM_FONTS,
  WM_POSITIONS,
  parseHexColor,
  type WmPosition,
} from "../add-watermark/wm-options";
import { formatPageNumber } from "../stamp-common/layout";
import {
  PN_DEFAULTS,
  PN_IDS,
  formatUsesDigits,
  resolvePnOptions,
  type PnOptions,
} from "./pn-options";

/**
 * Page numbers design panel (PRD §8.2): format (with a live sample chip),
 * start number, Hindi digits, font/size/color/opacity, 9-grid position +
 * margin, page targeting. Every change lands in the shared option values,
 * so the preview surface and the worker stay in sync.
 */

const POSITION_LABEL_KEYS: Record<WmPosition, string> = {
  tl: "wm.posTl",
  tc: "wm.posTc",
  tr: "wm.posTr",
  ml: "wm.posMl",
  mc: "wm.posMc",
  mr: "wm.posMr",
  bl: "wm.posBl",
  bc: "wm.posBc",
  br: "wm.posBr",
};

const FORMAT_ITEMS: { value: PnOptions["format"]; key: string }[] = [
  { value: "plain", key: "pn.formatPlain" },
  { value: "page", key: "pn.formatPage" },
  { value: "slash", key: "pn.formatSlash" },
  { value: "pageOf", key: "pn.formatPageOf" },
  { value: "romanLower", key: "pn.formatRomanL" },
  { value: "romanUpper", key: "pn.formatRomanU" },
  { value: "alphaLower", key: "pn.formatAlphaL" },
  { value: "alphaUpper", key: "pn.formatAlphaU" },
];

function SectionTitle({
  icon,
  label,
}: {
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      <span className="text-primary" aria-hidden="true">
        {icon}
      </span>
      {label}
    </p>
  );
}

function SliderRow({
  id,
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (next: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        <span className="rounded-chip bg-primary/10 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-primary">
          {format(value)}
        </span>
      </div>
      <Slider
        id={id}
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(next) => onChange(next[0] ?? value)}
        className="py-1.5"
        aria-label={label}
      />
    </div>
  );
}

export function PageNumbersPanel({ values, onChange }: ToolPanelProps) {
  const { t } = useI18n();
  const pn = resolvePnOptions(values);
  const inputId = useId();
  const [hexDraft, setHexDraft] = useState<string>(pn.color);

  const sample = formatPageNumber(
    pn.start,
    pn.format,
    10,
    pn.hindiDigits && formatUsesDigits(pn.format)
  );
  const digitsAllowed = formatUsesDigits(pn.format);

  const pickSwatch = (color: string): void => {
    setHexDraft(color);
    onChange(PN_IDS.color, color);
  };

  const applyHexDraft = (): void => {
    const parsed = parseHexColor(hexDraft);
    if (parsed) {
      const normalized = hexDraft.trim().replace(/^#/, "").toUpperCase();
      onChange(PN_IDS.color, `#${normalized}`);
    } else {
      setHexDraft(pn.color);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Number format */}
      <div className="flex flex-col gap-3">
        <SectionTitle
          icon={<ListOrdered className="size-3.5" />}
          label={t("pn.formatTitle")}
        />
        <Select
          value={pn.format}
          onValueChange={(next) => onChange(PN_IDS.format, next)}
        >
          <SelectTrigger
            id={`${inputId}-format`}
            aria-label={t("pn.format")}
            className="h-11 w-full rounded-btn"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FORMAT_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {t(item.key)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center justify-between gap-2 rounded-card border border-border bg-muted/40 px-3 py-2">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Hash className="size-3.5" aria-hidden="true" />
            {t("pn.sample")}
          </span>
          <span className="rounded-chip bg-primary/10 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-primary">
            {sample}
          </span>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${inputId}-start`} className="text-sm font-medium">
            {t("pn.start")}
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id={`${inputId}-start`}
              type="number"
              min={1}
              max={9999}
              step={1}
              value={pn.start}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isFinite(next)) onChange(PN_IDS.start, next);
              }}
              className="h-11 rounded-btn tabular-nums font-medium"
            />
            <div className="flex shrink-0 flex-col">
              <button
                type="button"
                aria-label={t("pn.startUp")}
                onClick={() => onChange(PN_IDS.start, Math.min(9999, pn.start + 1))}
                className="flex h-5 w-8 items-center justify-center rounded-t-md border border-b-0 border-border text-muted-foreground transition-colors hover:text-foreground"
              >
                <span aria-hidden="true" className="text-[8px] leading-none">▲</span>
              </button>
              <button
                type="button"
                aria-label={t("pn.startDown")}
                onClick={() => onChange(PN_IDS.start, Math.max(1, pn.start - 1))}
                className="flex h-5 w-8 items-center justify-center rounded-b-md border border-border text-muted-foreground transition-colors hover:text-foreground"
              >
                <span aria-hidden="true" className="text-[8px] leading-none">▼</span>
              </button>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">{t("pn.startHint")}</p>
        </div>

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Label
              htmlFor={`${inputId}-hindi`}
              className="flex items-center gap-1.5 text-sm font-medium"
            >
              <Languages className="size-3.5 text-primary" aria-hidden="true" />
              {t("pn.hindiDigits")}
            </Label>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {digitsAllowed ? t("pn.hindiHint") : t("pn.hindiRomanOff")}
            </p>
          </div>
          <Switch
            id={`${inputId}-hindi`}
            checked={pn.hindiDigits && digitsAllowed}
            disabled={!digitsAllowed}
            onCheckedChange={(next) => onChange(PN_IDS.hindiDigits, next)}
            aria-label={t("pn.hindiDigits")}
          />
        </div>
        {pn.hindiDigits && digitsAllowed ? (
          <div className="flex items-center gap-2 rounded-card border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-950/40 dark:text-emerald-300">
            <span className="font-semibold">०१२३४५६७८९</span>
            <span className="leading-tight">{t("pn.hindiOn")}</span>
          </div>
        ) : null}
      </div>

      {/* Style */}
      <div className="flex flex-col gap-4 border-t border-border pt-4">
        <SectionTitle icon={<Type className="size-3.5" />} label={t("pn.styleTitle")} />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${inputId}-font`} className="text-sm font-medium">
            {t("wm.font")}
          </Label>
          <Select
            value={pn.font}
            onValueChange={(next) => onChange(PN_IDS.font, next)}
            disabled={pn.hindiDigits && digitsAllowed}
          >
            <SelectTrigger
              id={`${inputId}-font`}
              className="h-11 w-full rounded-btn"
              aria-label={t("wm.font")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WM_FONTS.map((font) => (
                <SelectItem key={font.id} value={font.id}>
                  {t(font.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {pn.hindiDigits && digitsAllowed ? (
            <p className="text-[11px] text-muted-foreground">{t("pn.fontForced")}</p>
          ) : null}
        </div>

        <SliderRow
          id={`${inputId}-size`}
          label={t("wm.size")}
          value={pn.size}
          min={6}
          max={48}
          step={1}
          format={(v) => `${v} pt`}
          onChange={(next) => onChange(PN_IDS.size, next)}
        />

        <div className="flex flex-col gap-2">
          <Label className="text-sm font-medium">{t("wm.color")}</Label>
          <div className="grid grid-cols-8 gap-1.5">
            {WM_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => pickSwatch(color)}
                aria-label={`${t("wm.color")} ${color}`}
                aria-pressed={pn.color === color}
                className={cn(
                  "flex h-8 w-full items-center justify-center rounded-md border transition-all",
                  pn.color === color
                    ? "border-primary ring-2 ring-primary/40 scale-105"
                    : "border-border hover:scale-105"
                )}
                style={{ backgroundColor: color }}
              >
                {pn.color === color ? (
                  <span className="sr-only">(selected)</span>
                ) : null}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">#</span>
            <Input
              type="text"
              maxLength={7}
              spellCheck={false}
              autoComplete="off"
              value={hexDraft.replace(/^#/, "")}
              onChange={(event) => setHexDraft(event.target.value)}
              onBlur={applyHexDraft}
              onKeyDown={(event) => {
                if (event.key === "Enter") applyHexDraft();
              }}
              aria-label={t("wm.colorCustom")}
              placeholder="111827"
              className="h-9 rounded-btn font-mono text-xs uppercase"
            />
          </div>
        </div>

        <SliderRow
          id={`${inputId}-opacity`}
          label={t("wm.opacity")}
          value={Math.round(pn.opacity * 100)}
          min={5}
          max={100}
          step={1}
          format={(v) => `${v}%`}
          onChange={(next) => onChange(PN_IDS.opacity, next / 100)}
        />
      </div>

      {/* Placement */}
      <div className="flex flex-col gap-4 border-t border-border pt-4">
        <SectionTitle icon={<Layers className="size-3.5" />} label={t("wm.placementTitle")} />
        <div className="flex flex-col gap-2">
          <Label className="text-sm font-medium">{t("wm.position")}</Label>
          <div
            role="group"
            aria-label={t("wm.position")}
            className="grid w-fit grid-cols-3 gap-1 rounded-btn border border-border bg-muted/40 p-1.5"
          >
            {WM_POSITIONS.map((position) => (
              <button
                key={position}
                type="button"
                onClick={() => onChange(PN_IDS.position, position)}
                aria-label={t(POSITION_LABEL_KEYS[position])}
                aria-pressed={pn.position === position}
                className={cn(
                  "size-8 rounded-md border transition-all",
                  pn.position === position
                    ? "border-primary bg-primary/15 shadow-sm"
                    : "border-transparent bg-background/60 hover:border-border"
                )}
              >
                <span
                  className={cn(
                    "mx-auto block size-1.5 rounded-full transition-colors",
                    pn.position === position
                      ? "bg-primary"
                      : "bg-muted-foreground/50"
                  )}
                />
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {t(POSITION_LABEL_KEYS[pn.position])}
          </p>
        </div>
        <SliderRow
          id={`${inputId}-margin`}
          label={t("wm.margin")}
          value={pn.margin}
          min={12}
          max={96}
          step={2}
          format={(v) => `${v} pt`}
          onChange={(next) => onChange(PN_IDS.margin, next)}
        />
      </div>

      {/* Page targeting */}
      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <SectionTitle icon={<Layers className="size-3.5" />} label={t("wm.pagesTitle")} />
        <Select
          value={pn.layout}
          onValueChange={(next) => onChange(PN_IDS.layout, next)}
        >
          <SelectTrigger
            id={`${inputId}-layout`}
            aria-label={t("wm.layout")}
            className="h-11 w-full rounded-btn"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("wm.layoutAll")}</SelectItem>
            <SelectItem value="odd">{t("wm.layoutOdd")}</SelectItem>
            <SelectItem value="even">{t("wm.layoutEven")}</SelectItem>
            <SelectItem value="skipFirst">{t("wm.layoutSkip")}</SelectItem>
            <SelectItem value="range">{t("wm.layoutRange")}</SelectItem>
          </SelectContent>
        </Select>
        {pn.layout === "range" ? (
          <Input
            id={`${inputId}-pages`}
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder={t("tool.pagesPlaceholder")}
            value={pn.pages}
            onChange={(event) => onChange(PN_IDS.pages, event.target.value)}
            className="h-11 rounded-btn font-medium"
            aria-label={t("wm.layoutRange")}
          />
        ) : null}
        <p className="text-[11px] text-muted-foreground">
          {pn.layout === "range" && pn.pages.trim() !== "" && pn.pages.trim() !== "all"
            ? t("wm.rangeHint")
            : t("wm.markedAll")}
        </p>
        {!digitsAllowed && pn.hindiDigits ? (
          <div className="flex items-start gap-2.5 rounded-card border border-amber-300/60 bg-amber-50 px-3 py-2.5 dark:border-amber-500/30 dark:bg-amber-950/40">
            <TriangleAlert
              className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
              aria-hidden="true"
            />
            <p className="text-xs leading-relaxed text-amber-900 dark:text-amber-200">
              {t("pn.hindiRomanOff")}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
