"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  History,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/components/providers/locale-provider";
import { trackToolUse } from "@/lib/tools/favorites";
import { cn } from "@/lib/utils";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import {
  classifyStrength,
  crackBucket,
  crackCount,
  generatePassphrase,
  generatePronounceable,
  generateRandom,
  passwordStats,
  randomOptsValid,
  type GenMode,
  type GeneratedPassword,
  type PassphraseOptions,
  type RandomOptions,
} from "./engine";

/**
 * Generate Password surface (PRD §8.4): the tool IS this card. No file, no
 * worker, no run step — Web Crypto draws every character on the main
 * thread (cheap: ≤64 chars) and nothing ever leaves the component.
 *
 * The shell renders this surface directly on the landing page (config
 * `noFile: true`): mode tabs, the big reveal-able value, copy with toast +
 * fallback, honest strength (entropy from the choices actually made + a
 * 10^10 guesses/sec offline-attack crack estimate), and a session-only
 * history that dies with the page.
 */

const STRENGTH_STYLES: { bar: string; label: string }[] = [
  { bar: "bg-red-500", label: "text-red-600 dark:text-red-400" },
  { bar: "bg-orange-500", label: "text-orange-600 dark:text-orange-400" },
  { bar: "bg-amber-500", label: "text-amber-600 dark:text-amber-400" },
  { bar: "bg-lime-500", label: "text-lime-600 dark:text-lime-400" },
  { bar: "bg-emerald-500", label: "text-emerald-600 dark:text-emerald-400" },
];

const STRENGTH_LABEL_KEYS = [
  "gp.strength0",
  "gp.strength1",
  "gp.strength2",
  "gp.strength3",
  "gp.strength4",
];

const HISTORY_MAX = 6;

/** Everything the generator needs, in one serializable object. */
interface AllOpts {
  mode: GenMode;
  random: RandomOptions;
  pronLength: number;
  phrase: PassphraseOptions;
}

const INITIAL_OPTS: AllOpts = {
  mode: "random",
  random: {
    length: 16,
    uppercase: true,
    lowercase: true,
    digits: true,
    symbols: true,
    avoidAmbiguous: false,
  },
  pronLength: 12,
  phrase: {
    words: 4,
    language: "en",
    separator: "-",
    capitalize: false,
    addNumber: false,
  },
};

/** Pure dispatcher: generate for whatever the options say right now. */
function generateFrom(opts: AllOpts): GeneratedPassword | null {
  if (opts.mode === "random") {
    if (!randomOptsValid(opts.random)) return null;
    return generateRandom(opts.random);
  }
  if (opts.mode === "pronounceable") {
    return generatePronounceable(opts.pronLength);
  }
  return generatePassphrase(opts.phrase);
}

