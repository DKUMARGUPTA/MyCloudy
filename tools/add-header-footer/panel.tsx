"use client";

import { useId, useState } from "react";
import {
  AlignHorizontalJustifyCenter,
  Braces,
  CalendarDays,
  FileInput,
  PanelBottom,
  PanelTop,
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
import { useI18n } from "@/components/providers/locale-provider";
import type { ToolPanelProps } from "@/lib/tools/panel-types";
import { cn } from "@/lib/utils";
import {
  WM_COLORS,
  WM_FONTS,
  parseHexColor,
} from "../add-watermark/wm-options";
import {
  HF_IDS,
  hfHasAnyText,
  resolveHfOptions,
  type HfOptions,
} from "./hf-options";

/**
 * Header & footer design panel (PRD §8.2): left/center/right header + footer
 * text with {page} {pages} {date} {filename} {title} variables, shared
 * font/size/color, edge distance, date shape, page targeting. Every change
 * lands in the shared option values so the preview and the worker agree.
 */

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

function VarChip({ token, label }: { token: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-chip border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium">
      <code className="font-mono text-primary">{token}</code>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

function SlotField({
  id,
  label,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-[11px] font-medium text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        type="text"
        maxLength={120}
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 rounded-btn text-sm"
      />
    </div>
  );
}

export function HeaderFooterPanel({ values, onChange }: ToolPanelProps) {
  const { t } = useI18n();
  const hf = resolveHfOptions(values);
  const inputId = useId();
  const [hexDraft, setHexDraft] = useState<string>(hf.color);

  const empty = !hfHasAnyText(hf);

  const pickSwatch = (color: string): void => {
    setHexDraft(color);
    onChange(HF_IDS.color, color);
  };

  const applyHexDraft = (): void => {
    const parsed = parseHexColor(hexDraft);
    if (parsed) {
      const normalized = hexDraft.trim().replace(/^#/, "").toUpperCase();
      onChange(HF_IDS.color, `#${normalized}`);
    } else {
      setHexDraft(hf.color);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {empty ? (
        <div className="flex items-start gap-2.5 rounded-card border border-amber-300/60 bg-amber-50 px-3 py-2.5 dark:border-amber-500/30 dark:bg-amber-950/40">
          <TriangleAlert
            className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden="true"
          />
          <p className="text-xs leading-relaxed text-amber-900 dark:text-amber-200">
            {t("hf.ctaEmpty")}
          </p>
        </div>
      ) : null}

      {/* Variables legend */}
      <div className="flex flex-col gap-2 rounded-card border border-border bg-muted/30 px-3 py-2.5">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
          <Braces className="size-3.5 text-primary" aria-hidden="true" />
          {t("hf.varsTitle")}
        </p>
        <div className="flex flex-wrap gap-1.5">
          <VarChip token="{page}" label={t("hf.varPage")} />
          <VarChip token="{pages}" label={t("hf.varPages")} />
          <VarChip token="{date}" label={t("hf.varDate")} />
          <VarChip token="{filename}" label={t("hf.varFilename")} />
          <VarChip token="{title}" label={t("hf.varTitle")} />
        </div>
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          {t("hf.varsHint")}
        </p>
      </div>

      {/* Header slots */}
      <div className="flex flex-col gap-3">
        <SectionTitle icon={<PanelTop className="size-3.5" />} label={t("hf.headerTitle")} />
        <div className="flex flex-col gap-2.5">
          <SlotField
            id={`${inputId}-hl`}
            label={t("hf.left")}
            value={hf.headerLeft}
            placeholder={t("hf.phLeft")}
            onChange={(next) => onChange(HF_IDS.headerLeft, next)}
          />
          <SlotField
            id={`${inputId}-hc`}
            label={t("hf.center")}
            value={hf.headerCenter}
            placeholder={t("hf.phCenter")}
            onChange={(next) => onChange(HF_IDS.headerCenter, next)}
          />
          <SlotField
            id={`${inputId}-hr`}
            label={t("hf.right")}
            value={hf.headerRight}
            placeholder={t("hf.phRight")}
            onChange={(next) => onChange(HF_IDS.headerRight, next)}
          />
        </div>
      </div>

      {/* Footer slots */}
      <div className="flex flex-col gap-3">
        <SectionTitle icon={<PanelBottom className="size-3.5" />} label={t("hf.footerTitle")} />
        <div className="flex flex-col gap-2.5">
          <SlotField
            id={`${inputId}-fl`}
            label={t("hf.left")}
            value={hf.footerLeft}
            placeholder={t("hf.phLeft")}
            onChange={(next) => onChange(HF_IDS.footerLeft, next)}
          />
          <SlotField
            id={`${inputId}-fc`}
            label={t("hf.center")}
            value={hf.footerCenter}
            placeholder={t("hf.phCenter")}
            onChange={(next) => onChange(HF_IDS.footerCenter, next)}
          />
          <SlotField
            id={`${inputId}-fr`}
            label={t("hf.right")}
            value={hf.footerRight}
            placeholder={t("hf.phRight")}
            onChange={(next) => onChange(HF_IDS.footerRight, next)}
          />
        </div>
      </div>

      {/* Style */}
      <div className="flex flex-col gap-4 border-t border-border pt-4">
        <SectionTitle icon={<Type className="size-3.5" />} label={t("pn.styleTitle")} />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${inputId}-font`} className="text-sm font-medium">
            {t("wm.font")}
          </Label>
          <Select
            value={hf.font}
            onValueChange={(next) => onChange(HF_IDS.font, next)}
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
          <p className="text-[11px] text-muted-foreground">{t("hf.fontHint")}</p>
        </div>

        <SliderRow
          id={`${inputId}-size`}
          label={t("wm.size")}
          value={hf.size}
          min={6}
          max={24}
          step={1}
          format={(v) => `${v} pt`}
          onChange={(next) => onChange(HF_IDS.size, next)}
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
                aria-pressed={hf.color === color}
                className={cn(
                  "flex h-8 w-full items-center justify-center rounded-md border transition-all",
                  hf.color === color
                    ? "border-primary ring-2 ring-primary/40 scale-105"
                    : "border-border hover:scale-105"
                )}
                style={{ backgroundColor: color }}
              >
                {hf.color === color ? (
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
              placeholder="374151"
              className="h-9 rounded-btn font-mono text-xs uppercase"
            />
          </div>
        </div>

        <SliderRow
          id={`${inputId}-opacity`}
          label={t("wm.opacity")}
          value={Math.round(hf.opacity * 100)}
          min={5}
          max={100}
          step={1}
          format={(v) => `${v}%`}
          onChange={(next) => onChange(HF_IDS.opacity, next / 100)}
        />

        <SliderRow
          id={`${inputId}-margin`}
          label={t("hf.margin")}
          value={hf.margin}
          min={12}
          max={96}
          step={2}
          format={(v) => `${v} pt`}
          onChange={(next) => onChange(HF_IDS.margin, next)}
        />

        <div className="flex flex-col gap-1.5">
          <Label
            htmlFor={`${inputId}-datefmt`}
            className="flex items-center gap-1.5 text-sm font-medium"
          >
            <CalendarDays className="size-3.5 text-primary" aria-hidden="true" />
            {t("hf.dateFormat")}
          </Label>
          <Select
            value={hf.dateFormat}
            onValueChange={(next) => onChange(HF_IDS.dateFormat, next)}
          >
            <SelectTrigger
              id={`${inputId}-datefmt`}
              className="h-11 w-full rounded-btn"
              aria-label={t("hf.dateFormat")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="dmy">{t("hf.dmy")}</SelectItem>
              <SelectItem value="mdy">{t("hf.mdy")}</SelectItem>
              <SelectItem value="ymd">{t("hf.ymd")}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">{t("hf.dateHint")}</p>
        </div>
      </div>

      {/* Page targeting */}
      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <SectionTitle
          icon={<FileInput className="size-3.5" />}
          label={t("wm.pagesTitle")}
        />
        <Select
          value={hf.layout}
          onValueChange={(next) => onChange(HF_IDS.layout, next)}
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
        {hf.layout === "range" ? (
          <Input
            id={`${inputId}-pages`}
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder={t("tool.pagesPlaceholder")}
            value={hf.pages}
            onChange={(event) => onChange(HF_IDS.pages, event.target.value)}
            className="h-11 rounded-btn font-medium"
            aria-label={t("wm.layoutRange")}
          />
        ) : null}
        <p className="text-[11px] text-muted-foreground">
          {hf.layout === "range" && hf.pages.trim() !== "" && hf.pages.trim() !== "all"
            ? t("wm.rangeHint")
            : t("wm.markedAll")}
        </p>
      </div>
    </div>
  );
}
