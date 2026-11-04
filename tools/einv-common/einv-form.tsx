"use client";

/**
 * Shared e-invoice form (P12-EINVOICE) — the one form the
 * create-electronic-invoice and pdf-to-e-invoice surfaces render. Bilingual
 * labels via t(), money preview computed with the integer-minor-unit model,
 * and the same accessibility patterns as the create-invoice form
 * (44 px targets, aria-labels, role=alert issues list).
 */

import { Plus, Trash2, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/components/providers/locale-provider";
import { cn } from "@/lib/utils";
import {
  EINV_CURRENCIES,
  EINV_UNITS,
  lineKey,
  type EInvFormState,
  type EInvFormReport,
  type EInvComputed,
  type EInvPartyForm,
} from "./model";

const inputCls =
  "h-11 min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";
const selCls = inputCls;

const RATE_CHIPS = ["0", "5", "12", "18", "28", "19", "7"];

function moneyText(computed: EInvComputed, minor: number): string {
  const v = minor / 10 ** computed.decimals;
  return v.toLocaleString("en-IN", {
    minimumFractionDigits: computed.decimals,
    maximumFractionDigits: computed.decimals,
  });
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: "₹", EUR: "€", USD: "$", GBP: "£",
};

function currencySymbol(cur: string): string {
  return CURRENCY_SYMBOLS[cur] ?? "";
}

/* ------------------------------ parties ---------------------------- */

function PartyFields({
  idPrefix,
  labelKey,
  party,
  onChange,
}: {
  idPrefix: string;
  labelKey: string;
  party: EInvPartyForm;
  onChange: (next: EInvPartyForm) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const set = <K extends keyof EInvPartyForm>(key: K, value: EInvPartyForm[K]): void => {
    onChange({ ...party, [key]: value });
  };

  return (
    <fieldset className="flex flex-col gap-3 rounded-card border border-border bg-card p-4">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t(labelKey)}
      </legend>
      <div>
        <Label className="text-xs text-muted-foreground" htmlFor={`${idPrefix}-name`}>
          {t("einv.partyName")} *
        </Label>
        <Input
          id={`${idPrefix}-name`}
          className={cn(inputCls, "mt-1.5")}
          value={party.name}
          onChange={(e) => set("name", e.target.value)}
          maxLength={200}
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_128px]">
        <div>
          <Label className="text-xs text-muted-foreground" htmlFor={`${idPrefix}-tax`}>
            {t("einv.partyTaxId")}
          </Label>
          <Input
            id={`${idPrefix}-tax`}
            className={cn(inputCls, "mt-1.5")}
            value={party.taxId}
            onChange={(e) => set("taxId", e.target.value.toUpperCase())}
            placeholder={party.taxScheme === "VA" ? "DE123456789" : "27AAAPZ1234K1Z5"}
            maxLength={32}
          />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground" htmlFor={`${idPrefix}-scheme`}>
            {"\u00a0"}
          </Label>
          <select
            id={`${idPrefix}-scheme`}
            className={cn(selCls, "mt-1.5")}
            value={party.taxScheme}
            onChange={(e) => set("taxScheme", e.target.value === "VA" ? "VA" : "IN")}
          >
            <option value="IN">GSTIN</option>
            <option value="VA">VAT</option>
          </select>
        </div>
      </div>
      <div>
        <Label className="text-xs text-muted-foreground" htmlFor={`${idPrefix}-street`}>
          {t("einv.partyStreet")}
        </Label>
        <Input
          id={`${idPrefix}-street`}
          className={cn(inputCls, "mt-1.5")}
          value={party.street}
          onChange={(e) => set("street", e.target.value)}
          maxLength={160}
        />
      </div>
      <div>
        <Label className="text-xs text-muted-foreground" htmlFor={`${idPrefix}-street2`}>
          {t("einv.partyStreet2")}
        </Label>
        <Input
          id={`${idPrefix}-street2`}
          className={cn(inputCls, "mt-1.5")}
          value={party.street2}
          onChange={(e) => set("street2", e.target.value)}
          maxLength={160}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs text-muted-foreground" htmlFor={`${idPrefix}-city`}>
            {t("einv.partyCity")}
          </Label>
          <Input
            id={`${idPrefix}-city`}
            className={cn(inputCls, "mt-1.5")}
            value={party.city}
            onChange={(e) => set("city", e.target.value)}
            maxLength={80}
          />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground" htmlFor={`${idPrefix}-zip`}>
            {t("einv.partyZip")}
          </Label>
          <Input
            id={`${idPrefix}-zip`}
            className={cn(inputCls, "mt-1.5")}
            value={party.postcode}
            onChange={(e) => set("postcode", e.target.value)}
            maxLength={16}
          />
        </div>
      </div>
      <div className="grid grid-cols-[96px_1fr] gap-3">
        <div>
          <Label className="text-xs text-muted-foreground" htmlFor={`${idPrefix}-country`}>
            {t("einv.partyCountry")}
          </Label>
          <Input
            id={`${idPrefix}-country`}
            className={cn(inputCls, "mt-1.5 uppercase")}
            value={party.country}
            onChange={(e) => set("country", e.target.value.toUpperCase())}
            placeholder="IN"
            maxLength={2}
          />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground" htmlFor={`${idPrefix}-email`}>
            {t("einv.partyEmail")}
          </Label>
          <Input
            id={`${idPrefix}-email`}
            type="email"
            className={cn(inputCls, "mt-1.5")}
            value={party.email}
            onChange={(e) => set("email", e.target.value)}
            maxLength={120}
          />
        </div>
      </div>
    </fieldset>
  );
}

