"use client";

import { useId } from "react";
import {
  CopyPlus,
  Move,
  RotateCw,
  SquareStack,
  TriangleAlert,
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
import { WM_POSITIONS } from "../add-watermark/wm-options";
import {
  OV_IDS,
  resolveOverlayOptions,
  type OverlayPosition,
} from "./engine";

/**
 * Overlay PDF design panel (PRD §8.3): 9-grid position, size (% of the
 * base page width), opacity, rotation, behind-content and the page mapping
 * (which base pages get the overlay, which overlay page is used). Every
 * change lands in the shared option values, so the surface preview and the
 * worker stay in sync with exactly what the user sees here.
 */

const POSITION_LABEL_KEYS: Record<OverlayPosition, string> = {
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
  hint,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
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
      {hint ? (
        <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export function OverlayPanel({ values, onChange }: ToolPanelProps) {
  const { t } = useI18n();
  const opts = resolveOverlayOptions(values);
  const inputId = useId();

  return (
    <div className="flex flex-col gap-5">
      {/* Placement */}
      <div className="flex flex-col gap-4">
        <SectionTitle
          icon={<Move className="size-3.5" />}
          label={t("overlay.placementTitle")}
        />

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
                onClick={() => onChange(OV_IDS.position, position)}
                aria-label={t(POSITION_LABEL_KEYS[position])}
                aria-pressed={opts.position === position}
                className={cn(
                  "size-8 rounded-md border transition-all",
                  opts.position === position
                    ? "border-primary bg-primary/15 shadow-sm"
                    : "border-transparent bg-background/60 hover:border-border"
                )}
              >
                <span
                  className={cn(
                    "mx-auto block size-1.5 rounded-full transition-colors",
                    opts.position === position
                      ? "bg-primary"
                      : "bg-muted-foreground/50"
                  )}
                />
              </button>
            ))}
          </div>
          <SliderRow
            id={`${inputId}-margin`}
            label={t("wm.margin")}
            value={opts.margin}
            min={0}
            max={96}
            step={2}
            format={(v) => `${v} pt`}
            onChange={(next) => onChange(OV_IDS.margin, next)}
          />
        </div>

        <SliderRow
          id={`${inputId}-scale`}
          label={t("overlay.scale")}
          hint={t("overlay.scaleHint")}
          value={opts.scale}
          min={10}
          max={150}
          step={1}
          format={(v) => `${v}%`}
          onChange={(next) => onChange(OV_IDS.scale, next)}
        />

        <SliderRow
          id={`${inputId}-opacity`}
          label={t("wm.opacity")}
          value={Math.round(opts.opacity * 100)}
          min={5}
          max={100}
          step={1}
          format={(v) => `${v}%`}
          onChange={(next) => onChange(OV_IDS.opacity, next / 100)}
        />

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={`${inputId}-rotation`} className="text-sm font-medium">
              {t("wm.rotation")}
            </Label>
            <span className="flex items-center gap-1 rounded-chip bg-primary/10 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-primary">
              <RotateCw className="size-3" aria-hidden="true" />
              {opts.rotation}°
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {[-90, -45, 0, 45, 90].map((angle) => (
              <button
                key={angle}
                type="button"
                onClick={() => onChange(OV_IDS.rotation, angle)}
                aria-pressed={opts.rotation === angle}
                className={cn(
                  "h-8 flex-1 rounded-md border text-[10px] font-semibold tabular-nums transition-colors",
                  opts.rotation === angle
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground"
                )}
              >
                {angle}°
              </button>
            ))}
          </div>
          <Slider
            id={`${inputId}-rotation`}
            value={[opts.rotation]}
            min={-90}
            max={90}
            step={5}
            onValueChange={(next) =>
              onChange(OV_IDS.rotation, next[0] ?? opts.rotation)
            }
            className="py-1.5"
            aria-label={t("wm.rotation")}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <Label htmlFor={`${inputId}-behind`} className="text-sm font-medium">
              {t("wm.behind")}
            </Label>
            <p className="text-[11px] leading-snug text-muted-foreground">
              {t("wm.behindHint")}
            </p>
          </div>
          <Switch
            id={`${inputId}-behind`}
            checked={opts.behind}
            onCheckedChange={(next) => onChange(OV_IDS.behind, next)}
            aria-label={t("wm.behind")}
          />
        </div>
      </div>

      {/* Page mapping */}
      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <SectionTitle
          icon={<SquareStack className="size-3.5" />}
          label={t("overlay.mappingTitle")}
        />

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${inputId}-stamppages`} className="text-sm font-medium">
            {t("overlay.stampPages")}
          </Label>
          <Select
            value={opts.stampPages}
            onValueChange={(next) => onChange(OV_IDS.stampPages, next)}
          >
            <SelectTrigger
              id={`${inputId}-stamppages`}
              className="h-11 w-full rounded-btn"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("overlay.stampAll")}</SelectItem>
              <SelectItem value="first">{t("overlay.stampFirst")}</SelectItem>
              <SelectItem value="odd">{t("overlay.stampOdd")}</SelectItem>
              <SelectItem value="even">{t("overlay.stampEven")}</SelectItem>
              <SelectItem value="range">{t("overlay.stampRange")}</SelectItem>
            </SelectContent>
          </Select>
          {opts.stampPages === "range" ? (
            <Input
              id={`${inputId}-pages`}
              type="text"
              spellCheck={false}
              autoComplete="off"
              placeholder={t("tool.pagesPlaceholder")}
              value={opts.pages}
              onChange={(event) => onChange(OV_IDS.pages, event.target.value)}
              className="h-11 rounded-btn font-medium"
              aria-label={t("overlay.stampRange")}
            />
          ) : null}
          <p className="text-[11px] leading-snug text-muted-foreground">
            {opts.stampPages === "range" &&
            opts.pages.trim() !== "" &&
            opts.pages.trim() !== "all"
              ? t("wm.rangeHint")
              : t("overlay.stampHint")}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${inputId}-source`} className="text-sm font-medium">
            {t("overlay.source")}
          </Label>
          <Select
            value={opts.source}
            onValueChange={(next) => onChange(OV_IDS.source, next)}
          >
            <SelectTrigger
              id={`${inputId}-source`}
              className="h-11 w-full rounded-btn"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="first">{t("overlay.sourceFirst")}</SelectItem>
              <SelectItem value="match">{t("overlay.sourceMatch")}</SelectItem>
              <SelectItem value="cycle">{t("overlay.sourceCycle")}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[11px] leading-snug text-muted-foreground">
            {opts.source === "first"
              ? t("overlay.sourceFirstHint")
              : opts.source === "match"
                ? t("overlay.sourceMatchHint")
                : t("overlay.sourceCycleHint")}
          </p>
          {opts.source === "match" ? (
            <p className="flex items-start gap-1.5 text-[11px] leading-snug text-amber-700 dark:text-amber-400">
              <TriangleAlert
                className="mt-0.5 size-3 shrink-0"
                aria-hidden="true"
              />
              {t("overlay.sourceMatchWarn")}
            </p>
          ) : null}
        </div>
      </div>

      {/* What lands where (legend) */}
      <div className="flex items-start gap-2.5 rounded-card border border-border bg-muted/30 px-3 py-2.5">
        <CopyPlus className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t("overlay.mappingLegend")}
        </p>
      </div>
    </div>
  );
}

export default OverlayPanel;
