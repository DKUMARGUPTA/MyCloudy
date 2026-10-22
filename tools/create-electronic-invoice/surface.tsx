"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BadgeCheck,
  CheckCircle2,
  FileCode,
  FileDown,
  FileText,
  Loader2,
  Plus,
  ShieldQuestion,
  Trash2,
  TriangleAlert,
  Wand2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import { downloadBlob, sanitizeFileName } from "@/lib/files/output";
import { formatBytes } from "@/lib/storage/recent-files";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import type { WorkerResponse } from "@/lib/workers/protocol";
import { cn } from "@/lib/utils";
import { sampleXmlFromForm } from "./model";
import {
  CONFORMANCE_LEVELS,
  DEFAULT_LEVEL,
  FACTUR_X_FILENAME,
  type CeiDetail,
  type ConformanceLevel,
  type SampleInvoiceForm,
} from "./types";

/**
 * create-electronic-invoice surface (RB5-b — the create-invoice landing
 * workspace pattern): the whole two-file flow lives on the landing page
 * because the standard DropZone sniffs PDF magic only and could never
 * accept the XML half of this tool's input.
 *
 *  - Step 1: the invoice PDF (own input, %PDF- magic sniff on read);
 *  - Step 2: the Factur-X XML (own input, first-byte "<" sniff) — or the
 *    sample generator form below it builds a well-formed EN 16931
 *    document on the spot;
 *  - Step 3: the conformance level stamp + the honest "what the run will
 *    do" plan (attachment + XMP, pages untouched, NO PDF/A-3 claim);
 *  - Run: surface-driven worker (pdf-to-odt convert pattern) with real
 *    progress, download, toast and the full run report right here —
 *    the standard result phase only knows "N pages".
 *
 * Everything stays on-device; nothing is ever uploaded.
 */

const LEVEL_VALUES: readonly ConformanceLevel[] = CONFORMANCE_LEVELS;

/** Static i18n keys for the level descriptions (grep-able). */
const LEVEL_DESC_KEYS: Record<ConformanceLevel, string> = {
  MINIMUM: "cei.levelDescMinimum",
  BASIC: "cei.levelDescBasic",
  "EN 16931": "cei.levelDescEn",
};

const CURRENCIES = ["EUR", "INR", "USD", "GBP"] as const;

/** One sample-form line item row (string inputs, parsed on generate). */
interface ItemRow {
  name: string;
  qty: string;
  price: string;
}

interface DoneState {
  name: string;
  blob: Blob;
  detail: CeiDetail;
}

function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** %PDF- magic sniff (house rule: content, never the extension). */
async function sniffIsPdf(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  return (
    head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 &&
    head[3] === 0x46 && head[4] === 0x2d
  );
}

/** First non-BOM, non-whitespace byte must be "<". */
async function sniffIsXml(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  let i = 0;
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) i = 3;
  while (i < head.length) {
    const c = head[i];
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
      i += 1;
      continue;
    }
    return c === 0x3c;
  }
  return false;
}

