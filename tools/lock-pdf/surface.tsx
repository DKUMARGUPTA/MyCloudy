"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Eye,
  EyeOff,
  FileText,
  Lock,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  TriangleAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/components/providers/locale-provider";
import { getPdfPageCount } from "@/lib/pdf/thumbnails";
import { cn } from "@/lib/utils";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { PreviewFileHeader } from "../stamp-common/preview-parts";
import {
  LOCK_IDS,
  estimateTypedBits,
} from "../lock-common/security";
import {
  classifyStrength,
  generateRandom,
} from "../generate-password/engine";

/**
 * Lock PDF surface (PRD §8.4): the password cockpit. Open password with
 * live strength meter + show/hide + one-tap generate (reusing the
 * generate-password engine), confirm field, owner password, the six
 * permission switches and the AES-256/AES-128 choice. The sticky CTA
 * stays disabled (with the honest reason) until the passwords validate.
 * All values live in the shared options state — Start over wipes them.
 */

const STRENGTH_STYLES: { bar: string; label: string }[] = [
  { bar: "bg-red-500", label: "text-red-600 dark:text-red-400" },
  { bar: "bg-orange-500", label: "text-orange-600 dark:text-orange-400" },
  { bar: "bg-amber-500", label: "text-amber-600 dark:text-amber-400" },
  { bar: "bg-lime-500", label: "text-lime-600 dark:text-lime-400" },
  { bar: "bg-emerald-500", label: "text-emerald-600 dark:text-emerald-400" },
];

const STRENGTH_KEYS = [
  "gp.strength0",
  "gp.strength1",
  "gp.strength2",
  "gp.strength3",
  "gp.strength4",
];

/** One generate-roll candidate (re-rolled per click). */
const GEN_LENGTH = 16;

