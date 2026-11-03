import { db } from "@/lib/db";

/**
 * Accounting chart (R27) — the seeded double-entry chart of accounts.
 *
 * Codes are stable, human/accountant-facing keys (1000=assets …
 * 5000=expenses). The seeding is idempotent: every account is matched on
 * its unique `code`, so re-running the seed never duplicates rows and
 * never clobbers admin-added accounts.
 *
 * The books are kept in INR minor units (paise) — the India business
 * base currency. USD payments post converted (rate from SiteSetting
 * `acct.usdToInr`, default 83.00) with the original USD amount noted in
 * the memo, the standard treatment for an INR-books SaaS. See
 * docs/rules/17-ACCOUNTING.md.
 */

export const ACCOUNT_CODES = {
  gatewayClearing: "1200",
  gstPayable: "2100",
  deferredRevenue: "2200",
  ownersCapital: "3100",
  retainedEarnings: "3200",
  subscriptionRevenue: "4100",
  otherIncome: "4200",
  gatewayFees: "5100",
  hosting: "5200",
  aiCosts: "5300",
  marketing: "5400",
  software: "5500",
  miscExpense: "5900",
} as const;

export type AccountCode = (typeof ACCOUNT_CODES)[keyof typeof ACCOUNT_CODES];

interface SeedAccount {
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
  subtype: string;
}

export const DEFAULT_CHART: SeedAccount[] = [
  { code: "1200", name: "Payment Gateway Clearing", type: "asset", subtype: "current_asset" },
  { code: "2100", name: "GST Payable", type: "liability", subtype: "tax_payable" },
  { code: "2200", name: "Deferred Revenue", type: "liability", subtype: "current_liability" },
  { code: "3100", name: "Owner's Capital", type: "equity", subtype: "equity" },
  { code: "3200", name: "Retained Earnings", type: "equity", subtype: "equity" },
  { code: "4100", name: "Subscription Revenue — Pro", type: "revenue", subtype: "operating_revenue" },
  { code: "4200", name: "Other Income", type: "revenue", subtype: "operating_revenue" },
  { code: "5100", name: "Payment Gateway Fees", type: "expense", subtype: "operating_expense" },
  { code: "5200", name: "Hosting & Infrastructure", type: "expense", subtype: "operating_expense" },
  { code: "5300", name: "AI / API Costs", type: "expense", subtype: "operating_expense" },
  { code: "5400", name: "Marketing", type: "expense", subtype: "operating_expense" },
  { code: "5500", name: "Software & Subscriptions", type: "expense", subtype: "operating_expense" },
  { code: "5900", name: "Miscellaneous Expenses", type: "expense", subtype: "operating_expense" },
];

/** Idempotent chart seed — safe to call on every sync/API touch. */
export async function ensureChartSeeded(): Promise<void> {
  const existing = await db.account.count();
  if (existing > 0) return;
  await db.account.createMany({
    data: DEFAULT_CHART.map((a) => ({ ...a, isSystem: true })),
  });
}

/** Resolve the id of a chart account by code (throws if the chart was
 * never seeded — callers run ensureChartSeeded first). */
export async function accountIdByCode(code: string): Promise<string> {
  const account = await db.account.findUnique({ where: { code } });
  if (!account) throw new Error(`account ${code} missing — chart not seeded`);
  return account.id;
}

/* ------------------------------------------------------------------ */
/* GST / FX configuration (SiteSetting-driven, India defaults)         */
/* ------------------------------------------------------------------ */

export interface AccountingConfig {
  /** GST rate in percent — SaaS standard 18. */
  gstRatePercent: number;
  /** INR prices are tax-inclusive (B2C convention). */
  taxInclusive: boolean;
  /** Domestic INR tax split: "cgst_sgst" (intra-state) or "igst". */
  inrTaxType: "cgst_sgst" | "igst";
  /** USD→INR conversion for the INR books (export sales). */
  usdToInr: number;
}

const CONFIG_KEYS = {
  gstRatePercent: "acct.gstRatePercent",
  taxInclusive: "acct.taxInclusive",
  inrTaxType: "acct.inrTaxType",
  usdToInr: "acct.usdToInr",
} as const;

export const ACCOUNTING_CONFIG_DEFAULTS: AccountingConfig = {
  gstRatePercent: 18,
  taxInclusive: true,
  inrTaxType: "cgst_sgst",
  usdToInr: 83,
};

/** Read the accounting config from SiteSetting with defaults. */
export async function getAccountingConfig(): Promise<AccountingConfig> {
  try {
    const rows = await db.siteSetting.findMany({
      where: { key: { in: Object.values(CONFIG_KEYS) } },
    });
    const map = new Map(rows.map((r) => [r.key, r.valueJson]));
    const num = (key: string, fallback: number): number => {
      const raw = map.get(key);
      const parsed = raw ? Number(JSON.parse(raw)) : NaN;
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
    };
    const taxType = map.get(CONFIG_KEYS.inrTaxType);
    return {
      gstRatePercent: Math.min(num(CONFIG_KEYS.gstRatePercent, 18), 28),
      taxInclusive: map.get(CONFIG_KEYS.taxInclusive)
        ? JSON.parse(map.get(CONFIG_KEYS.taxInclusive) as string) !== "0"
        : true,
      inrTaxType: JSON.parse(taxType ?? '""') === "igst" ? "igst" : "cgst_sgst",
      usdToInr: Math.max(num(CONFIG_KEYS.usdToInr, 83), 1),
    };
  } catch {
    return { ...ACCOUNTING_CONFIG_DEFAULTS };
  }
}

/** Split a tax-inclusive INR total into taxable value + GST (minor units). */
export function splitInclusiveGst(
  totalMinor: number,
  ratePercent: number
): { taxable: number; tax: number } {
  const taxable = Math.round((totalMinor * 100) / (100 + ratePercent));
  return { taxable, tax: totalMinor - taxable };
}
