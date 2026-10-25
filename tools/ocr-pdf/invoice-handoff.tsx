"use client";

/**
 * OCR → invoice hand-off (R5-c). Rendered by the shared result view for
 * the ocr tool (registry TOOL_RESULT_EXTRAS): after a run that produced
 * recognized text, one click extracts the labelled invoice fields (pure
 * heuristics in ./invoice-extract.ts) and hands them to the create-invoice
 * editor through the one-shot localStorage key "dp_inv_ocr" — then
 * navigates there. Honest states:
 *  - no recognized text at all → the button does not render;
 *  - text, but no labelled invoice field found → disabled with the
 *    "No invoice fields found in this text" tooltip (never a fake draft);
 *  - fields found → the create-invoice side hydrates whatever was found
 *    and tells the user to review every field before downloading.
 */

import { useMemo } from "react";
import { Receipt } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import { navigateToHash, ROUTES } from "@/hooks/use-hash-route";
import type { ToolResultExtraProps } from "@/lib/tools/panel-types";
import {
  extractInvoiceDraft,
  OCR_PREFILL_KEY,
  readOcrPageTexts,
  serializeOcrPrefill,
} from "./invoice-extract";

export function OcrInvoiceHandoff({ runSummary }: ToolResultExtraProps) {
  const { t, locale } = useI18n();
  const { toast } = useToast();

  // Pure extraction of the run's recognized text — recomputed only when
  // the run detail or the locale changes.
  const pageTexts = useMemo(() => readOcrPageTexts(runSummary), [runSummary]);
  const draft = useMemo(
    () =>
      pageTexts && pageTexts.some((page) => page.trim().length > 0)
        ? extractInvoiceDraft(pageTexts, locale)
        : null,
    [pageTexts, locale]
  );

  if (!pageTexts) return null; // run carried no recognized text — no button

  const disabled = draft === null;

  const send = () => {
    if (draft === null) return;
    let stored = false;
    try {
      localStorage.setItem(
        OCR_PREFILL_KEY,
        serializeOcrPrefill(draft, Date.now())
      );
      stored = true;
    } catch {
      // storage unavailable/full — never navigate into an empty editor
    }
    if (!stored) {
      toast({
        title: t("tool.errorTitle"),
        description: t("tool.errorGeneric", { detail: "" }),
        variant: "destructive",
      });
      return;
    }
    navigateToHash(ROUTES.tool("create-invoice"));
  };

  return (
    <span
      className="inline-flex flex-col items-center gap-1.5"
      title={disabled ? t("result.ocrSendInvoiceHint") : undefined}
    >
      <Button
        type="button"
        variant="outline"
        size="touch"
        className="rounded-btn"
        disabled={disabled}
        aria-disabled={disabled}
        onClick={send}
      >
        <Receipt className="size-4" aria-hidden="true" />
        {t("result.ocrSendInvoice")}
      </Button>
      {disabled ? (
        <span className="max-w-sm text-center text-xs text-muted-foreground">
          {t("result.ocrSendInvoiceHint")}
        </span>
      ) : null}
    </span>
  );
}
