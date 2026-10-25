"use client";

/**
 * Webpage to PDF surface (RB4-f). URL → PDF with the honest privacy
 * split told up front.
 *
 * This tool accepts a URL, not a file — the registry def says
 * accepts: "url" — so there is no drop zone: the landing input is a
 * URL text field with validation (regex + strict protocol re-check via
 * the same url-guard the API route uses), which also gates the shell
 * CTA through setRunBlocked (the scan-pdf pattern: empty → "paste an
 * address", malformed → the honest fix-it hint).
 *
 * The Convert button spawns the worker, which fetches the page through
 * the same-origin pass-through pipe (/api/fetch-page — the pipe never
 * stores anything) and renders the PDF ON-DEVICE with the html-to-pdf
 * engine. Below it: an explainer card on why a server touches the HTML
 * at all, and the "already saved the page? use HTML to PDF" note.
 *
 * Mobile-safe: min-w-0 on every grid/text wrapper (the pinned
 * grid-blowout lesson). Everything is real DOM text — no canvas.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  FileDown,
  Globe,
  Info,
  Loader2,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { downloadBlob } from "@/lib/files/output";
import type { WorkerResponse } from "@/lib/workers/protocol";
import { cn } from "@/lib/utils";
import { urlShapeOk, validatePageUrl } from "./url-guard";

export function WebpageToPdfSurface({
  values,
  onChange,
  setRunBlocked,
}: ToolSurfaceProps): React.JSX.Element {
  const { t, locale } = useI18n();
  const { toast } = useToast();

  const [url, setUrl] = useState("");
  const [pct, setPct] = useState<number | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const inputId = useId();

  const trimmed = url.trim();

  /* ---------- the run gate: empty / malformed URL → blocked ---------- */
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      let reason: string | null = null;
      if (trimmed === "") {
        reason = "wpdf.ctaNeedUrl";
      } else if (!urlShapeOk(trimmed) || !validatePageUrl(trimmed).ok) {
        reason = "wpdf.ctaBadUrl";
      }
      setRunBlocked(reason);
    });
    return () => {
      cancelled = true;
    };
  }, [trimmed, setRunBlocked]);

  /* ---------- localized lang hint for the worker's name fallback ---------- */
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      onChange("lang", locale === "hi" ? "hi" : "en");
    });
    return () => {
      cancelled = true;
    };
  }, [locale, onChange]);

  const urlValid = trimmed !== "" && urlShapeOk(trimmed) && validatePageUrl(trimmed).ok;

  /* ---------- option values (the aside selects write the same keys) ---------- */
  const pageSize = String(values.pageSize ?? "a4") === "letter" ? "letter" : "a4";
  const margin = String(values.margin ?? "normal") === "narrow" ? "narrow" : "normal";
  const baseFontSizeRaw = String(values.baseFontSize ?? "normal");
  const baseFontSize =
    baseFontSizeRaw === "small" || baseFontSizeRaw === "large"
      ? baseFontSizeRaw
      : "normal";
  const showLinks = values.showLinks === true;

  /* ---------- keep the URL in the shared option state the worker reads ---------- */
  const handleUrlChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      const next = event.target.value.slice(0, 2048);
      setUrl(next);
      onChange("url", next);
    },
    [onChange]
  );

  /* ---------- Convert → worker spawn (create-invoice pattern) ---------- */
  const convert = useCallback((): void => {
    if (!urlValid || workerRef.current) return;
    setPct(0);
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    const runId = Date.now();
    const cleanup = (): void => {
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };
    worker.addEventListener(
      "message",
      (event: MessageEvent<WorkerResponse>) => {
        const data = event.data;
        if (!data || data.runId !== runId) return;
        if (data.type === "progress") {
          setPct(data.pct);
          return;
        }
        if (data.type === "result") {
          setPct(null);
          const output = data.outputs[0];
          if (output) {
            downloadBlob(output.blob, output.name);
            toast({
              title: t("wpdf.doneTitle"),
              description: t("wpdf.doneDesc", {
                name: output.name,
                pages: data.detail?.pages ?? 1,
              }),
            });
          }
          cleanup();
          return;
        }
        if (data.type === "error") {
          setPct(null);
          toast({
            title: t("tool.errorTitle"),
            description: data.code.startsWith("wpdf.")
              ? t(data.code)
              : t("tool.errorGeneric", { detail: "" }),
            variant: "destructive",
          });
          cleanup();
        }
      }
    );
    worker.addEventListener("error", () => {
      setPct(null);
      toast({
        title: t("tool.errorTitle"),
        description: t("tool.errorGeneric", { detail: "" }),
        variant: "destructive",
      });
      cleanup();
    });
    worker.postMessage({
      type: "run",
      runId,
      toolId: "webpage-to-pdf",
      options: {
        url: trimmed,
        pageSize,
        margin,
        baseFontSize,
        showLinks,
        lang: locale === "hi" ? "hi" : "en",
      },
      files: [],
    });
  }, [
    baseFontSize,
    locale,
    margin,
    pageSize,
    showLinks,
    t,
    toast,
    trimmed,
    urlValid,
  ]);

  // Kill a stuck worker if the surface unmounts mid-run.
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
    };
  }, []);

  const fetching = pct !== null;

  /* ---------------------------------------------------------------- */

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      {/* ---------------- URL input ---------------- */}
      <section aria-labelledby="wpdf-url-heading">
        <h2
          id="wpdf-url-heading"
          className="text-sm font-semibold text-foreground"
        >
          {t("wpdf.urlLabel")}
        </h2>
        <div className="mt-3 flex flex-col gap-2 rounded-card border border-border bg-card p-4 sm:p-5">
          <div className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className="flex size-10 shrink-0 items-center justify-center rounded-btn bg-primary/10 text-primary"
            >
              <Globe className="size-5" />
            </span>
            <Input
              id={inputId}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={url}
              onChange={handleUrlChange}
              placeholder={t("wpdf.urlPlaceholder")}
              aria-invalid={!urlValid && trimmed !== ""}
              aria-describedby="wpdf-url-hint"
              className="min-w-0 flex-1 rounded-btn font-mono text-sm"
              disabled={fetching}
            />
          </div>
          <p id="wpdf-url-hint" className="text-[11px] leading-relaxed text-muted-foreground">
            {t("wpdf.urlHint")}
          </p>
          {trimmed !== "" && !urlValid ? (
            <div
              role="status"
              className="flex items-start gap-2 rounded-btn border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-900 dark:text-amber-200"
            >
              <TriangleAlert
                className="mt-0.5 size-3.5 shrink-0"
                aria-hidden="true"
              />
              {t("wpdf.urlInvalid")}
            </div>
          ) : null}
        </div>
      </section>

      {/* ---------------- layout toggles + convert ---------------- */}
      <section aria-labelledby="wpdf-layout-heading">
        <h2
          id="wpdf-layout-heading"
          className="text-sm font-semibold text-foreground"
        >
          {t("wpdf.layoutTitle")}
        </h2>
        <div className="mt-3 flex flex-col gap-4 rounded-card border border-border bg-card p-4 sm:p-5">
          <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">
                {t("wpdf.pageSizeLbl")}
              </p>
              <div
                role="group"
                aria-label={t("wpdf.pageSizeLbl")}
                className="mt-2 flex flex-wrap gap-2"
              >
                {(
                  [
                    ["a4", "wpdf.pageA4"],
                    ["letter", "wpdf.pageLetter"],
                  ] as const
                ).map(([value, key]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={pageSize === value}
                    onClick={() => onChange("pageSize", value)}
                    className={cn(
                      "h-9 rounded-btn px-4 text-xs font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      pageSize === value
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-foreground hover:bg-muted/80"
                    )}
                  >
                    {t(key)}
                  </button>
                ))}
              </div>
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">
                {t("wpdf.marginLbl")}
              </p>
              <div
                role="group"
                aria-label={t("wpdf.marginLbl")}
                className="mt-2 flex flex-wrap gap-2"
              >
                {(
                  [
                    ["normal", "wpdf.marginNormal"],
                    ["narrow", "wpdf.marginNarrow"],
                  ] as const
                ).map(([value, key]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={margin === value}
                    onClick={() => onChange("margin", value)}
                    className={cn(
                      "h-9 rounded-btn px-4 text-xs font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      margin === value
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-foreground hover:bg-muted/80"
                    )}
                  >
                    {t(key)}
                  </button>
                ))}
              </div>
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">
                {t("wpdf.fontSizeLbl")}
              </p>
              <div
                role="group"
                aria-label={t("wpdf.fontSizeLbl")}
                className="mt-2 flex flex-wrap gap-2"
              >
                {(
                  [
                    ["small", "wpdf.fontSmall"],
                    ["normal", "wpdf.fontNormal"],
                    ["large", "wpdf.fontLarge"],
                  ] as const
                ).map(([value, key]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={baseFontSize === value}
                    onClick={() => onChange("baseFontSize", value)}
                    className={cn(
                      "h-9 rounded-btn px-4 text-xs font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      baseFontSize === value
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-foreground hover:bg-muted/80"
                    )}
                  >
                    {t(key)}
                  </button>
                ))}
              </div>
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">
                {t("wpdf.linksLbl")}
              </p>
              <div
                role="group"
                aria-label={t("wpdf.linksLbl")}
                className="mt-2 flex flex-wrap gap-2"
              >
                {(
                  [
                    [true, "wpdf.linksShow"],
                    [false, "wpdf.linksHide"],
                  ] as const
                ).map(([value, key]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={showLinks === value}
                    onClick={() => onChange("showLinks", value)}
                    className={cn(
                      "h-9 rounded-btn px-4 text-xs font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      showLinks === value
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-foreground hover:bg-muted/80"
                    )}
                  >
                    {t(key)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <Button
              type="button"
              size="touch"
              className="w-full rounded-btn font-semibold sm:w-auto sm:self-start"
              onClick={convert}
              disabled={!urlValid || fetching}
            >
              {fetching ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <FileDown className="size-4" aria-hidden="true" />
              )}
              {fetching
                ? pct !== null && pct < 45
                  ? t("wpdf.fetching")
                  : t("wpdf.converting")
                : t("wpdf.convert")}
            </Button>
            {fetching ? (
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct ?? 0}
                className="h-1.5 w-full overflow-hidden rounded-full bg-muted sm:max-w-xs"
              >
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300"
                  style={{ width: `${pct ?? 0}%` }}
                />
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {/* ---------------- the honest pipe explainer ---------------- */}
      <section aria-labelledby="wpdf-pipe-heading">
        <div className="rounded-card border border-border bg-card p-4 sm:p-5">
          <h2
            id="wpdf-pipe-heading"
            className="flex items-center gap-2 text-sm font-semibold text-foreground"
          >
            <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
            {t("wpdf.pipeTitle")}
          </h2>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {t("wpdf.pipeBody")}
          </p>
        </div>
      </section>

      {/* ---------------- saved-the-page note ---------------- */}
      <section aria-labelledby="wpdf-paste-heading">
        <div className="rounded-card border border-dashed border-border bg-muted/40 p-4 sm:p-5">
          <h2
            id="wpdf-paste-heading"
            className="flex items-center gap-2 text-sm font-semibold text-foreground"
          >
            <Info className="size-4 text-primary" aria-hidden="true" />
            {t("wpdf.pasteTitle")}
          </h2>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {t("wpdf.pasteBody")}{" "}
            <a
              href="#/tool/html-to-pdf"
              className="font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {t("wpdf.pasteLink")}
            </a>
          </p>
        </div>
      </section>

      {/* ---------------- honest limits ---------------- */}
      <p className="rounded-btn bg-muted/60 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
        {t("wpdf.honestNote")}
      </p>
    </div>
  );
}
