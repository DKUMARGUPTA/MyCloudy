import { db } from "@/lib/db";
import { PRO_PLANS } from "@/lib/billing/plans";

/**
 * Reports engine (R27) — every report is derived from the journal lines
 * (the double-entry source of truth), never from Payments directly. All
 * amounts are INR minor units (paise) — the books' base currency.
 */

export interface AccountBalanceRow {
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
  subtype: string;
  debit: number;
  credit: number;
  /** Natural-direction balance: assets/expenses → debit−credit,
   * liabilities/equity/revenue → credit−debit. */
  balance: number;
}

async function balancesBetween(from?: Date, to?: Date): Promise<AccountBalanceRow[]> {
  const entries = await db.journalEntry.findMany({
    where: {
      ...(to ? { date: { lt: to } } : {}),
      ...(from ? { date: { gte: from } } : {}),
    },
    select: {
      lines: {
        select: {
          debit: true,
          credit: true,
          account: {
            select: { code: true, name: true, type: true, subtype: true },
          },
        },
      },
    },
  });

  const map = new Map<string, AccountBalanceRow>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      const { code, name, type, subtype } = line.account;
      let row = map.get(code);
      if (!row) {
        row = {
          code,
          name,
          type: type as AccountBalanceRow["type"],
          subtype,
          debit: 0,
          credit: 0,
          balance: 0,
        };
        map.set(code, row);
      }
      row.debit += line.debit;
      row.credit += line.credit;
    }
  }

  const rows = [...map.values()].map((row) => {
    const naturalDebit = row.type === "asset" || row.type === "expense";
    return {
      ...row,
      balance: naturalDebit ? row.debit - row.credit : row.credit - row.debit,
    };
  });
  rows.sort((a, b) => a.code.localeCompare(b.code));
  return rows;
}

/* ------------------------------------------------------------------ */
/* Trial balance                                                       */
/* ------------------------------------------------------------------ */

export interface TrialBalanceReport {
  accounts: Array<AccountBalanceRow & { tbDebit: number; tbCredit: number }>;
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
}