export function CreateElectronicInvoiceSurface(
  props: ToolSurfaceProps
): React.JSX.Element | null {
  // No shell options for this tool — the surface owns the level selector
  // (create-invoice landing-workspace pattern); `props` keeps the contract.
  void props;
  const { t } = useI18n();
  const { toast } = useToast();

  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [xmlFile, setXmlFile] = useState<File | null>(null);
  const [level, setLevel] = useState<ConformanceLevel>(DEFAULT_LEVEL);
  const [pct, setPct] = useState<number | null>(null);
  const [done, setDone] = useState<DoneState | null>(null);
  const workerRef = useRef<Worker | null>(null);

  /* -------- sample generator form state -------- */
  const [sampleOpen, setSampleOpen] = useState(true);
  const [seller, setSeller] = useState("Acme Supplies GmbH");
  const [buyer, setBuyer] = useState("Buyer Industries Ltd.");
  const [invoiceNo, setInvoiceNo] = useState("RE-2026-042");
  const [date, setDate] = useState(todayIso());
  const [currency, setCurrency] = useState<string>("EUR");
  const [taxRate, setTaxRate] = useState<string>("18");
  const [items, setItems] = useState<ItemRow[]>([
    { name: "Widget assembly", qty: "2", price: "120.00" },
    { name: "Cable set", qty: "5", price: "12.50" },
  ]);
  const [preview, setPreview] = useState<string | null>(null);

  const busy = pct !== null;
  const ready = pdfFile !== null && xmlFile !== null;

  /* -------- file slots (own inputs; sniff on read) -------- */

  const takePdf = useCallback(
    async (file: File | undefined | null): Promise<void> => {
      if (!file) return;
      if (!(await sniffIsPdf(file))) {
        toast({
          title: t("tool.errorTitle"),
          description: t("cei.errNotPdf"),
          variant: "destructive",
        });
        return;
      }
      setPdfFile(file);
      setDone(null);
    },
    [t, toast]
  );

  const takeXml = useCallback(
    async (file: File | undefined | null): Promise<void> => {
      if (!file) return;
      if (!(await sniffIsXml(file))) {
        toast({
          title: t("tool.errorTitle"),
          description: t("cei.errNotXml"),
          variant: "destructive",
        });
        return;
      }
      setXmlFile(file);
      setPreview(null);
      setDone(null);
    },
    [t, toast]
  );

  /* -------- sample XML generation -------- */

  const generateSample = useCallback((): void => {
    const form: SampleInvoiceForm = {
      seller,
      buyer,
      number: invoiceNo,
      date,
      currency,
      taxRate: Number.parseFloat(taxRate),
      items: items
        .map((row) => ({
          name: row.name,
          qty: Number.parseFloat(row.qty),
          unitPrice: Number.parseFloat(row.price),
        }))
        .filter(
          (row) =>
            row.name.trim() !== "" &&
            Number.isFinite(row.qty) &&
            Number.isFinite(row.unitPrice)
        ),
    };
    const xml = sampleXmlFromForm(form);
    const file = new File([xml], FACTUR_X_FILENAME, { type: "text/xml" });
    setXmlFile(file);
    setPreview(xml);
    setDone(null);
    toast({
      title: t("cei.sampleDoneTitle"),
      description: t("cei.sampleDoneDesc", { name: FACTUR_X_FILENAME }),
    });
  }, [buyer, currency, date, invoiceNo, items, seller, t, taxRate, toast]);

  const setItem = (index: number, patch: Partial<ItemRow>): void => {
    setItems((prev) =>
      prev.map((row, i) => (i === index ? { ...row, ...patch } : row))
    );
  };

  /* -------- the run (surface-driven worker, pdf-to-odt pattern) -------- */

  const convert = useCallback((): void => {
    if (!ready || workerRef.current) return;
    setPct(0);
    setDone(null);
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
          const detail = data.detail as CeiDetail | undefined;
          if (output) {
            const safeName = sanitizeFileName(output.name, "pdf");
            downloadBlob(output.blob, safeName);
            setDone({
              name: safeName,
              blob: output.blob,
              detail: {
                pages: detail?.pages ?? 0,
                attachmentName: detail?.attachmentName ?? FACTUR_X_FILENAME,
                attachmentBytes: detail?.attachmentBytes ?? 0,
                conformanceLevel: detail?.conformanceLevel ?? level,
                afPresent: detail?.afPresent ?? false,
                afRelationshipAlternative:
                  detail?.afRelationshipAlternative ?? false,
                xmpWritten: detail?.xmpWritten ?? false,
                xmlShapeOk: detail?.xmlShapeOk ?? false,
                xmlInvoiceId: detail?.xmlInvoiceId ?? "",
                xmlCurrency: detail?.xmlCurrency ?? "",
                xmlLineCount: detail?.xmlLineCount ?? 0,
                sourceOutputIntent: detail?.sourceOutputIntent ?? false,
                sourceXmpPdfaid: detail?.sourceXmpPdfaid ?? false,
                beforeBytes: detail?.beforeBytes ?? 0,
                afterBytes: detail?.afterBytes ?? 0,
              },
            });
            toast({
              title: t("cei.doneTitle"),
              description: t("cei.doneDesc", {
                name: safeName,
                pages: detail?.pages ?? 0,
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
            description: t(data.code, { detail: data.detail ?? "" }),
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
      toolId: "create-electronic-invoice",
      options: { level },
      files: [pdfFile, xmlFile],
    });
  }, [level, pdfFile, ready, t, toast, xmlFile]);

  // Never leave a worker spinning behind a remount.
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  /* ------------------------------ render ------------------------------ */

  return (
    <section
      aria-labelledby="cei-heading"
      className="flex flex-col gap-4"
    >
      <h2 id="cei-heading" className="sr-only">
        {t("cei.surfaceLabel")}
      </h2>

      {/* ---------- steps 1 + 2: the two file cards ---------- */}
      <div className="grid gap-4 sm:grid-cols-2">
        {/* PDF slot */}
        <div className="flex flex-col gap-2 rounded-card border border-border bg-card p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <span
              className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary"
              aria-hidden="true"
            >
              1
            </span>
            {t("cei.pdfTitle")}
          </p>
          {pdfFile === null ? (
            <>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("cei.pdfHint")}
              </p>
              <label className="mt-auto">
                <span className="sr-only">{t("cei.pdfPick")}</span>
                <span
                  className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-btn border border-border bg-background px-4 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-accent"
                  aria-hidden="true"
                >
                  <FileText className="size-4 shrink-0 text-primary" />
                  {t("cei.pdfPick")}
                </span>
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  disabled={busy}
                  className="sr-only"
                  onChange={(event) => {
                    void takePdf(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
              </label>
            </>
          ) : (
            <div className="mt-1 flex items-center gap-2 rounded-btn bg-muted/60 px-3 py-2">
              <FileText
                className="size-4 shrink-0 text-primary"
                aria-hidden="true"
              />
              <span
                className="min-w-0 flex-1 truncate text-xs font-medium text-foreground"
                title={pdfFile.name}
              >
                {pdfFile.name}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {formatBytes(pdfFile.size)}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setPdfFile(null);
                  setDone(null);
                }}
                className="flex size-8 shrink-0 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                aria-label={t("cei.remove")}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
          )}
        </div>

        {/* XML slot */}
        <div className="flex flex-col gap-2 rounded-card border border-border bg-card p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <span
              className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary"
              aria-hidden="true"
            >
              2
            </span>
            {t("cei.xmlTitle")}
          </p>
          {xmlFile === null ? (
            <>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("cei.xmlHint")}
              </p>
              <label className="mt-auto">
                <span className="sr-only">{t("cei.xmlPick")}</span>
                <span
                  className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-btn border border-border bg-background px-4 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-accent"
                  aria-hidden="true"
                >
                  <FileCode className="size-4 shrink-0 text-primary" />
                  {t("cei.xmlPick")}
                </span>
                <input
                  type="file"
                  accept=".xml,text/xml,application/xml"
                  disabled={busy}
                  className="sr-only"
                  onChange={(event) => {
                    void takeXml(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
              </label>
              <p className="text-[11px] text-muted-foreground">
                {t("cei.xmlNoFile")}
              </p>
            </>
          ) : (
            <div className="mt-1 flex items-center gap-2 rounded-btn bg-muted/60 px-3 py-2">
              <FileCode
                className="size-4 shrink-0 text-primary"
                aria-hidden="true"
              />
              <span
                className="min-w-0 flex-1 truncate text-xs font-medium text-foreground"
                title={xmlFile.name}
              >
                {xmlFile.name}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {formatBytes(xmlFile.size)}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setXmlFile(null);
                  setPreview(null);
                  setDone(null);
                }}
                className="flex size-8 shrink-0 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                aria-label={t("cei.remove")}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ---------- sample XML generator (collapsible) ---------- */}
      <div className="rounded-card border border-border bg-card">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold text-foreground"
          aria-expanded={sampleOpen}
          onClick={() => setSampleOpen((open) => !open)}
        >
          <Wand2 className="size-4 shrink-0 text-primary" aria-hidden="true" />
          {t("cei.sampleTitle")}
          <span
            className={cn(
              "ml-auto text-xs font-normal text-muted-foreground transition-transform",
              sampleOpen ? "rotate-180" : "rotate-0"
            )}
            aria-hidden="true"
          >
            ▾
          </span>
        </button>
        {sampleOpen ? (
          <div className="border-t border-border/60 px-4 pb-4 pt-3">
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("cei.sampleHint")}
            </p>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="cei-seller" className="text-xs font-medium">
                  {t("cei.fSeller")}
                </Label>
                <input
                  id="cei-seller"
                  type="text"
                  value={seller}
                  disabled={busy}
                  onChange={(event) => setSeller(event.target.value)}
                  className="mt-1.5 h-10 w-full rounded-btn border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                />
              </div>
              <div>
                <Label htmlFor="cei-buyer" className="text-xs font-medium">
                  {t("cei.fBuyer")}
                </Label>
                <input
                  id="cei-buyer"
                  type="text"
                  value={buyer}
                  disabled={busy}
                  onChange={(event) => setBuyer(event.target.value)}
                  className="mt-1.5 h-10 w-full rounded-btn border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                />
              </div>
              <div>
                <Label htmlFor="cei-number" className="text-xs font-medium">
                  {t("cei.fNumber")}
                </Label>
                <input
                  id="cei-number"
                  type="text"
                  value={invoiceNo}
                  disabled={busy}
                  onChange={(event) => setInvoiceNo(event.target.value)}
                  className="mt-1.5 h-10 w-full rounded-btn border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <Label htmlFor="cei-date" className="text-xs font-medium">
                    {t("cei.fDate")}
                  </Label>
                  <input
                    id="cei-date"
                    type="date"
                    value={date}
                    disabled={busy}
                    onChange={(event) => setDate(event.target.value)}
                    className="mt-1.5 h-10 w-full rounded-btn border border-border bg-background px-2 text-sm text-foreground outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  />
                </div>
                <div>
                  <Label htmlFor="cei-currency" className="text-xs font-medium">
                    {t("cei.fCurrency")}
                  </Label>
                  <select
                    id="cei-currency"
                    value={currency}
                    disabled={busy}
                    onChange={(event) => setCurrency(event.target.value)}
                    className="mt-1.5 h-10 w-full rounded-btn border border-border bg-background px-2 text-sm text-foreground outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    {CURRENCIES.map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div className="mt-4">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs font-medium">
                  {t("cei.fItems")}
                </Label>
                {items.length < 3 ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 rounded-btn px-2 text-[11px]"
                    disabled={busy}
                    onClick={() =>
                      setItems((prev) => [
                        ...prev,
                        { name: "", qty: "1", price: "0.00" },
                      ])
                    }
                  >
                    <Plus className="size-3.5" aria-hidden="true" />
                    {t("cei.fAddItem")}
                  </Button>
                ) : null}
              </div>
              <div className="mt-2 flex flex-col gap-2">
                {items.map((row, index) => (
                  <div
                    key={index}
                    className="grid grid-cols-[1fr_4.5rem_6rem_2.25rem] items-center gap-2"
                  >
                    <input
                      type="text"
                      value={row.name}
                      disabled={busy}
                      placeholder={t("cei.fItemName")}
                      aria-label={t("cei.fItemName")}
                      onChange={(event) =>
                        setItem(index, { name: event.target.value })
                      }
                      className="h-10 w-full rounded-btn border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    />
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="any"
                      value={row.qty}
                      disabled={busy}
                      placeholder={t("cei.fItemQty")}
                      aria-label={t("cei.fItemQty")}
                      onChange={(event) =>
                        setItem(index, { qty: event.target.value })
                      }
                      className="h-10 w-full rounded-btn border border-border bg-background px-2 text-sm text-foreground outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    />
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="any"
                      value={row.price}
                      disabled={busy}
                      placeholder={t("cei.fItemPrice")}
                      aria-label={t("cei.fItemPrice")}
                      onChange={(event) =>
                        setItem(index, { price: event.target.value })
                      }
                      className="h-10 w-full rounded-btn border border-border bg-background px-2 text-sm text-foreground outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    />
                    <button
                      type="button"
                      disabled={busy || items.length <= 1}
                      onClick={() =>
                        setItems((prev) =>
                          prev.filter((_, i) => i !== index)
                        )
                      }
                      className="flex size-10 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-40"
                      aria-label={t("cei.fRemoveItem")}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="mt-3 grid gap-2 sm:max-w-xs">
                <Label htmlFor="cei-tax" className="text-xs font-medium">
                  {t("cei.fTaxRate")}
                </Label>
                <input
                  id="cei-tax"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  max="100"
                  step="any"
                  value={taxRate}
                  disabled={busy}
                  onChange={(event) => setTaxRate(event.target.value)}
                  className="h-10 w-full rounded-btn border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50"
                />
              </div>
            </div>

            <Button
              type="button"
              variant="outline"
              className="mt-4 w-full rounded-btn sm:w-auto"
              disabled={busy}
              onClick={generateSample}
            >
              <Wand2 className="size-4" aria-hidden="true" />
              {t("cei.fGenerate")}
            </Button>

            {preview !== null ? (
              <div className="mt-3">
                <p className="text-[11px] font-medium text-muted-foreground">
                  {t("cei.previewTitle")}
                </p>
                <pre className="mt-1.5 max-h-56 overflow-y-auto scrollbar-thin rounded-btn bg-muted/60 p-3 text-[10px] leading-relaxed text-foreground">
                  {preview.length > 4000
                    ? `${preview.slice(0, 4000)}…`
                    : preview}
                </pre>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* ---------- step 3: level + plan ---------- */}
      <div className="rounded-card border border-border bg-card p-4 sm:p-5">
        <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <span
            className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary"
            aria-hidden="true"
          >
            3
          </span>
          {t("cei.levelTitle")}
        </p>

        <div
          role="radiogroup"
          aria-label={t("cei.levelTitle")}
          className="mt-3 grid gap-2 sm:grid-cols-3"
        >
          {LEVEL_VALUES.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={level === value}
              disabled={busy}
              onClick={() => setLevel(value)}
              className={cn(
                "rounded-btn border px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
                level === value
                  ? "border-primary bg-primary/5"
                  : "border-border bg-background hover:border-primary/40"
              )}
            >
              <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                {level === value ? (
                  <BadgeCheck
                    className="size-3.5 shrink-0 text-primary"
                    aria-hidden="true"
                  />
                ) : null}
                {value}
              </span>
              <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
                {t(LEVEL_DESC_KEYS[value])}
              </span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {t("cei.levelHint")}
        </p>

        {/* what the run will do */}
        <div className="mt-4 rounded-btn bg-muted/50 p-3">
          <p className="text-xs font-semibold text-foreground">
            {t("cei.planTitle")}
          </p>
          <ul className="mt-2 flex flex-col gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
            <li className="flex gap-1.5">
              <CheckCircle2
                className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                aria-hidden="true"
              />
              {t("cei.plan1", { name: FACTUR_X_FILENAME })}
            </li>
            <li className="flex gap-1.5">
              <CheckCircle2
                className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                aria-hidden="true"
              />
              {t("cei.plan2", { level })}
            </li>
            <li className="flex gap-1.5">
              <TriangleAlert
                className="mt-0.5 size-3.5 shrink-0 text-amber-500"
                aria-hidden="true"
              />
              {t("cei.plan3")}
            </li>
          </ul>
        </div>
      </div>

      {/* ---------- run + progress ---------- */}
      <div className="flex flex-col gap-2" aria-live="polite">
        <Button
          type="button"
          size="touch"
          className="w-full rounded-btn font-semibold"
          onClick={convert}
          disabled={!ready || busy}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <FileDown className="size-4" aria-hidden="true" />
          )}
          {busy
            ? t("cei.running", { pct: pct ?? 0 })
            : t("cei.runBtn")}
        </Button>
        {!ready ? (
          <p className="text-[11px] text-muted-foreground">
            {pdfFile === null && xmlFile === null
              ? t("cei.ctaNeedBoth")
              : pdfFile === null
                ? t("cei.ctaNeedPdf")
                : t("cei.ctaNeedXml")}
          </p>
        ) : null}
      </div>

      {/* ---------- result + the honest run report ---------- */}
      {done && !busy ? (
        <div
          className="flex flex-col gap-3 rounded-card border border-border bg-card p-4 sm:p-5"
          role="status"
        >
          <div className="flex flex-wrap items-center gap-2">
            <CheckCircle2
              className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {done.name}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 rounded-btn"
              onClick={() => downloadBlob(done.blob, done.name)}
            >
              <FileDown className="size-3.5" aria-hidden="true" />
              {t("cei.again")}
            </Button>
          </div>

          <ul className="flex flex-wrap gap-1.5">
            <li className="rounded-chip bg-muted px-2.5 py-1 text-[11px] font-medium text-foreground">
              {t("cei.rPages", { count: done.detail.pages ?? 0 })}
            </li>
            <li className="rounded-chip bg-muted px-2.5 py-1 text-[11px] font-medium text-foreground">
              {t("cei.rAttachment", {
                name: done.detail.attachmentName ?? FACTUR_X_FILENAME,
                size: formatBytes(done.detail.attachmentBytes ?? 0),
              })}
            </li>
            <li className="rounded-chip bg-muted px-2.5 py-1 text-[11px] font-medium text-foreground">
              {t("cei.rLevel", { level: done.detail.conformanceLevel ?? "" })}
            </li>
            <li className="rounded-chip bg-muted px-2.5 py-1 text-[11px] font-medium text-foreground">
              {t("cei.rSize", {
                before: formatBytes(done.detail.beforeBytes ?? 0),
                after: formatBytes(done.detail.afterBytes ?? 0),
              })}
            </li>
          </ul>

          <dl className="grid gap-x-4 gap-y-1.5 rounded-btn bg-muted/40 p-3 text-[11px] sm:grid-cols-2">
            <div className="flex items-center justify-between gap-2 sm:block">
              <dt className="text-muted-foreground">{t("cei.rAf")}</dt>
              <dd className="font-medium text-foreground">
                {done.detail.afPresent && done.detail.afRelationshipAlternative
                  ? `/AF + /AFRelationship /Alternative ✓`
                  : t("cei.rMissing")}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2 sm:block">
              <dt className="text-muted-foreground">{t("cei.rXmp")}</dt>
              <dd className="font-medium text-foreground">
                {done.detail.xmpWritten
                  ? "fx:DocumentType=INVOICE ✓"
                  : t("cei.rMissing")}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2 sm:block">
              <dt className="text-muted-foreground">{t("cei.rInvoiceId")}</dt>
              <dd className="truncate font-medium text-foreground">
                {done.detail.xmlInvoiceId || "—"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2 sm:block">
              <dt className="text-muted-foreground">{t("cei.rCurrency")}</dt>
              <dd className="font-medium text-foreground">
                {done.detail.xmlCurrency || "—"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2 sm:block">
              <dt className="text-muted-foreground">{t("cei.rLines")}</dt>
              <dd className="font-medium text-foreground">
                {String(done.detail.xmlLineCount)}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2 sm:block">
              <dt className="text-muted-foreground">{t("cei.rXmlShape")}</dt>
              <dd className="font-medium text-foreground">
                {done.detail.xmlShapeOk
                  ? t("cei.rShapeOk")
                  : t("cei.rShapePartial")}
              </dd>
            </div>
          </dl>

          <div className="flex items-start gap-2.5 rounded-btn border border-amber-300/60 bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200">
            <ShieldQuestion
              className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
              aria-hidden="true"
            />
            <p>
              {done.detail.sourceOutputIntent || done.detail.sourceXmpPdfaid
                ? t("cei.rSourcePdfa")
                : t("cei.rSourcePlain")}
              {" "}
              {t("cei.rHonest")}
            </p>
          </div>
        </div>
      ) : null}

      <p className="text-[11px] text-muted-foreground">
        {t("cei.privacyLine")}
      </p>
    </section>
  );
}

export default CreateElectronicInvoiceSurface;
