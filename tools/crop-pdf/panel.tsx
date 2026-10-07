"use client";

import { useId, useState } from "react";
import {
  Layers,
  RotateCcw,
  Ruler,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "@/components/providers/locale-provider";
import type { ToolPanelProps } from "@/lib/tools/panel-types";
import { cn } from "@/lib/utils";
import {
  CROP_IDS,
  CROP_UNITS,
  type CropUnit,
  formatPtInUnit,
  resolveCropOptions,
  toPt,
} from "./crop-options";

/**
 * Crop PDF design panel (PRD §8.2 "margins numeric"): unit (pt/mm/in), the
 * four margins arranged around a mini page diagram, reset, and page
 * targeting. Every change lands in the shared option values, so the drag
 * overlay, the before/after preview and the worker stay in sync.
 *
 * The margin fields keep local draft strings so typing ("1." or an empty
 * string) is never clobbered; the whole field group REMOUNTS via a `key`
 * whenever a value changes from outside (drag overlay, auto-detect, unit
 * switch, reset) — the documented "reset state with a key" pattern.
 */

const UNIT_KEYS: Record<CropUnit, string> = {
  pt: "crop.unitPt",
  mm: "crop.unitMm",
  in: "crop.unitIn",
};

function SectionTitle({
  icon,
  label,
}: {
  icon: React.ReactNode;
  label: string;
}): React.JSX.Element {
  return (
    <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      <span className="text-primary" aria-hidden="true">
        {icon}
      </span>
      {label}
    </p>
  );
}

/** Step for the number inputs per unit (1 pt / 1 mm / 0.25 in). */
function unitStep(unit: CropUnit): number {
  return unit === "pt" ? 1 : unit === "mm" ? 1 : 0.25;
}

/** One margin input: local draft, commits on blur/Enter. */
function MarginField({
  id,
  label,
  valuePt,
  unit,
  onCommit,
}: {
  id: string;
  label: string;
  valuePt: number;
  unit: CropUnit;
  onCommit: (pt: number) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<string>(() =>
    formatPtInUnit(valuePt, unit)
  );

  const commit = (raw: string): void => {
    const parsed = Number(raw.trim().replace(",", "."));
    if (Number.isFinite(parsed) && parsed >= 0) {
      const pt = Math.min(10000, toPt(parsed, unit));
      onCommit(Math.round(pt * 10) / 10);
    } else {
      setDraft(formatPtInUnit(valuePt, unit));
    }
  };

  return (
    <Input
      id={id}
      type="number"
      min={0}
      step={unitStep(unit)}
      inputMode="decimal"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => commit(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit(event.currentTarget.value);
      }}
      aria-label={label}
      className="h-10 w-full rounded-btn text-center tabular-nums"
    />
  );
}

export function CropPanel({ values, onChange }: ToolPanelProps) {
  const { t } = useI18n();
  const crop = resolveCropOptions(values);
  const inputId = useId();

  const resetMargins = (): void => {
    onChange(CROP_IDS.left, 0);
    onChange(CROP_IDS.top, 0);
    onChange(CROP_IDS.right, 0);
    onChange(CROP_IDS.bottom, 0);
  };

  const noOp =
    crop.left <= 0 && crop.top <= 0 && crop.right <= 0 && crop.bottom <= 0;

  const totalMargin = crop.left + crop.top + crop.right + crop.bottom;

  // Remount the margin fields whenever a value or the unit changes from
  // outside a field — drafts re-initialize from the new state.
  const fieldsKey = `${crop.unit}|${crop.left}|${crop.top}|${crop.right}|${crop.bottom}`;

  return (
    <div className="flex flex-col gap-5">
      {/* Margins */}
      <div className="flex flex-col gap-3">
        <SectionTitle
          icon={<Ruler className="size-3.5" />}
          label={t("crop.marginsTitle")}
        />
        <div
          role="group"
          aria-label={t("crop.unit")}
          className="grid w-fit grid-cols-3 gap-0.5 rounded-btn border border-border bg-muted/40 p-1"
        >
          {CROP_UNITS.map((unit) => (
            <button
              key={unit}
              type="button"
              onClick={() => onChange(CROP_IDS.unit, unit)}
              aria-pressed={crop.unit === unit}
              className={cn(
                "min-h-8 min-w-12 rounded-md px-2 text-[11px] font-semibold transition-colors",
                crop.unit === unit
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t(UNIT_KEYS[unit])}
            </button>
          ))}
        </div>

        {/* Margins arranged around a mini page. */}
        <div
          key={fieldsKey}
          className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] grid-rows-3 items-center gap-1.5"
        >
          <div className="col-start-2 row-start-1 w-20">
            <MarginField
              id={`${inputId}-top`}
              label={t("crop.mTop")}
              valuePt={crop.top}
              unit={crop.unit}
              onCommit={(pt) => onChange(CROP_IDS.top, pt)}
            />
          </div>
          <div className="col-start-1 row-start-2 w-full">
            <MarginField
              id={`${inputId}-left`}
              label={t("crop.mLeft")}
              valuePt={crop.left}
              unit={crop.unit}
              onCommit={(pt) => onChange(CROP_IDS.left, pt)}
            />
          </div>
          {/* Mini page visual in the center. */}
          <div
            aria-hidden="true"
            className="col-start-2 row-start-2 flex size-12 items-center justify-center rounded-btn border-2 border-dashed border-primary/50 bg-primary/5"
          >
            <span className="size-4 rounded-[2px] border border-primary/70 bg-primary/20" />
          </div>
          <div className="col-start-3 row-start-2 w-full">
            <MarginField
              id={`${inputId}-right`}
              label={t("crop.mRight")}
              valuePt={crop.right}
              unit={crop.unit}
              onCommit={(pt) => onChange(CROP_IDS.right, pt)}
            />
          </div>
          <div className="col-start-2 row-start-3 w-20">
            <MarginField
              id={`${inputId}-bottom`}
              label={t("crop.mBottom")}
              valuePt={crop.bottom}
              unit={crop.unit}
              onCommit={(pt) => onChange(CROP_IDS.bottom, pt)}
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 rounded-card border border-border bg-muted/40 px-3 py-2">
          <span className="text-[11px] text-muted-foreground">
            {noOp
              ? t("crop.hintFull")
              : t("crop.hintSum", {
                  sum: formatPtInUnit(totalMargin, crop.unit),
                  unit: crop.unit,
                })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 rounded-btn px-2 text-[11px]"
            onClick={resetMargins}
            disabled={noOp}
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
            {t("crop.reset")}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {t("crop.marginsHint")}
        </p>
      </div>

      {/* Page targeting */}
      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <SectionTitle icon={<Layers className="size-3.5" />} label={t("wm.pagesTitle")} />
        <Select
          value={crop.layout}
          onValueChange={(next) => onChange(CROP_IDS.layout, next)}
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
        {crop.layout === "range" ? (
          <Input
            id={`${inputId}-pages`}
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder={t("tool.pagesPlaceholder")}
            value={crop.pages}
            onChange={(event) => onChange(CROP_IDS.pages, event.target.value)}
            className="h-11 rounded-btn font-medium"
            aria-label={t("wm.layoutRange")}
          />
        ) : null}
        <p className="text-[11px] text-muted-foreground">
          {crop.layout === "range" && crop.pages.trim() !== "" && crop.pages.trim() !== "all"
            ? t("wm.rangeHint")
            : t("crop.pagesHint")}
        </p>
      </div>
    </div>
  );
}
