"use client";

import { useId } from "react";
import {
  FileText,
  Gauge,
  Languages,
  Package,
  ScanText,
} from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import type { ToolPanelProps } from "@/lib/tools/panel-types";
import { OCR_MODEL_MB, resolveOcrOptions } from "./engine";

/**
 * OCR PDF summary panel — the bookmark precedent: the schema-driven
 * OptionsPanel owns the five inputs; this aside reads the CURRENT values
 * (plus the probe summary the workspace surface serializes into the
 * "probeSummary" option) and answers, at a glance:
 *
 *   which language · which model + size · which quality
 *   which output · how many pages will actually be OCR'd.
 */

const LANG_LABELS: Record<string, { en: string; hi: string }> = {
  eng: { en: "English", hi: "अंग्रेज़ी" },
  hin: { en: "Hindi", hi: "हिंदी" },
  "eng+hin": { en: "English + Hindi", hi: "अंग्रेज़ी + हिंदी" },
};

export function OcrPanel({ files, values }: ToolPanelProps) {
  const { t, locale } = useI18n();
  const uid = useId();
  const listId = `${uid}-ocr-summary`;

  const file = files[0]?.file ?? null;
  const opts = resolveOcrOptions(values);

  // "total:imageOnly:withText" — written by the surface's text probe.
  const probeRaw = String(values.probeSummary ?? "");
  const [total, imageOnly, withText] = probeRaw.split(":").map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  const probeReady = /^(\d+):(\d+):(\d+)$/.test(probeRaw);

  const langEntry = LANG_LABELS[opts.langs] ?? LANG_LABELS.eng;
  const langText = locale === "hi" ? langEntry.hi : langEntry.en;
  const mb = opts.langs
    .split("+")
    .reduce((sum, code) => sum + (OCR_MODEL_MB[code as "eng" | "hin"] ?? 0), 0)
    .toFixed(1);

  const outputText =
    opts.outputMode === "text"
      ? t("ocr.panelOutputText")
      : opts.outputMode === "both"
        ? t("ocr.panelOutputBoth")
        : t("ocr.panelOutputPdf");

  if (!file) return null;

  return (
    <section
      aria-label={t("ocr.panelTitle")}
      className="flex flex-col gap-3"
    >
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <ScanText className="size-3.5" aria-hidden="true" />
        {t("ocr.panelTitle")}
      </h3>

      <ul id={listId} className="flex flex-col gap-2 text-xs">
        <li className="flex items-center justify-between gap-3 rounded-btn border border-border bg-background px-3 py-2">
          <span className="flex items-center gap-1.5 text-foreground">
            <Languages className="size-3.5 text-muted-foreground" aria-hidden="true" />
            {t("ocr.panelLangsLabel")}
          </span>
          <span className="font-semibold text-foreground">{langText}</span>
        </li>
        <li className="flex items-center justify-between gap-3 rounded-btn border border-border bg-background px-3 py-2">
          <span className="flex items-center gap-1.5 text-foreground">
            <Gauge className="size-3.5 text-muted-foreground" aria-hidden="true" />
            {t("ocr.panelDpiLabel")}
          </span>
          <span className="font-semibold tabular-nums text-foreground">
            {opts.dpi} DPI
          </span>
        </li>
        <li className="flex items-center justify-between gap-3 rounded-btn border border-border bg-background px-3 py-2">
          <span className="flex items-center gap-1.5 text-foreground">
            <Package className="size-3.5 text-muted-foreground" aria-hidden="true" />
            {t("ocr.panelOutputLabel")}
          </span>
          <span className="font-semibold text-foreground">{outputText}</span>
        </li>
      </ul>

      {probeReady ? (
        <div className="flex flex-col gap-1.5 rounded-btn border border-dashed border-border bg-muted/30 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <FileText className="size-3.5 shrink-0" aria-hidden="true" />
            {total === 1
              ? t("ocr.pagesTotalOne")
              : t("ocr.pagesTotal", { count: total })}
          </span>
          {imageOnly > 0 ? (
            <span className="font-medium text-foreground">
              {imageOnly === 1
                ? t("ocr.pagesImageOnlyOne")
                : t("ocr.pagesImageOnly", { count: imageOnly })}
            </span>
          ) : null}
          {withText > 0 ? (
            <span>
              {withText === 1
                ? t("ocr.pagesHaveTextOne")
                : t("ocr.pagesHaveText", { count: withText })}
            </span>
          ) : null}
        </div>
      ) : null}

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t("ocr.modelNote", { langs: langText, mb })}
      </p>
    </section>
  );
}

export default OcrPanel;