export function PasswordSurface(_props: ToolSurfaceProps): React.JSX.Element {
  const { t } = useI18n();
  const { toast } = useToast();

  // ------------------------------------------------------------------
  // State — ONE options object + the generated value. Every option
  // change regenerates from its own event handler (never from an effect:
  // the react-hooks/set-state-in-effect rule holds), so the displayed
  // value can never be stale for the options shown.
  // ------------------------------------------------------------------
  const [opts, setOpts] = useState<AllOpts>(INITIAL_OPTS);
  const [current, setCurrent] = useState<GeneratedPassword | null>(() =>
    generateFrom(INITIAL_OPTS)
  );
  const [reveal, setReveal] = useState(true);
  const [copied, setCopied] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const trackedRef = useRef(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const trackOnce = useCallback(() => {
    if (trackedRef.current) return;
    trackedRef.current = true;
    trackToolUse("generate-password");
  }, []);

  /** Apply an options change and regenerate in the same event. */
  const applyOpts = useCallback(
    (next: AllOpts) => {
      setOpts(next);
      setCurrent(generateFrom(next));
      setCopied(false);
      trackOnce();
    },
    [trackOnce]
  );

  const patchRandom = (patch: Partial<RandomOptions>) =>
    applyOpts({ ...opts, random: { ...opts.random, ...patch } });
  const patchPhrase = (patch: Partial<PassphraseOptions>) =>
    applyOpts({ ...opts, phrase: { ...opts.phrase, ...patch } });

  const { mode, random: randomOpts, phrase: phraseOpts } = opts;
  const pronLength = opts.pronLength;

  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    []
  );

  const pushHistory = useCallback((value: string) => {
    setHistory((prev) => {
      if (prev[0] === value) return prev;
      return [value, ...prev].slice(0, HISTORY_MAX);
    });
  }, []);

  /** Regenerate + archive the outgoing value into the session history. */
  const handleRegenerate = useCallback(() => {
    if (current) pushHistory(current.password);
    setCurrent(generateFrom(opts));
    setCopied(false);
    trackOnce();
  }, [current, opts, pushHistory, trackOnce]);

  // ------------------------------------------------------------------
  // Copy (clipboard API, timeout-raced, with execCommand fallback)
  // Some embedded browsers leave writeText() pending forever (no
  // permission event fires) — racing it guarantees the user ALWAYS gets
  // feedback instead of a silently dead button.
  // ------------------------------------------------------------------
  const copyText = useCallback(
    async (value: string) => {
      let ok = false;
      try {
        ok = await Promise.race([
          navigator.clipboard.writeText(value).then(
            () => true,
            () => false
          ),
          new Promise<false>((resolve) => {
            setTimeout(() => resolve(false), 800);
          }),
        ]);
      } catch {
        ok = false;
      }
      if (!ok) {
        try {
          const area = document.createElement("textarea");
          area.value = value;
          area.setAttribute("readonly", "");
          area.style.position = "fixed";
          area.style.opacity = "0";
          document.body.appendChild(area);
          area.select();
          ok = document.execCommand("copy");
          document.body.removeChild(area);
        } catch {
          ok = false;
        }
      }
      if (ok) {
        setCopied(true);
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
        toast({ title: t("gp.copiedToast") });
      } else {
        toast({ title: t("gp.copyFailed"), variant: "destructive" });
      }
    },
    [t, toast]
  );

  // ------------------------------------------------------------------
  // Strength + crack time (honest copy, no fear-mongering)
  // ------------------------------------------------------------------
  const level = current ? classifyStrength(current.bits) : 0;
  const strength = STRENGTH_STYLES[level];
  const stats = useMemo(() => {
    if (!current) return null;
    const sep = mode === "passphrase" && phraseOpts.separator !== "none" ? phraseOpts.separator : "-";
    return passwordStats(current.password, sep);
  }, [current, mode, phraseOpts.separator]);

  const crackLine = useMemo(() => {
    if (!current) return "";
    return t(`gp.crack.${crackBucket(current.bits)}`, {
      count: crackCount(current.bits),
    });
  }, [current, t]);

  const setCount =
    (randomOpts.uppercase ? 1 : 0) +
    (randomOpts.lowercase ? 1 : 0) +
    (randomOpts.digits ? 1 : 0) +
    (randomOpts.symbols ? 1 : 0);

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  return (
    <section
      aria-labelledby="gp-heading"
      className="rounded-card border border-border bg-card shadow-sm"
    >
      {/* Card header */}
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4 sm:px-6">
        <span
          className="flex size-10 items-center justify-center rounded-btn bg-cat-security/10 text-cat-security"
          aria-hidden="true"
        >
          <KeyRound className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 id="gp-heading" className="text-base font-semibold text-foreground">
            {t("gp.surfaceTitle")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("gp.surfaceSubtitle")}</p>
        </div>
        <span className="ml-auto hidden items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 sm:inline-flex">
          <ShieldCheck className="size-3.5" aria-hidden="true" />
          {t("gp.onDeviceBadge")}
        </span>
      </header>

      <div className="flex flex-col gap-6 px-5 py-5 sm:px-6">
        {/* Output display */}
        <div className="flex flex-col gap-3">
          <div
            className="relative flex min-h-28 items-center overflow-hidden rounded-btn border border-border bg-muted/40 px-4 py-4"
            role="group"
            aria-label={t("gp.outputLabel")}
          >
            <output
              aria-live="polite"
              className={cn(
                "min-w-0 flex-1 break-all font-mono text-lg leading-relaxed text-foreground sm:text-xl",
                "select-all",
                !reveal && "tracking-widest"
              )}
            >
              {current
                ? reveal
                  ? current.password
                  : "•".repeat(Math.min(current.password.length, 64))
                : ""}
            </output>
          </div>

          {/* Action row */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="touch"
              className="rounded-btn font-semibold"
              onClick={() => current && copyText(current.password)}
              disabled={!current}
            >
              {copied ? (
                <Check className="size-4" aria-hidden="true" />
              ) : (
                <Copy className="size-4" aria-hidden="true" />
              )}
              {copied ? t("gp.copied") : t("gp.copy")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="touch"
              className="rounded-btn"
              onClick={handleRegenerate}
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              {t("gp.regenerate")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="touch"
              className="rounded-btn"
              onClick={() => setReveal((v) => !v)}
              aria-pressed={reveal}
            >
              {reveal ? (
                <EyeOff className="size-4" aria-hidden="true" />
              ) : (
                <Eye className="size-4" aria-hidden="true" />
              )}
              {reveal ? t("gp.hide") : t("gp.show")}
            </Button>
          </div>

          {/* Strength meter */}
          {current ? (
            <div
              className="flex flex-col gap-2 rounded-btn border border-border bg-background px-4 py-3"
              aria-label={t("gp.strengthLabel")}
            >
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className={cn("text-sm font-semibold", strength.label)}>
                  {t(STRENGTH_LABEL_KEYS[level])}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("gp.entropy", { bits: Math.round(current.bits) })}
                </span>
              </div>
              <div
                className="flex gap-1.5"
                role="meter"
                aria-valuemin={0}
                aria-valuemax={4}
                aria-valuenow={level}
                aria-valuetext={t(STRENGTH_LABEL_KEYS[level])}
              >
                {[0, 1, 2, 3, 4].map((i) => (
                  <span
                    key={i}
                    className={cn(
                      "h-1.5 flex-1 rounded-full transition-colors",
                      i <= level ? strength.bar : "bg-border"
                    )}
                  />
                ))}
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t("gp.crackPrefix")} {crackLine}
              </p>
            </div>
          ) : null}
        </div>

        {/* Mode tabs */}
        <div
          role="tablist"
          aria-label={t("gp.modeLabel")}
          className="grid grid-cols-3 gap-1.5 rounded-btn bg-muted/60 p-1.5"
        >
          {(
            [
              ["random", "gp.modeRandom"],
              ["pronounceable", "gp.modePronounce"],
              ["passphrase", "gp.modePassphrase"],
            ] as const
          ).map(([value, labelKey]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              onClick={() => applyOpts({ ...opts, mode: value })}
              className={cn(
                "min-h-11 rounded-[calc(var(--radius-btn)-2px)] px-3 text-xs font-semibold outline-none transition-colors sm:text-sm",
                "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                mode === value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>

        {/* Mode controls */}
        {mode === "random" ? (
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <label htmlFor="gp-length" className="text-sm font-medium text-foreground">
                  {t("gp.length")}
                </label>
                <span className="rounded-chip bg-primary/10 px-2 py-0.5 font-mono text-sm font-bold text-primary">
                  {randomOpts.length}
                </span>
              </div>
              <Slider
                id="gp-length"
                value={[randomOpts.length]}
                min={8}
                max={64}
                step={1}
                onValueChange={(v) => patchRandom({ length: v[0] ?? opts.random.length })}
                aria-label={t("gp.length")}
              />
            </div>

            <fieldset className="flex flex-col gap-2.5">
              <legend className="text-sm font-medium text-foreground">
                {t("gp.charsets")}
              </legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {(
                  [
                    ["uppercase", "ABC", "gp.setUpper"],
                    ["lowercase", "abc", "gp.setLower"],
                    ["digits", "123", "gp.setDigits"],
                    ["symbols", "#$&", "gp.setSymbols"],
                  ] as const
                ).map(([key, sample, labelKey]) => {
                  const on = randomOpts[key];
                  const wouldBeLast = on && setCount === 1;
                  return (
                    <button
                      key={key}
                      type="button"
                      role="switch"
                      aria-checked={on}
                      disabled={wouldBeLast}
                      onClick={() => patchRandom({ [key]: !opts.random[key] })}
                      className={cn(
                        "flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-btn border px-2 py-2 text-center outline-none transition-colors",
                        "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                        on
                          ? "border-primary/50 bg-primary/10 text-foreground"
                          : "border-border bg-background text-muted-foreground hover:border-primary/30",
                        wouldBeLast && "cursor-not-allowed opacity-70"
                      )}
                      title={wouldBeLast ? t("gp.needOneSet") : undefined}
                    >
                      <span className="font-mono text-sm font-bold tracking-wide">{sample}</span>
                      <span className="text-[11px] font-medium">{t(labelKey)}</span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-btn border border-border bg-background px-4 py-3">
              <span className="flex flex-col">
                <span className="text-sm font-medium text-foreground">
                  {t("gp.avoidAmbiguous")}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {t("gp.avoidAmbiguousHint")}
                </span>
              </span>
              <Switch
                checked={randomOpts.avoidAmbiguous}
                onCheckedChange={(v) => patchRandom({ avoidAmbiguous: v })}
                aria-label={t("gp.avoidAmbiguous")}
              />
            </label>
          </div>
        ) : null}

        {mode === "pronounceable" ? (
          <div className="flex flex-col gap-5">
            <p className="rounded-btn border border-border bg-muted/40 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
              {t("gp.pronHint")}
            </p>
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <label htmlFor="gp-plen" className="text-sm font-medium text-foreground">
                  {t("gp.length")}
                </label>
                <span className="rounded-chip bg-primary/10 px-2 py-0.5 font-mono text-sm font-bold text-primary">
                  {pronLength}
                </span>
              </div>
              <Slider
                id="gp-plen"
                value={[pronLength]}
                min={8}
                max={64}
                step={1}
                onValueChange={(v) => applyOpts({ ...opts, pronLength: v[0] ?? opts.pronLength })}
                aria-label={t("gp.length")}
              />
            </div>
          </div>
        ) : null}

        {mode === "passphrase" ? (
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <label htmlFor="gp-words" className="text-sm font-medium text-foreground">
                  {t("gp.words")}
                </label>
                <span className="rounded-chip bg-primary/10 px-2 py-0.5 font-mono text-sm font-bold text-primary">
                  {phraseOpts.words}
                </span>
              </div>
              <Slider
                id="gp-words"
                value={[phraseOpts.words]}
                min={3}
                max={8}
                step={1}
                onValueChange={(v) => patchPhrase({ words: v[0] ?? opts.phrase.words })}
                aria-label={t("gp.words")}
              />
            </div>

            <fieldset className="flex flex-col gap-2.5">
              <legend className="text-sm font-medium text-foreground">
                {t("gp.language")}
              </legend>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    ["en", "gp.langEn"],
                    ["hi", "gp.langHi"],
                    ["both", "gp.langBoth"],
                  ] as const
                ).map(([value, labelKey]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={phraseOpts.language === value}
                    onClick={() => patchPhrase({ language: value })}
                    className={cn(
                      "min-h-11 rounded-btn border px-2 text-xs font-semibold outline-none transition-colors sm:text-sm",
                      "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      phraseOpts.language === value
                        ? "border-primary/50 bg-primary/10 text-foreground"
                        : "border-border bg-background text-muted-foreground hover:border-primary/30"
                    )}
                  >
                    {t(labelKey)}
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset className="flex flex-col gap-2.5">
              <legend className="text-sm font-medium text-foreground">
                {t("gp.separator")}
              </legend>
              <div className="grid grid-cols-5 gap-2">
                {(
                  [
                    ["-", "gp.sepDash"],
                    [".", "gp.sepDot"],
                    ["_", "gp.sepUnderscore"],
                    [" ", "gp.sepSpace"],
                    ["none", "gp.sepNone"],
                  ] as const
                ).map(([value, labelKey]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={phraseOpts.separator === value}
                    onClick={() => patchPhrase({ separator: value })}
                    className={cn(
                      "flex min-h-11 items-center justify-center rounded-btn border font-mono text-sm font-bold outline-none transition-colors",
                      "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      phraseOpts.separator === value
                        ? "border-primary/50 bg-primary/10 text-foreground"
                        : "border-border bg-background text-muted-foreground hover:border-primary/30"
                    )}
                    aria-label={t(labelKey)}
                  >
                    {value === "none" ? t("gp.sepNone") : value === " " ? "␣" : value}
                  </button>
                ))}
              </div>
            </fieldset>

            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex cursor-pointer items-center justify-between gap-3 rounded-btn border border-border bg-background px-4 py-3">
                <span className="text-sm font-medium text-foreground">
                  {t("gp.capitalize")}
                </span>
                <Switch
                  checked={phraseOpts.capitalize}
                  onCheckedChange={(v) => patchPhrase({ capitalize: v })}
                  aria-label={t("gp.capitalize")}
                />
              </label>
              <label className="flex cursor-pointer items-center justify-between gap-3 rounded-btn border border-border bg-background px-4 py-3">
                <span className="text-sm font-medium text-foreground">
                  {t("gp.addNumber")}
                </span>
                <Switch
                  checked={phraseOpts.addNumber}
                  onCheckedChange={(v) => patchPhrase({ addNumber: v })}
                  aria-label={t("gp.addNumber")}
                />
              </label>
            </div>
          </div>
        ) : null}

        {/* Checklist chips (live stats of the current value) */}
        {stats ? (
          <ul className="flex flex-wrap gap-2" aria-label={t("gp.checklistLabel")}>
            <li className="rounded-chip border border-border bg-background px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
              {mode === "passphrase"
                ? t("gp.statWords", { count: stats.wordCount })
                : t("gp.statChars", { count: stats.length })}
            </li>
            {stats.hasUpper ? (
              <li className="rounded-chip border border-primary/30 bg-primary/10 px-2.5 py-1 font-mono text-[11px] font-semibold text-primary">
                A–Z
              </li>
            ) : null}
            {stats.hasLower ? (
              <li className="rounded-chip border border-primary/30 bg-primary/10 px-2.5 py-1 font-mono text-[11px] font-semibold text-primary">
                a–z
              </li>
            ) : null}
            {stats.hasDigit ? (
              <li className="rounded-chip border border-primary/30 bg-primary/10 px-2.5 py-1 font-mono text-[11px] font-semibold text-primary">
                0–9
              </li>
            ) : null}
            {stats.hasSymbol ? (
              <li className="rounded-chip border border-primary/30 bg-primary/10 px-2.5 py-1 font-mono text-[11px] font-semibold text-primary">
                #?
              </li>
            ) : null}
          </ul>
        ) : null}

        {/* Session history */}
        {history.length > 0 ? (
          <section aria-labelledby="gp-history" className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between">
              <h3
                id="gp-history"
                className="flex items-center gap-1.5 text-sm font-semibold text-foreground"
              >
                <History className="size-4 text-muted-foreground" aria-hidden="true" />
                {t("gp.historyTitle")}
              </h3>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="rounded-btn text-muted-foreground"
                onClick={() => setHistory([])}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                {t("gp.historyClear")}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">{t("gp.historyHint")}</p>
            <ul className="flex flex-col gap-1.5">
              {history.map((value, index) => (
                <li
                  key={`${index}-${value.slice(0, 6)}`}
                  className="flex items-center gap-2 rounded-btn border border-border bg-background px-3 py-2"
                >
                  <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                    {value}
                  </code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="size-8 shrink-0 rounded-btn p-0"
                    onClick={() => copyText(value)}
                    aria-label={t("gp.copy")}
                  >
                    <Copy className="size-3.5" aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* Privacy line */}
        <p className="flex items-start gap-2 border-t border-border pt-4 text-[11px] leading-relaxed text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          {t("gp.privacyLine")}
        </p>
      </div>
    </section>
  );
}
