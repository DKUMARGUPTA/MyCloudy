"use client";

/**
 * Shared e-invoice form (P9 batch 5) — the compact InvoiceState editor
 * used by BOTH create-electronic-invoice (blank start) and
 * pdf-to-e-invoice (prefilled from the PDF's text). Every label goes
 * through t() with "einv.*" keys; every input is fully controlled and
 * writes back through setState in event handlers ONLY (no ref writes in
 * render, no sync setState in effects — the payload-keyed state rule).
 *
 * Live math: the summary strip recomputes via calc() from
 * ../create-invoice/model, so subtotal / tax / grand total can never
 * disagree with the XML the worker will attach. GSTINs get the official
 * mod-36 checksum hint (amber) and silently derive the GST state codes
 * from their prefixes so calc()'s CGST+SGST vs IGST split is right.
 */

import { useCallback, useMemo, type ChangeEvent } from "react";
import { Plus, Trash2, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/components/providers/locale-provider";
import {
  calc,
  formatMoney,
  gstOK,
  type InvoiceState,
} from "../create-invoice/model";
import {
  CURRENCY_SYMBOLS,
  INVOICE_CURRENCIES,
  currencyLocale,
} from "../create-invoice/types";
import { EINV_MAX_ITEMS, gstStateOf } from "./payload";

/* ------------------------------------------------------------------ */
/* Styles (create-invoice's exact field classes)                        */
/* ------------------------------------------------------------------ */

const inputCls =
  "h-11 min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";
const selCls = inputCls;
const areaCls =
  "min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

/** Section card — same chrome as the shell's surfaces (no Card dep). */
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="rounded-card border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

/** Amber inline note (GSTIN checksum, advisory). */
function WarnNote({ id, text }: { id: string; text: string }): React.JSX.Element {
  return (
    <p
      id={id}
      className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400"
    >
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{text}</span>
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* The form                                                             */
/* ------------------------------------------------------------------ */

export function EInvoiceForm({
  state,
  setState,
  notes,
}: {
  state: InvoiceState;
  setState: (s: InvoiceState) => void;
  /** Optional context lines the owning surface wants inside the form. */
  notes?: string[];
}): React.JSX.Element {
  const { t } = useI18n();

  /* ---------- live math (always in paise, always the worker's calc) ---------- */
  const c = useMemo(() => calc(state), [state]);
  const sym = CURRENCY_SYMBOLS[state.cur];
  const loc = currencyLocale(state.cur);
  const money = useCallback(
    (p: number) => `${sym}\u00a0${formatMoney(p, state.cur, loc)}`,
    [sym, state.cur, loc]
  );
  const taxTotal = c.cg + c.sg + c.ig + c.tx;

  /* ---------- GSTIN checksum hints ---------- */
  const bizGstBad =
    state.biz.gstin.trim().length >= 15 && !gstOK(state.biz.gstin);
  const cliGstBad =
    state.cli.gstin.trim().length >= 15 && !gstOK(state.cli.gstin);

  /* ---------- field setters (event context only) ---------- */
  const setBiz = useCallback(
    (key: "name" | "addr" | "gstin" | "email", value: string) => {
      setState({ ...state, biz: { ...state.biz, [key]: value } });
    },
    [setState, state]
  );

  const setCli = useCallback(
    (key: "name" | "addr" | "gstin", value: string) => {
      setState({ ...state, cli: { ...state.cli, [key]: value } });
    },
    [setState, state]
  );

  const setTop = useCallback(
    (key: "no" | "date" | "due" | "d" | "tr" | "adv", value: string) => {
      setState({ ...state, [key]: value });
    },
    [setState, state]
  );

  /** Currency + discount mode need their literal unions validated. */
  const setCur = useCallback(
    (value: string) => {
      setState({
        ...state,
        cur: (INVOICE_CURRENCIES as readonly string[]).includes(value)
          ? (value as InvoiceState["cur"])
          : state.cur,
      });
    },
    [setState, state]
  );

  const setDMode = useCallback(
    (value: string) => {
      setState({ ...state, dMode: value === "f" ? "f" : "%" });
    },
    [setState, state]
  );

  /** GSTINs: uppercase, no spaces, 15 chars; the state code rides along
   *  silently so calc()'s CGST+SGST / IGST split matches the GSTINs. */
  const onBizGstin = useCallback(
    (value: string) => {
      const v = value.toUpperCase().replace(/\s/g, "").slice(0, 15);
      const code = gstStateOf(v);
      setState({
        ...state,
        biz: {
          ...state.biz,
          gstin: v,
          ...(code ? { state: code } : {}),
        },
      });
    },
    [setState, state]
  );

  const onCliGstin = useCallback(
    (value: string) => {
      const v = value.toUpperCase().replace(/\s/g, "").slice(0, 15);
      const code = gstStateOf(v);
      setState({
        ...state,
        cli: {
          ...state.cli,
          gstin: v,
          ...(code ? { state: code } : {}),
        },
        ...(code ? { pos: code } : {}),
      });
    },
    [setState, state]
  );

  const setItem = useCallback(
    (idx: number, key: "d" | "h" | "q" | "r" | "g", value: string) => {
      setState({
        ...state,
        items: state.items.map((it, i) =>
          i === idx ? { ...it, [key]: value } : it
        ),
      });
    },
    [setState, state]
  );

  const addItem = useCallback(() => {
    if (state.items.length >= EINV_MAX_ITEMS) return;
    const lastG = state.items[state.items.length - 1]?.g ?? "18";
    setState({
      ...state,
      items: [
        ...state.items,
        { d: "", h: "", q: "1", r: "", g: lastG },
      ],
    });
  }, [setState, state]);

  const removeItem = useCallback(
    (idx: number) => {
      if (state.items.length <= 1) {
        // Last row clears instead of vanishing — the form stays usable.
        setState({
          ...state,
          items: [{ d: "", h: "", q: "1", r: "", g: state.items[0]?.g ?? "18" }],
        });
        return;
      }
      setState({
        ...state,
        items: state.items.filter((_, i) => i !== idx),
      });
    },
    [setState, state]
  );

  const onItemInput = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const el = e.target;
      const idx = Number(el.dataset.idx);
      const key = el.dataset.k as "d" | "h" | "q" | "r" | "g" | undefined;
      if (!key || !Number.isInteger(idx)) return;
      setItem(idx, key, el.value);
    },
    [setItem]
  );

  const onRoundOff = useCallback(
    (checked: boolean) => {
      setState({ ...state, ro: checked });
    },
    [setState, state]
  );

  /* ---------- render ---------- */
  return (
    <div className="flex flex-col gap-4">
      {/* Live summary strip — the same calc() the XML is built from. */}
      <div className="rounded-card border border-border bg-card p-4">
        <dl className="grid grid-cols-3 gap-2 text-center" aria-live="polite">
          <div className="min-w-0">
            <dt className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("einv.sumSub")}
            </dt>
            <dd className="truncate text-sm font-semibold tabular-nums text-foreground">
              {money(c.sub)}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("einv.sumTax")}
            </dt>
            <dd className="truncate text-sm font-semibold tabular-nums text-foreground">
              {money(taxTotal)}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("einv.sumTot")}
            </dt>
            <dd className="truncate text-sm font-bold tabular-nums text-primary">
              {money(c.tot)}
            </dd>
          </div>
        </dl>
        {c.disc > 0 || c.adv > 0 ? (
          <p className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            {c.disc > 0 ? (
              <span>
                {t("einv.sumDisc")}: <span className="tabular-nums">{money(c.disc)}</span>
              </span>
            ) : null}
            {c.adv > 0 ? (
              <span>
                {t("einv.sumAdv")}: <span className="tabular-nums">{money(c.adv)}</span>
              </span>
            ) : null}
            {c.adv > 0 ? (
              <span>
                {t("einv.sumBal")}: <span className="tabular-nums font-semibold">{money(c.bal)}</span>
              </span>
            ) : null}
          </p>
        ) : null}
      </div>

      {/* Business */}
      <Section title={t("einv.bizTitle")}>
        <Field label={t("einv.bizName")} htmlFor="einv-biz-name">
          <Input
            id="einv-biz-name"
            className={inputCls}
            value={state.biz.name}
            autoComplete="organization"
            onChange={(e) => setBiz("name", e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t("einv.bizGstin")} htmlFor="einv-biz-gstin">
            <Input
              id="einv-biz-gstin"
              className={`${inputCls} font-mono uppercase`}
              value={state.biz.gstin}
              aria-describedby={bizGstBad ? "einv-biz-gst-bad" : undefined}
              onChange={(e) => onBizGstin(e.target.value)}
            />
          </Field>
          <Field label={t("einv.bizEmail")} htmlFor="einv-biz-email">
            <Input
              id="einv-biz-email"
              type="email"
              className={inputCls}
              value={state.biz.email}
              autoComplete="email"
              onChange={(e) => setBiz("email", e.target.value)}
            />
          </Field>
        </div>
        {bizGstBad ? (
          <WarnNote id="einv-biz-gst-bad" text={t("einv.gstBad")} />
        ) : null}
        <Field label={t("einv.bizAddr")} htmlFor="einv-biz-addr">
          <Textarea
            id="einv-biz-addr"
            className={areaCls}
            rows={2}
            value={state.biz.addr}
            onChange={(e) => setBiz("addr", e.target.value)}
          />
        </Field>
      </Section>

      {/* Client */}
      <Section title={t("einv.cliTitle")}>
        <Field label={t("einv.cliName")} htmlFor="einv-cli-name">
          <Input
            id="einv-cli-name"
            className={inputCls}
            value={state.cli.name}
            onChange={(e) => setCli("name", e.target.value)}
          />
        </Field>
        <Field label={t("einv.cliGstin")} htmlFor="einv-cli-gstin">
          <Input
            id="einv-cli-gstin"
            className={`${inputCls} font-mono uppercase`}
            value={state.cli.gstin}
            aria-describedby={cliGstBad ? "einv-cli-gst-bad" : undefined}
            onChange={(e) => onCliGstin(e.target.value)}
          />
        </Field>
        {cliGstBad ? (
          <WarnNote id="einv-cli-gst-bad" text={t("einv.gstBad")} />
        ) : null}
        <Field label={t("einv.cliAddr")} htmlFor="einv-cli-addr">
          <Textarea
            id="einv-cli-addr"
            className={areaCls}
            rows={2}
            value={state.cli.addr}
            onChange={(e) => setCli("addr", e.target.value)}
          />
        </Field>
      </Section>

      {/* Invoice header */}
      <Section title={t("einv.invTitle")}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label={t("einv.invNo")} htmlFor="einv-no">
            <Input
              id="einv-no"
              className={inputCls}
              value={state.no}
              onChange={(e) => setTop("no", e.target.value)}
            />
          </Field>
          <Field label={t("einv.invDate")} htmlFor="einv-date">
            <Input
              id="einv-date"
              type="date"
              className={inputCls}
              value={state.date}
              onChange={(e) => setTop("date", e.target.value)}
            />
          </Field>
          <Field label={t("einv.invDue")} htmlFor="einv-due">
            <Input
              id="einv-due"
              type="date"
              className={inputCls}
              value={state.due}
              onChange={(e) => setTop("due", e.target.value)}
            />
          </Field>
        </div>
        <Field label={t("einv.curLabel")} htmlFor="einv-cur">
          <select
            id="einv-cur"
            className={selCls}
            value={state.cur}
            onChange={(e) => setCur(e.target.value)}
          >
            {INVOICE_CURRENCIES.map((cu) => (
              <option key={cu} value={cu}>
                {CURRENCY_SYMBOLS[cu]} {cu}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      {/* Items */}
      <section className="rounded-card border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">
            {t("einv.itemsTitle")}
            <span className="ml-2 text-xs font-normal text-muted-foreground tabular-nums">
              {state.items.length}/{EINV_MAX_ITEMS}
            </span>
          </h3>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-btn"
            disabled={state.items.length >= EINV_MAX_ITEMS}
            onClick={addItem}
          >
            <Plus className="size-4" aria-hidden="true" />
            {t("einv.itemAdd")}
          </Button>
        </div>

        {/* Column headers (desktop) */}
        <div
          className="mt-3 hidden gap-2 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:grid sm:grid-cols-[minmax(0,1fr)_5.5rem_4rem_5.5rem_4.5rem_2.75rem]"
          aria-hidden="true"
        >
          <span className="min-w-0 truncate">{t("einv.colDesc")}</span>
          <span className="truncate">{t("einv.colHsn")}</span>
          <span className="truncate">{t("einv.colQty")}</span>
          <span className="truncate">{t("einv.colRate")}</span>
          <span className="truncate">{t("einv.colGst")}</span>
          <span />
        </div>

        <ul className="mt-1 flex flex-col gap-2 sm:mt-2">
          {state.items.map((it, idx) => (
            <li
              key={idx}
              className="grid min-w-0 grid-cols-2 gap-2 rounded-md border border-border/70 bg-background p-2 sm:grid-cols-[minmax(0,1fr)_5.5rem_4rem_5.5rem_4.5rem_2.75rem] sm:items-center sm:border-0 sm:p-1"
            >
              <div className="col-span-2 min-w-0 sm:col-span-1">
                <Label className="sr-only sm:hidden" htmlFor={`einv-it-${idx}-d`}>
                  {t("einv.itemRow", { count: idx + 1 })} — {t("einv.colDesc")}
                </Label>
                <Input
                  id={`einv-it-${idx}-d`}
                  className="min-h-10 h-10"
                  value={it.d}
                  data-idx={idx}
                  data-k="d"
                  onChange={onItemInput}
                />
              </div>
              <div className="min-w-0">
                <Label className="sr-only sm:hidden" htmlFor={`einv-it-${idx}-h`}>
                  {t("einv.itemRow", { count: idx + 1 })} — {t("einv.colHsn")}
                </Label>
                <Input
                  id={`einv-it-${idx}-h`}
                  className="min-h-10 h-10 font-mono"
                  inputMode="numeric"
                  value={it.h}
                  data-idx={idx}
                  data-k="h"
                  onChange={onItemInput}
                />
              </div>
              <div className="min-w-0">
                <Label className="sr-only sm:hidden" htmlFor={`einv-it-${idx}-q`}>
                  {t("einv.itemRow", { count: idx + 1 })} — {t("einv.colQty")}
                </Label>
                <Input
                  id={`einv-it-${idx}-q`}
                  className="min-h-10 h-10 tabular-nums"
                  inputMode="decimal"
                  value={it.q}
                  data-idx={idx}
                  data-k="q"
                  onChange={onItemInput}
                />
              </div>
              <div className="min-w-0">
                <Label className="sr-only sm:hidden" htmlFor={`einv-it-${idx}-r`}>
                  {t("einv.itemRow", { count: idx + 1 })} — {t("einv.colRate")}
                </Label>
                <Input
                  id={`einv-it-${idx}-r`}
                  className="min-h-10 h-10 tabular-nums"
                  inputMode="decimal"
                  value={it.r}
                  data-idx={idx}
                  data-k="r"
                  onChange={onItemInput}
                />
              </div>
              <div className="min-w-0">
                <Label className="sr-only sm:hidden" htmlFor={`einv-it-${idx}-g`}>
                  {t("einv.itemRow", { count: idx + 1 })} — {t("einv.colGst")}
                </Label>
                <Input
                  id={`einv-it-${idx}-g`}
                  className="min-h-10 h-10 tabular-nums"
                  inputMode="decimal"
                  value={it.g}
                  data-idx={idx}
                  data-k="g"
                  onChange={onItemInput}
                />
              </div>
              <div className="flex items-center justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-9 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => removeItem(idx)}
                  aria-label={t("einv.itemRemove")}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
        {state.items.length >= EINV_MAX_ITEMS ? (
          <p className="mt-2 text-xs text-muted-foreground">{t("einv.itemsMax")}</p>
        ) : null}
      </section>

      {/* Discount / round-off / advance */}
      <Section title={t("einv.adjTitle")}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <Field label={t("einv.discLabel")} htmlFor="einv-dmode">
            <select
              id="einv-dmode"
              className={selCls}
              value={state.dMode}
              onChange={(e) => setDMode(e.target.value)}
            >
              <option value="%">{t("einv.discPct")}</option>
              <option value="f">{t("einv.discFlat")}</option>
            </select>
          </Field>
          <Field label={t("einv.discValue")} htmlFor="einv-d">
            <Input
              id="einv-d"
              className={`${inputCls} tabular-nums`}
              inputMode="decimal"
              value={state.d}
              onChange={(e) => setTop("d", e.target.value)}
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-6">
          <div className="flex min-w-0 items-center gap-2">
            <Checkbox
              id="einv-ro"
              checked={state.ro}
              onCheckedChange={(v) => onRoundOff(v === true)}
            />
            <Label htmlFor="einv-ro" className="text-sm text-foreground">
              {t("einv.roundOff")}
            </Label>
          </div>
          <Field label={t("einv.advance")} htmlFor="einv-adv">
            <Input
              id="einv-adv"
              className={`${inputCls} w-40 tabular-nums`}
              inputMode="decimal"
              value={state.adv}
              onChange={(e) => setTop("adv", e.target.value)}
            />
          </Field>
        </div>
      </Section>

      {/* Owning surface's context notes, if any. */}
      {notes && notes.length > 0 ? (
        <ul className="rounded-card border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <span className="sr-only">{t("einv.notesLabel")}</span>
          {notes.map((line, i) => (
            <li key={i} className="min-w-0 break-words">
              • {line}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