export async function trialBalance(from?: Date, to?: Date): Promise<TrialBalanceReport> {
  const rows = await balancesBetween(from, to);
  const accounts = rows.map((row) => ({
    ...row,
    /* Trial balance shows each account on its balancing side. */
    tbDebit: row.debit - row.credit > 0 ? row.debit - row.credit : 0,
    tbCredit: row.credit - row.debit > 0 ? row.credit - row.debit : 0,
  }));
  const totalDebit = accounts.reduce((s, a) => s + a.tbDebit, 0);
  const totalCredit = accounts.reduce((s, a) => s + a.tbCredit, 0);
  return { accounts, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
}

/* ------------------------------------------------------------------ */
/* Profit & Loss                                                       */
/* ------------------------------------------------------------------ */

export interface PnlReport {
  revenue: Array<{ code: string; name: string; amount: number }>;
  expenses: Array<{ code: string; name: string; amount: number }>;
  totalRevenue: number;
  totalExpenses: number;
  netProfit: number;
}

export async function profitAndLoss(from: Date, to: Date): Promise<PnlReport> {
  const rows = await balancesBetween(from, to);
  const revenue = rows
    .filter((r) => r.type === "revenue")
    .map((r) => ({ code: r.code, name: r.name, amount: r.balance }));
  const expenses = rows
    .filter((r) => r.type === "expense")
    .map((r) => ({ code: r.code, name: r.name, amount: r.balance }));
  const totalRevenue = revenue.reduce((s, r) => s + r.amount, 0);
  const totalExpenses = expenses.reduce((s, r) => s + r.amount, 0);
  return {
    revenue,
    expenses,
    totalRevenue,
    totalExpenses,
    netProfit: totalRevenue - totalExpenses,
  };
}

/* ------------------------------------------------------------------ */
/* Balance sheet (as of a date)                                        */
/* ------------------------------------------------------------------ */

export interface BalanceSheetReport {
  assets: Array<{ code: string; name: string; amount: number }>;
  liabilities: Array<{ code: string; name: string; amount: number }>;
  equity: Array<{ code: string; name: string; amount: number }>;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  /** Net income of all time up to the as-of date (rolls into equity). */
  netIncomeToDate: number;
  balanced: boolean;
}

export async function balanceSheet(asOf: Date): Promise<BalanceSheetReport> {
  const rows = await balancesBetween(undefined, asOf);
  const assets = rows
    .filter((r) => r.type === "asset")
    .map((r) => ({ code: r.code, name: r.name, amount: r.balance }));
  const liabilities = rows
    .filter((r) => r.type === "liability")
    .map((r) => ({ code: r.code, name: r.name, amount: r.balance }));
  const equityAccounts = rows
    .filter((r) => r.type === "equity")
    .map((r) => ({ code: r.code, name: r.name, amount: r.balance }));
  const revenueTotal = rows
    .filter((r) => r.type === "revenue")
    .reduce((s, r) => s + r.balance, 0);
  const expenseTotal = rows
    .filter((r) => r.type === "expense")
    .reduce((s, r) => s + r.balance, 0);
  const netIncomeToDate = revenueTotal - expenseTotal;

  const totalAssets = assets.reduce((s, a) => s + a.amount, 0);
  const totalLiabilities = liabilities.reduce((s, l) => s + l.amount, 0);
  const totalEquity =
    equityAccounts.reduce((s, e) => s + e.amount, 0) + netIncomeToDate;

  return {
    assets,
    liabilities,
    equity: equityAccounts,
    totalAssets,
    totalLiabilities,
    totalEquity,
    netIncomeToDate,
    balanced: totalAssets === totalLiabilities + totalEquity,
  };
}

/* ------------------------------------------------------------------ */
/* GST summary (GSTR-1 style, invoice-derived)                        */
/* ------------------------------------------------------------------ */

export interface GstReport {
  invoices: Array<{
    invoiceNo: string;
    issuedAt: string;
    customerEmail: string;
    customerGstin: string | null;
    taxType: string;
    taxableAmount: number;
    taxAmount: number;
    totalAmount: number;
    currency: string;
    isB2b: boolean;
  }>;
  totals: {
    taxableInr: number;
    cgst: number;
    sgst: number;
    igst: number;
    exportTaxableUsd: number;
    domesticInvoices: number;
    exportInvoices: number;
    b2bInvoices: number;
    b2cInvoices: number;
  };
}

export async function gstSummary(from: Date, to: Date): Promise<GstReport> {
  const invoices = await db.invoice.findMany({
    where: { issuedAt: { gte: from, lt: to } },
    orderBy: { issuedAt: "desc" },
  });

  const totals = {
    taxableInr: 0,
    cgst: 0,
    sgst: 0,
    igst: 0,
    exportTaxableUsd: 0,
    domesticInvoices: 0,
    exportInvoices: 0,
    b2bInvoices: 0,
    b2cInvoices: 0,
  };

  for (const inv of invoices) {
    const isB2b = Boolean(inv.customerGstin);
    if (isB2b) totals.b2bInvoices += 1;
    else totals.b2cInvoices += 1;

    if (inv.currency !== "INR") {
      totals.exportInvoices += 1;
      totals.exportTaxableUsd += inv.taxableAmount;
      continue;
    }
    totals.domesticInvoices += 1;
    totals.taxableInr += inv.taxableAmount;
    if (inv.taxType === "igst") {
      totals.igst += inv.taxAmount;
    } else {
      totals.cgst += Math.round(inv.taxAmount / 2);
      totals.sgst += inv.taxAmount - Math.round(inv.taxAmount / 2);
    }
  }

  return {
    invoices: invoices.map((inv) => ({
      invoiceNo: inv.invoiceNo,
      issuedAt: inv.issuedAt.toISOString(),
      customerEmail: inv.customerEmail,
      customerGstin: inv.customerGstin,
      taxType: inv.taxType,
      taxableAmount: inv.taxableAmount,
      taxAmount: inv.taxAmount,
      totalAmount: inv.totalAmount,
      currency: inv.currency,
      isB2b: Boolean(inv.customerGstin),
    })),
    totals,
  };
}

/* ------------------------------------------------------------------ */
/* Overview metrics (dashboard)                                        */
/* ------------------------------------------------------------------ */

export interface OverviewMetrics {
  cashCollectedInr: number;
  cashCollectedUsd: number;
  paidPayments: number;
  refundedPayments: number;
  recognizedRevenue: number;
  deferredBalance: number;
  gstPayable: number;
  gatewayClearing: number;
  mrrInr: number;
  mrrUsd: number;
  activeSubscriptions: number;
  proUsers: number;
  entryCount: number;
  lastEntryAt: string | null;
}

/** Balance of a single account (natural direction), all-time. */
async function accountBalance(code: string): Promise<number> {
  const lines = await db.journalLine.findMany({
    where: { account: { code } },
    select: { debit: true, credit: true, account: { select: { type: true } } },
  });
  const type = lines[0]?.account.type;
  const debit = lines.reduce((s, l) => s + l.debit, 0);
  const credit = lines.reduce((s, l) => s + l.credit, 0);
  return type === "asset" || type === "expense" ? debit - credit : credit - debit;
}

export async function overviewMetrics(): Promise<OverviewMetrics> {
  const [
    paidInr,
    paidUsd,
    refundedCount,
    recognized,
    deferred,
    gstPayable,
    clearing,
    entryCount,
    lastEntry,
    activeSubs,
    proUsers,
  ] = await Promise.all([
    db.payment.aggregate({
      where: { status: "paid", currency: "INR" },
      _sum: { amount: true },
    }),
    db.payment.aggregate({
      where: { status: "paid", currency: "USD" },
      _sum: { amount: true },
    }),
    db.payment.count({ where: { status: "refunded" } }),
    accountBalance("4100"),
    accountBalance("2200"),
    accountBalance("2100"),
    accountBalance("1200"),
    db.journalEntry.count(),
    db.journalEntry.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    db.subscription.findMany({
      where: { status: "active", periodEnd: { gt: new Date() } },
      select: { plan: true },
    }),
    db.user.count({ where: { plan: "pro", deletedAt: null } }),
  ]);

  let mrrInr = 0;
  let mrrUsd = 0;
  for (const sub of activeSubs) {
    if (sub.plan === "pro_monthly") {
      mrrInr += PRO_PLANS.pro_monthly.amountInrMinor;
      mrrUsd += PRO_PLANS.pro_monthly.amountUsdMinor;
    } else if (sub.plan === "pro_yearly") {
      mrrInr += Math.round(PRO_PLANS.pro_yearly.amountInrMinor / 12);
      mrrUsd += Math.round(PRO_PLANS.pro_yearly.amountUsdMinor / 12);
    }
  }

  return {
    cashCollectedInr: paidInr._sum.amount ?? 0,
    cashCollectedUsd: paidUsd._sum.amount ?? 0,
    paidPayments: await db.payment.count({ where: { status: "paid" } }),
    refundedPayments: refundedCount,
    recognizedRevenue: recognized,
    deferredBalance: deferred,
    gstPayable: gstPayable,
    gatewayClearing: clearing,
    mrrInr,
    mrrUsd,
    activeSubscriptions: activeSubs.length,
    proUsers,
    entryCount,
    lastEntryAt: lastEntry ? lastEntry.createdAt.toISOString() : null,
  };
}
