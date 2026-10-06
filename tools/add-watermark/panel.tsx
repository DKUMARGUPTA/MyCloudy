"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  Droplets,
  ImagePlus,
  Layers,
  RotateCw,
  SquareDashed,
  TriangleAlert,
  Type,
  X,
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
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/components/providers/locale-provider";
import type { ToolPanelProps } from "@/lib/tools/panel-types";
import { cn } from "@/lib/utils";
import {
  WM_COLORS,
  WM_FONTS,
  WM_IDS,
  WM_POSITIONS,
  parseHexColor,
  resolveWmOptions,
  type WmPosition,
} from "./wm-options";
import { getLogoFile, setLogoFile } from "./logo-store";

/**
 * Watermark design panel (PRD §8.2): text or logo, size/color/opacity/
 * rotation, 9-grid position, tiling, behind-content, page targeting.
 * Every change lands in the shared option values, so the surface preview
 * and the worker stay in sync with exactly what the user sees here.
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

export function WatermarkPanel({ values, onChange }: ToolPanelProps) {
  const { t } = useI18n();
  const wm = resolveWmOptions(values);
  const inputId = useId();

  // Logo state mirrors the in-memory store (lazy init — survives re-mounts
  // within the session, dies with the tab).
  const [logo, setLogo] = useState<File | null>(() => getLogoFile());
  const [logoUrl, setLogoUrl] = useState<string | null>(() => {
    const existing = getLogoFile();
    return existing ? URL.createObjectURL(existing) : null;
  });
  const [hexDraft, setHexDraft] = useState<string>(wm.color);
  const logoInputRef = useRef<HTMLInputElement>(null);

  // Revoke the previous preview URL whenever it is replaced, and on unmount.
  useEffect(() => {
    if (!logoUrl) return;
    return () => URL.revokeObjectURL(logoUrl);
  }, [logoUrl]);

  const acceptLogo = (file: File | null): void => {
    setLogo(file);
    setLogoFile(file);
    if (file) {
      setLogoUrl(URL.createObjectURL(file));
      // Auto-switch to logo mode on upload (PRD: "ya image/logo").
      onChange(WM_IDS.type, "image");
    } else {
      setLogoUrl(null);
    }
  };

  const pickSwatch = (color: string): void => {
    setHexDraft(color);
    onChange(WM_IDS.color, color);
  };

  const applyHexDraft = (): void => {
    const parsed = parseHexColor(hexDraft);
    if (parsed) {
      const normalized = hexDraft.trim().replace(/^#/, "").toUpperCase();
      onChange(WM_IDS.color, `#${normalized}`);
    } else {
      setHexDraft(wm.color); // snap back to the current valid value
    }
  };

  const missingMark =
    wm.type === "text"
      ? wm.text.trim().length === 0
      : logo === null;

  return (
    <div className="flex flex-col gap-5">
      {/* Text | Logo mode toggle */}
      <div
        role="tablist"
        aria-label={t("wm.designTitle")}
        className="grid grid-cols-2 gap-1 rounded-btn bg-muted p-1"
      >
        {(
          [
            { id: "text", label: t("wm.typeText"), icon: <Type className="size-3.5" /> },
            { id: "image", label: t("wm.typeLogo"), icon: <ImagePlus className="size-3.5" /> },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={wm.type === tab.id}
            onClick={() => onChange(WM_IDS.type, tab.id)}
            className={cn(
              "flex min-h-10 items-center justify-center gap-1.5 rounded-[10px] px-2 py-2 text-xs font-semibold transition-colors",
              wm.type === tab.id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <span aria-hidden="true">{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {missingMark ? (
        <div className="flex items-start gap-2.5 rounded-card border border-amber-300/60 bg-amber-50 px-3 py-2.5 dark:border-amber-500/30 dark:bg-amber-950/40">
          <TriangleAlert
            className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden="true"
          />
          <p className="text-xs leading-relaxed text-amber-900 dark:text-amber-200">
            {wm.type === "text" ? t("wm.textMissing") : t("wm.logoMissing")}
          </p>
        </div>
      ) : null}

      {/* Stamp design */}
      {wm.type === "text" ? (
        <div className="flex flex-col gap-4">
          <SectionTitle icon={<Droplets className="size-3.5" />} label={t("wm.stampTitle")} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${inputId}-text`} className="text-sm font-medium">
              {t("wm.textLabel")}
            </Label>
            <Input
              id={`${inputId}-text`}
              type="text"
              maxLength={120}
              autoComplete="off"
              placeholder={t("wm.textPlaceholder")}
              value={wm.text}
              onChange={(event) => onChange(WM_IDS.text, event.target.value)}
              className="h-11 rounded-btn font-medium"
            />
            <div className="flex items-center justify-between">
              <p className="text-[11px] text-muted-foreground">{t("wm.textHint")}</p>
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {wm.text.length}/120
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${inputId}-font`} className="text-sm font-medium">
              {t("wm.font")}
            </Label>
            <Select
              value={wm.font}
              onValueChange={(next) => onChange(WM_IDS.font, next)}
            >
              <SelectTrigger id={`${inputId}-font`} className="h-11 w-full rounded-btn">
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
          </div>

          <SliderRow
            id={`${inputId}-size`}
            label={t("wm.size")}
            value={wm.size}
            min={8}
            max={144}
            step={1}
            format={(v) => `${v} pt`}
            onChange={(next) => onChange(WM_IDS.size, next)}
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
                  aria-pressed={wm.color === color}
                  className={cn(
                    "flex h-8 w-full items-center justify-center rounded-md border transition-all",
                    wm.color === color
                      ? "border-primary ring-2 ring-primary/40 scale-105"
                      : "border-border hover:scale-105"
                  )}
                  style={{ backgroundColor: color }}
                >
                  {wm.color === color ? (
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
                placeholder="DC2626"
                className="h-9 rounded-btn font-mono text-xs uppercase"
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <SectionTitle icon={<ImagePlus className="size-3.5" />} label={t("wm.stampTitle")} />
          <input
            ref={logoInputRef}
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              acceptLogo(file);
              event.target.value = "";
            }}
            aria-label={t("wm.logoUpload")}
          />
          {logo && logoUrl ? (
            <div className="flex items-center gap-3 rounded-card border border-border bg-muted/40 p-2.5">
              <img
                src={logoUrl}
                alt=""
                className="size-11 rounded-md border border-border bg-checker object-contain p-0.5"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-foreground">
                  {logo.name}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {(logo.size / 1024).toFixed(0)} KB
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 shrink-0"
                onClick={() => acceptLogo(null)}
                aria-label={t("wm.logoRemove")}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => logoInputRef.current?.click()}
              className="flex min-h-20 w-full flex-col items-center justify-center gap-1.5 rounded-card border-2 border-dashed border-border bg-muted/30 px-4 py-4 text-center transition-colors hover:border-primary/40 hover:bg-primary/5"
            >
              <ImagePlus
                className="size-5 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="text-xs font-semibold text-foreground">
                {t("wm.logoUpload")}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {t("wm.logoHint")}
              </span>
            </button>
          )}
          <SliderRow
            id={`${inputId}-logo-scale`}
            label={t("wm.logoScale")}
            value={wm.logoScale}
            min={10}
            max={100}
            step={1}
            format={(v) => `${v}%`}
            onChange={(next) => onChange(WM_IDS.logoScale, next)}
          />
        </div>
      )}

      {/* Placement — shared by text + logo */}
      <div className="flex flex-col gap-4 border-t border-border pt-4">
        <SectionTitle icon={<Layers className="size-3.5" />} label={t("wm.placementTitle")} />

        <SliderRow
          id={`${inputId}-opacity`}
          label={t("wm.opacity")}
          value={Math.round(wm.opacity * 100)}
          min={5}
          max={100}
          step={1}
          format={(v) => `${v}%`}
          onChange={(next) => onChange(WM_IDS.opacity, next / 100)}
        />

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={`${inputId}-rotation`} className="text-sm font-medium">
              {t("wm.rotation")}
            </Label>
            <span className="flex items-center gap-1 rounded-chip bg-primary/10 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-primary">
              <RotateCw className="size-3" aria-hidden="true" />
              {wm.rotation}°
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {[-90, -45, 0, 45, 90].map((angle) => (
              <button
                key={angle}
                type="button"
                onClick={() => onChange(WM_IDS.rotation, angle)}
                aria-pressed={wm.rotation === angle}
                className={cn(
                  "h-8 flex-1 rounded-md border text-[10px] font-semibold tabular-nums transition-colors",
                  wm.rotation === angle
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
            value={[wm.rotation]}
            min={-90}
            max={90}
            step={5}
            onValueChange={(next) => onChange(WM_IDS.rotation, next[0] ?? wm.rotation)}
            className="py-1.5"
            aria-label={t("wm.rotation")}
          />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-sm font-medium">{t("wm.position")}</Label>
            {wm.tile ? (
              <span className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
                <SquareDashed className="size-3" aria-hidden="true" />
                {t("wm.positionTiled")}
              </span>
            ) : null}
          </div>
          <div
            role="group"
            aria-label={t("wm.position")}
            className="grid w-fit grid-cols-3 gap-1 rounded-btn border border-border bg-muted/40 p-1.5"
          >
            {WM_POSITIONS.map((position) => (
              <button
                key={position}
                type="button"
                disabled={wm.tile}
                onClick={() => onChange(WM_IDS.position, position)}
                aria-label={t(POSITION_LABEL_KEYS[position])}
                aria-pressed={wm.position === position}
                className={cn(
                  "size-8 rounded-md border transition-all",
                  wm.tile
                    ? "cursor-not-allowed border-border/50 opacity-40"
                    : "border-transparent hover:border-border",
                  !wm.tile && wm.position === position
                    ? "border-primary bg-primary/15 shadow-sm"
                    : "bg-background/60"
                )}
              >
                <span
                  className={cn(
                    "mx-auto block size-1.5 rounded-full transition-colors",
                    !wm.tile && wm.position === position
                      ? "bg-primary"
                      : "bg-muted-foreground/50"
                  )}
                />
              </button>
            ))}
          </div>
          {!wm.tile ? (
            <SliderRow
              id={`${inputId}-margin`}
              label={t("wm.margin")}
              value={wm.margin}
              min={12}
              max={96}
              step={2}
              format={(v) => `${v} pt`}
              onChange={(next) => onChange(WM_IDS.margin, next)}
            />
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <Label htmlFor={`${inputId}-tile`} className="text-sm font-medium">
              {t("wm.tile")}
            </Label>
            <p className="text-[11px] text-muted-foreground">{t("wm.tileHint")}</p>
          </div>
          <Switch
            id={`${inputId}-tile`}
            checked={wm.tile}
            onCheckedChange={(next) => onChange(WM_IDS.tile, next)}
            aria-label={t("wm.tile")}
          />
        </div>
        {wm.tile ? (
          <SliderRow
            id={`${inputId}-tile-gap`}
            label={t("wm.gap")}
            value={wm.tileGap}
            min={0.25}
            max={3}
            step={0.25}
            format={(v) => `×${v}`}
            onChange={(next) => onChange(WM_IDS.tileGap, next)}
          />
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <Label htmlFor={`${inputId}-behind`} className="text-sm font-medium">
              {t("wm.behind")}
            </Label>
            <p className="text-[11px] text-muted-foreground">{t("wm.behindHint")}</p>
          </div>
          <Switch
            id={`${inputId}-behind`}
            checked={wm.behind}
            onCheckedChange={(next) => onChange(WM_IDS.behind, next)}
            aria-label={t("wm.behind")}
          />
        </div>
      </div>

      {/* Page targeting */}
      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <SectionTitle icon={<Layers className="size-3.5" />} label={t("wm.pagesTitle")} />
        <Select
          value={wm.layout}
          onValueChange={(next) => onChange(WM_IDS.layout, next)}
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
        {wm.layout === "range" ? (
          <Input
            id={`${inputId}-pages`}
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder={t("tool.pagesPlaceholder")}
            value={wm.pages}
            onChange={(event) => onChange(WM_IDS.pages, event.target.value)}
            className="h-11 rounded-btn font-medium"
            aria-label={t("wm.layoutRange")}
          />
        ) : null}
        <p className="text-[11px] text-muted-foreground">
          {wm.layout === "range" && wm.pages.trim() !== "" && wm.pages.trim() !== "all"
            ? t("wm.rangeHint")
            : t("wm.markedAll")}
        </p>
      </div>
    </div>
  );
}