export function LockSurface({
  files,
  values,
  onChange,
  setFileOrder,
  setRunBlocked,
}: ToolSurfaceProps): React.JSX.Element | null {
  const { t } = useI18n();
  const fileMeta = files[0];
  const file = fileMeta?.file ?? null;

  const [pageCount, setPageCount] = useState(0);
  const [showPw, setShowPw] = useState(false);
  const [showOwner, setShowOwner] = useState(false);
  const [suggestion, setSuggestion] = useState<string | null>(null);

  // Page census for the file card (cached pdf.js read).
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void getPdfPageCount(file)
      .then((count) => {
        if (!cancelled) setPageCount(count);
      })
      .catch(() => {
        if (!cancelled) setPageCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const userPw = typeof values[LOCK_IDS.userPw] === "string" ? String(values[LOCK_IDS.userPw]) : "";
  const ownerPw = typeof values[LOCK_IDS.ownerPw] === "string" ? String(values[LOCK_IDS.ownerPw]) : "";
  const alg = values[LOCK_IDS.alg] === "aes128" ? "aes128" : "aes256";
  const perm = useCallback(
    (id: string, fallback: boolean): boolean => {
      const v = values[id];
      return typeof v === "boolean" ? v : fallback;
    },
    [values]
  );

  const bits = useMemo(() => estimateTypedBits(userPw), [userPw]);
  const level = userPw ? classifyStrength(bits) : 0;
  const strength = STRENGTH_STYLES[level];
  const tooShort = userPw.length > 0 && userPw.length < 6;
  const good = userPw.length >= 6;

  // CTA gating: min 6 chars (PRD validation).
  useEffect(() => {
    setRunBlocked(userPw.length < 6 ? "lock.pwTooShort" : null);
    return () => setRunBlocked(null);
  }, [setRunBlocked, userPw.length]);

  const applySuggestion = useCallback(() => {
    const generated = generateRandom({
      length: GEN_LENGTH,
      uppercase: true,
      lowercase: true,
      digits: true,
      symbols: true,
      avoidAmbiguous: true,
    }).password;
    setSuggestion(generated);
  }, []);

  const useSuggestion = useCallback(() => {
    onChange(LOCK_IDS.userPw, suggestion ?? "");
    setSuggestion(null);
    setShowPw(true);
  }, [onChange, suggestion]);

  if (!file) return null;

  return (
    <div className="flex flex-col gap-5">
      <PreviewFileHeader
        file={file}
        pageCount={pageCount}
        onRemove={() => setFileOrder([])}
      />

      <div className="flex flex-col gap-5 rounded-card border border-border bg-card p-5 sm:p-6">
        <header className="flex flex-wrap items-center gap-3">
          <span
            className="flex size-10 items-center justify-center rounded-btn bg-cat-security/10 text-cat-security"
            aria-hidden="true"
          >
            <Lock className="size-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground">
              {t("lock.formTitle")}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t("lock.formSubtitle")}
            </p>
          </div>
        </header>

        {/* Open password */}
        <div className="flex flex-col gap-2.5">
          <label htmlFor="lock-userpw" className="text-sm font-medium text-foreground">
            {t("lock.openPw")}
          </label>
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Input
                id="lock-userpw"
                type={showPw ? "text" : "password"}
                value={userPw}
                onChange={(e) => onChange(LOCK_IDS.userPw, e.target.value)}
                autoComplete="new-password"
                placeholder={t("lock.pwPlaceholder")}
                className="pr-11 font-mono"
                aria-invalid={tooShort || undefined}
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                aria-label={showPw ? t("gp.hide") : t("gp.show")}
                className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
              >
                {showPw ? (
                  <EyeOff className="size-4" aria-hidden="true" />
                ) : (
                  <Eye className="size-4" aria-hidden="true" />
                )}
              </button>
            </div>
            <Button
              type="button"
              variant="outline"
              className="rounded-btn shrink-0"
              onClick={applySuggestion}
              title={t("lock.genHint")}
            >
              <Sparkles className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">{t("lock.generate")}</span>
            </Button>
          </div>

          {/* Generated suggestion card */}
          {suggestion ? (
            <div className="flex flex-wrap items-center gap-2 rounded-btn border border-primary/30 bg-primary/5 px-3 py-2.5">
              <code className="min-w-0 flex-1 break-all font-mono text-sm font-semibold text-foreground">
                {suggestion}
              </code>
              <span className="text-[11px] text-muted-foreground">
                {t("gp.entropy", { bits: estimateTypedBits(suggestion) })}
              </span>
              <Button
                type="button"
                size="sm"
                className="rounded-btn"
                onClick={useSuggestion}
              >
                {t("lock.useThis")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="rounded-btn"
                onClick={applySuggestion}
                aria-label={t("gp.regenerate")}
              >
                <RefreshCw className="size-3.5" aria-hidden="true" />
              </Button>
            </div>
          ) : null}

          {/* Strength meter */}
          {userPw ? (
            <div
              className="flex flex-col gap-1.5"
              aria-label={t("gp.strengthLabel")}
            >
              <div className="flex items-center justify-between">
                <span className={cn("text-xs font-semibold", strength.label)}>
                  {t(STRENGTH_KEYS[level])}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {t("gp.entropy", { bits })}
                </span>
              </div>
              <div className="flex gap-1.5" role="meter" aria-valuemin={0} aria-valuemax={4} aria-valuenow={level}>
                {[0, 1, 2, 3, 4].map((i) => (
                  <span
                    key={i}
                    className={cn(
                      "h-1.5 flex-1 rounded-full",
                      i <= level ? strength.bar : "bg-border"
                    )}
                  />
                ))}
              </div>
            </div>
          ) : null}

          {/* Confirm field */}
          <label htmlFor="lock-confirmpw" className="mt-1 text-sm font-medium text-foreground">
            {t("lock.confirmPw")}
          </label>
          <Input
            id="lock-confirmpw"
            type={showPw ? "text" : "password"}
            autoComplete="new-password"
            placeholder={t("lock.pwPlaceholder")}
            className="font-mono"
            onChange={(e) => {
              const el = e.target as HTMLInputElement;
              el.setCustomValidity(
                el.value !== userPw ? t("lock.mismatch") : ""
              );
              el.reportValidity();
            }}
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("lock.pwRules")}
          </p>
          <p className="flex items-start gap-1.5 rounded-btn border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-800 dark:text-amber-300">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {t("lock.recoverWarn")}
          </p>
        </div>

        {/* Owner password */}
        <div className="flex flex-col gap-2.5 border-t border-border pt-5">
          <label htmlFor="lock-ownerpw" className="text-sm font-medium text-foreground">
            {t("lock.ownerPw")}
            <span className="ml-1.5 font-normal text-muted-foreground">
              {t("lock.optional")}
            </span>
          </label>
          <div className="relative">
            <Input
              id="lock-ownerpw"
              type={showOwner ? "text" : "password"}
              value={ownerPw}
              onChange={(e) => onChange(LOCK_IDS.ownerPw, e.target.value)}
              autoComplete="new-password"
              placeholder={t("lock.ownerPlaceholder")}
              className="pr-11 font-mono"
            />
            <button
              type="button"
              onClick={() => setShowOwner((v) => !v)}
              aria-label={showOwner ? t("gp.hide") : t("gp.show")}
              className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
            >
              {showOwner ? (
                <EyeOff className="size-4" aria-hidden="true" />
              ) : (
                <Eye className="size-4" aria-hidden="true" />
              )}
            </button>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("lock.ownerHint")}
          </p>
        </div>

        {/* Permissions */}
        <fieldset className="flex flex-col gap-2.5 border-t border-border pt-5">
          <legend className="text-sm font-semibold text-foreground">
            {t("lock.permsTitle")}
          </legend>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("lock.permsHint")}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                [LOCK_IDS.print, "lock.permPrint", true],
                [LOCK_IDS.copy, "lock.permCopy", false],
                [LOCK_IDS.modify, "lock.permModify", false],
                [LOCK_IDS.annotate, "lock.permAnnotate", true],
                [LOCK_IDS.forms, "lock.permForms", true],
                [LOCK_IDS.access, "lock.permAccess", true],
              ] as const
            ).map(([id, labelKey, fallback]) => {
              const on = perm(id, fallback);
              return (
                <label
                  key={id}
                  className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-btn border border-border bg-background px-3.5 py-2.5"
                >
                  <span className="text-xs font-medium text-foreground sm:text-sm">
                    {t(labelKey)}
                  </span>
                  <Switch
                    checked={on}
                    onCheckedChange={(v) => onChange(id, v)}
                    aria-label={t(labelKey)}
                  />
                </label>
              );
            })}
          </div>
        </fieldset>

        {/* Algorithm */}
        <fieldset className="flex flex-col gap-2.5 border-t border-border pt-5">
          <legend className="text-sm font-semibold text-foreground">
            {t("lock.algTitle")}
          </legend>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["aes256", "lock.alg256", "lock.alg256Hint"],
                ["aes128", "lock.alg128", "lock.alg128Hint"],
              ] as const
            ).map(([value, labelKey, hintKey]) => (
              <button
                key={value}
                type="button"
                aria-pressed={alg === value}
                onClick={() => onChange(LOCK_IDS.alg, value)}
                className={cn(
                  "flex min-h-14 flex-col items-start justify-center gap-0.5 rounded-btn border px-3.5 py-2 text-left outline-none transition-colors",
                  "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  alg === value
                    ? "border-primary/50 bg-primary/10"
                    : "border-border bg-background hover:border-primary/30"
                )}
              >
                <span className="text-xs font-semibold text-foreground sm:text-sm">
                  {t(labelKey)}
                </span>
                <span className="text-[11px] leading-tight text-muted-foreground">
                  {t(hintKey)}
                </span>
              </button>
            ))}
          </div>
        </fieldset>

        {/* Summary line */}
        <p className="flex items-start gap-2 border-t border-border pt-4 text-[11px] leading-relaxed text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
          {t("lock.privacyLine")}
        </p>
      </div>
    </div>
  );
}
