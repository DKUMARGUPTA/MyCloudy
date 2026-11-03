"use client";

/**
 * Accounting API client (R27) — typed fetchers for the admin accounting
 * console. Follows the auth-client pattern: JSON contract, typed results,
 * no throwing on expected errors.
 */

export interface AccountingMetrics {
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

export interface JournalLineDto {
  code: string;
  name: string;
  debit: number;
  credit: number;
  memo?: string | null;
}

export interface JournalEntryDto {
  id: string;
  entryNo: string;
  date: string;
  memo: string;
  source: string;
  sourceRef?: string | null;
  createdBy?: string | null;
  lines: JournalLineDto[];
}

export interface AccountDto {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  isSystem: boolean;
  debit: number;
  credit: number;
  balance: number;
}

export interface InvoiceDto {
  id: string;
  invoiceNo: string;
  issuedAt: string;
  customerEmail: string;
  customerName: string | null;
  customerGstin: string | null;
  itemCode: string;
  taxType: string;
  taxableAmount: number;
  taxAmount: number;
  totalAmount: number;
  currency: string;
  status: string;
}

export interface OverviewDto {
  metrics: AccountingMetrics;
  recentEntries: JournalEntryDto[];
}

export interface SyncResultDto {
  paymentsPosted: number;
  invoicesIssued: number;
  recognizedTotal: number;
  recognitionEntries: number;
  refundsPosted: number;
  invoicesVoided: number;
}

export interface TrialBalanceDto {
  accounts: Array<
    AccountDto & { tbDebit: number; tbCredit: number }
  >;
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
}

export interface PnlDto {
  revenue: Array<{ code: string; name: string; amount: number }>;
  expenses: Array<{ code: string; name: string; amount: number }>;
  totalRevenue: number;
  totalExpenses: number;
  netProfit: number;
}

export interface BalanceSheetDto {
  assets: Array<{ code: string; name: string; amount: number }>;
  liabilities: Array<{ code: string; name: string; amount: number }>;
  equity: Array<{ code: string; name: string; amount: number }>;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  netIncomeToDate: number;
  balanced: boolean;
}

export interface GstDto {
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

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const fetchOverview = () =>
  jsonFetch<OverviewDto>("/api/admin/accounting/overview");

export const fetchAccounts = () =>
  jsonFetch<{ accounts: AccountDto[] }>("/api/admin/accounting/accounts");

export const fetchJournal = (limit: number, offset: number) =>
  jsonFetch<{ total: number; entries: JournalEntryDto[] }>(
    `/api/admin/accounting/journal?limit=${limit}&offset=${offset}`
  );

export const fetchInvoices = (limit: number, offset: number) =>
  jsonFetch<{ total: number; invoices: InvoiceDto[] }>(
    `/api/admin/accounting/invoices?limit=${limit}&offset=${offset}`
  );

export const fetchReport = <T>(type: string, from: string, to: string) =>
  jsonFetch<T>(
    `/api/admin/accounting/reports?type=${type}&from=${from}&to=${to}`
  );

export async function runSync(): Promise<SyncResultDto | null> {
  try {
    const res = await fetch("/api/admin/accounting/sync", { method: "POST" });
    if (!res.ok) return null;
    const data = (await res.json()) as { result: SyncResultDto };
    return data.result;
  } catch {
    return null;
  }
}

export async function postManualEntry(body: {
  date: string;
  memo: string;
  lines: Array<{ code: string; debit?: number; credit?: number }>;
}): Promise<{ ok: boolean; error?: string; message?: string; entryNo?: string }> {
  try {
    const res = await fetch("/api/admin/accounting/journal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as {
      error?: string;
      message?: string;
      entryNo?: string;
    };
    return { ok: res.ok, ...data };
  } catch {
    return { ok: false, error: "server_error" };
  }
}