/* ------------------------------ the form --------------------------- */

export function EInvFormFields({
  form,
  computed,
  report,
  onForm,
}: {
  form: EInvFormState;
  computed: EInvComputed;
  report: EInvFormReport;
  onForm: (next: EInvFormState) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const set = <K extends keyof EInvFormState>(key: K, value: EInvFormState[K]): void => {
    onForm({ ...form, [key]: value });
  };
  const setLine = (i: number, key: keyof EInvFormState["lines"][number], value: string): void => {
    const lines = form.lines.map((l, idx) => (idx === i ? { ...l, [key]: value } : l));
    onForm({ ...form, lines });
  };

  const curKnown = EINV_CURRENCIES.includes(form.currency);
  const lineNet = (i: number): string => {
    const l = computed.lines.find((c) => c.index === i);
    return l === undefined ? "—" : moneyText(computed, l.net);
  };
  const badLines = new Set(report.lineIssues);

  return (
    <div className="flex flex-col gap-4">
      {/* Issues (role=alert, honest, never silent) */}
      {report.issues.length > 0 ? (
        <div
          role="alert"
          className="flex flex-col gap-1 rounded-card border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs leading-relaxed text-destructive"
        >
          {report.issues.map((issue) => (
            <p key={issue}>· {t(`einv.issue.${issue}`)}</p>
          ))}
        </div>
      ) : null}
      {report.warnings.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-card border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
          {report.warnings.map((w) => (
            <p key={w} className="flex items-start gap-1.5">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {t(`einv.warn.${w}`)}
            </p>
          ))}
        </div>
      ) : null}

      {/* Invoice meta */}
      <fieldset className="flex flex-col gap-3 rounded-card border border-border bg-card p-4">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("einv.metaTitle")}
        </legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label className="text-xs text-muted-foreground" htmlFor="einv-number">
              {t("einv.number")} *
            </Label>
            <Input
              id="einv-number"
              className={cn(inputCls, "mt-1.5")}
              value={form.number}
              onChange={(e) => set("number", e.target.value)}
              placeholder="INV-2026-001"
              maxLength={64}
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground" htmlFor="einv-type">
              {t("einv.docType")}
            </Label>
            <select
              id="einv-type"
              className={cn(selCls, "mt-1.5")}
              value={form.type}
              onChange={(e) => set("type", e.target.value as EInvFormState["type"])}
            >
              <option value="380">{t("einv.type380")}</option>
              <option value="381">{t("einv.type381")}</option>
              <option value="383">{t("einv.type383")}</option>
            </select>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground" htmlFor="einv-issue">
              {t("einv.issueDate")} *
            </Label>
            <Input
              id="einv-issue"
              type="date"
              className={cn(inputCls, "mt-1.5")}
              value={form.issue}
              onChange={(e) => set("issue", e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground" htmlFor="einv-due">
              {t("einv.dueDate")}
            </Label>
            <Input
              id="einv-due"
              type="date"
              className={cn(inputCls, "mt-1.5")}
              value={form.due}
              onChange={(e) => set("due", e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground" htmlFor="einv-currency">
              {t("einv.currency")} *
            </Label>
            <select
              id="einv-currency"
              className={cn(selCls, "mt-1.5")}
              value={curKnown ? form.currency : "other"}
              onChange={(e) =>
                set("currency", e.target.value === "other" ? "" : e.target.value)
              }
            >
              {EINV_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                  {currencySymbol(c) !== "" ? ` (${currencySymbol(c)})` : ""}
                </option>
              ))}
              <option value="other">{t("einv.currencyOther")}</option>
            </select>
          </div>
          {!curKnown ? (
            <div>
              <Label className="text-xs text-muted-foreground" htmlFor="einv-currency-x">
                {t("einv.currencyCode")}
              </Label>
              <Input
                id="einv-currency-x"
                className={cn(inputCls, "mt-1.5 uppercase")}
                value={form.currency}
                onChange={(e) => set("currency", e.target.value.toUpperCase())}
                placeholder="SEK"
                maxLength={3}
              />
            </div>
          ) : null}
        </div>
      </fieldset>

      {/* Parties */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <PartyFields
          idPrefix="einv-seller"
          labelKey="einv.seller"
          party={form.seller}
          onChange={(seller) => set("seller", seller)}
        />
        <PartyFields
          idPrefix="einv-buyer"
          labelKey="einv.buyer"
          party={form.buyer}
          onChange={(buyer) => set("buyer", buyer)}
        />
      </div>

      {/* Lines */}
      <fieldset className="flex flex-col gap-3 rounded-card border border-border bg-card p-4">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("einv.linesTitle")}
        </legend>
        <div className="flex flex-col gap-3">
          {form.lines.map((l, i) => (
            <div
              key={l.key}
              className={cn(
                "flex flex-col gap-2 rounded-md border p-3",
                badLines.has(i)
                  ? "border-destructive/40 bg-destructive/5"
                  : "border-border bg-background"
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="pt-1 text-[11px] font-semibold tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                <Input
                  className={inputCls}
                  value={l.desc}
                  onChange={(e) => setLine(i, "desc", e.target.value)}
                  placeholder={t("einv.lineDesc")}
                  aria-label={`${t("einv.lineDesc")} ${i + 1}`}
                  maxLength={300}
                />
                <button
                  type="button"
                  onClick={() =>
                    onForm({
                      ...form,
                      lines:
                        form.lines.length === 1
                          ? form.lines
                          : form.lines.filter((_, idx) => idx !== i),
                    })
                  }
                  aria-label={t("einv.removeLine")}
                  className="flex size-11 min-h-11 shrink-0 items-center justify-center rounded-md text-destructive transition-colors hover:bg-destructive/10 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div>
                  <Label className="text-[11px] text-muted-foreground" htmlFor={`einv-q-${i}`}>
                    {t("einv.qty")}
                  </Label>
                  <Input
                    id={`einv-q-${i}`}
                    type="number"
                    min="0"
                    step="any"
                    className={cn(inputCls, "mt-1")}
                    value={l.qty}
                    onChange={(e) => setLine(i, "qty", e.target.value)}
                    aria-label={`${t("einv.qty")} ${i + 1}`}
                  />
                </div>
                <div>
                  <Label className="text-[11px] text-muted-foreground" htmlFor={`einv-u-${i}`}>
                    {t("einv.unit")}
                  </Label>
                  <select
                    id={`einv-u-${i}`}
                    className={cn(selCls, "mt-1")}
                    value={l.unit}
                    onChange={(e) => setLine(i, "unit", e.target.value)}
                  >
                    {EINV_UNITS.map((u) => (
                      <option key={u.code} value={u.code}>
                        {t(u.key)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label className="text-[11px] text-muted-foreground" htmlFor={`einv-p-${i}`}>
                    {t("einv.price")}
                  </Label>
                  <Input
                    id={`einv-p-${i}`}
                    type="number"
                    min="0"
                    step="any"
                    className={cn(inputCls, "mt-1")}
                    value={l.price}
                    onChange={(e) => setLine(i, "price", e.target.value)}
                    aria-label={`${t("einv.price")} ${i + 1}`}
                  />
                </div>
                <div>
                  <Label className="text-[11px] text-muted-foreground" htmlFor={`einv-r-${i}`}>
                    {t("einv.rate")}
                  </Label>
                  <Input
                    id={`einv-r-${i}`}
                    type="number"
                    min="0"
                    max="100"
                    step="any"
                    className={cn(inputCls, "mt-1")}
                    value={l.rate}
                    onChange={(e) => setLine(i, "rate", e.target.value)}
                    aria-label={`${t("einv.rate")} ${i + 1}`}
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {RATE_CHIPS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setLine(i, "rate", r)}
                    className={cn(
                      "rounded-chip border px-2 py-0.5 text-[11px] transition-colors",
                      l.rate === r
                        ? "border-primary bg-primary/10 font-semibold text-primary"
                        : "border-border text-muted-foreground hover:bg-muted"
                    )}
                  >
                    {r}%
                  </button>
                ))}
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                  {t("einv.lineNet")}:{" "}
                  <span className="font-semibold text-foreground">{lineNet(i)}</span>
                </span>
              </div>
            </div>
          ))}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-11 min-h-11 w-full text-xs"
          onClick={() =>
            onForm({
              ...form,
              lines: [
                ...form.lines,
                { key: lineKey(), desc: "", qty: "1", unit: "C62", price: "", rate: form.lines.at(-1)?.rate ?? "18" },
              ],
            })
          }
        >
          <Plus className="size-4" aria-hidden="true" />
          {t("einv.addLine")}
        </Button>
      </fieldset>

      {/* Payment + note */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <fieldset className="flex flex-col gap-3 rounded-card border border-border bg-card p-4">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("einv.paymentTitle")}
          </legend>
          <div>
            <Label className="text-xs text-muted-foreground" htmlFor="einv-iban">
              {t("einv.iban")}
            </Label>
            <Input
              id="einv-iban"
              className={cn(inputCls, "mt-1.5 uppercase")}
              value={form.iban}
              onChange={(e) => set("iban", e.target.value.toUpperCase())}
              placeholder="DE89 3704 0044 0532 0130 00"
              maxLength={42}
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground" htmlFor="einv-accname">
              {t("einv.accountName")}
            </Label>
            <Input
              id="einv-accname"
              className={cn(inputCls, "mt-1.5")}
              value={form.accountName}
              onChange={(e) => set("accountName", e.target.value)}
              maxLength={80}
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground" htmlFor="einv-upi">
              {t("einv.upi")}
            </Label>
            <Input
              id="einv-upi"
              className={cn(inputCls, "mt-1.5")}
              value={form.upi}
              onChange={(e) => set("upi", e.target.value)}
              placeholder="name@upi"
              maxLength={80}
            />
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-3 rounded-card border border-border bg-card p-4">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("einv.noteTitle")}
          </legend>
          <Textarea
            className="min-h-24"
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            placeholder={t("einv.notePh")}
            maxLength={600}
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("einv.noteHint")}
          </p>
        </fieldset>
      </div>
    </div>
  );
}

/* ------------------------------ totals ----------------------------- */

export function EInvTotalsCard({
  computed,
  currency,
}: {
  computed: EInvComputed;
  currency: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const symbol = currencySymbol(currency);
  const money = (m: number): string =>
    `${symbol}${moneyText(computed, m)}${symbol === "" ? ` ${currency}` : ""}`;

  return (
    <div className="flex flex-col gap-2 rounded-card border border-border bg-card p-4">
      <p className="text-xs font-semibold text-foreground">{t("einv.totalsTitle")}</p>
      <dl className="flex flex-col gap-1.5 text-xs">
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">{t("einv.subtotal")}</dt>
          <dd className="tabular-nums">{money(computed.lineTotal)}</dd>
        </div>
        {computed.taxes.map((tax) => (
          <div key={tax.rate} className="flex items-center justify-between">
            <dt className="text-muted-foreground">
              {t("einv.taxRate", { rate: tax.rate })}
            </dt>
            <dd className="tabular-nums">{money(tax.tax)}</dd>
          </div>
        ))}
        <div className="flex items-center justify-between border-t border-border pt-1.5">
          <dt className="font-semibold">{t("einv.grand")}</dt>
          <dd className="text-sm font-semibold tabular-nums text-primary">
            {money(computed.grand)}
          </dd>
        </div>
      </dl>
      {computed.taxes.length > 1 ? (
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th scope="col" className="py-1 font-medium">{t("einv.rate")}</th>
              <th scope="col" className="py-1 text-right font-medium">{t("einv.base")}</th>
              <th scope="col" className="py-1 text-right font-medium">{t("einv.tax")}</th>
            </tr>
          </thead>
          <tbody>
            {computed.taxes.map((tax) => (
              <tr key={tax.rate} className="border-t border-border/60">
                <td className="py-1 font-semibold tabular-nums">{tax.rate}%</td>
                <td className="py-1 text-right tabular-nums">{money(tax.basis)}</td>
                <td className="py-1 text-right tabular-nums">{money(tax.tax)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
