import { db } from "@/lib/db";
import {
  ACCOUNT_CODES,
  accountIdByCode,
  getAccountingConfig,
  splitInclusiveGst,
} from "./chart";

/**
 * Posting engine (R27) — every journal entry funnels through postEntry,
 * which enforces the double-entry invariants BEFORE anything hits the DB:
 *
 *   1. ≥ 2 lines
 *   2. every line is exactly one of debit/credit (never both, never zero)
 *   3. Σ debits == Σ credits (minor units, exact integer match)
 *
 * Entries are immutable once posted: corrections are new reversing
 * entries (standard bookkeeping practice; keeps the audit trail honest).
 *
 * Books base currency: INR minor units (paise). USD payments convert at
 * the configured rate; the original amount rides in the memo.
 */

export interface PostLineInput {
  /** Chart code, e.g. "1200". */
  code: string;
  debit?: number;
  credit?: number;
  memo?: string;
}

export interface PostEntryInput {
  date: Date;
  memo: string;
  source: "manual" | "payment" | "refund" | "recognition" | "adjustment" | "opening";
  sourceRef?: string;
  createdBy?: string;
  lines: PostLineInput[];
}

export class PostingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostingError";
  }
}

/** Next sequential human entry number: JE-000001 … */
async function nextEntryNo(): Promise<string> {
  const count = await db.journalEntry.count();
  return `JE-${String(count + 1).padStart(6, "0")}`;
}

export async function postEntry(input: PostEntryInput) {
  /* ---- Invariant validation ------------------------------------- */
  if (!input.lines || input.lines.length < 2) {
    throw new PostingError("An entry needs at least two lines");
  }
  let sumDebit = 0;
  let sumCredit = 0;
  for (const line of input.lines) {
    const debit = Math.round(line.debit ?? 0);
    const credit = Math.round(line.credit ?? 0);
    if (debit < 0 || credit < 0) {
      throw new PostingError("Amounts cannot be negative");
    }
    if (debit > 0 && credit > 0) {
      throw new PostingError("A line cannot be both debit and credit");
    }
    if (debit === 0 && credit === 0) {
      throw new PostingError("A line needs a debit or a credit amount");
    }
    sumDebit += debit;
    sumCredit += credit;
  }
  if (sumDebit !== sumCredit) {
    throw new PostingError(
      `Entry is not balanced: debits ${sumDebit} ≠ credits ${sumCredit}`
    );
  }

  /* ---- Resolve accounts (throws when the chart is not seeded) ----- */
  const codeToId = new Map<string, string>();
  for (const line of input.lines) {
    if (!codeToId.has(line.code)) {
      codeToId.set(line.code, await accountIdByCode(line.code));
    }
  }

  /* ---- Insert (entry + lines together) ---------------------------- */
  return db.journalEntry.create({
    data: {
      entryNo: await nextEntryNo(),
      date: input.date,
      memo: input.memo.slice(0, 300),
      source: input.source,
      sourceRef: input.sourceRef?.slice(0, 120),
      createdBy: input.createdBy?.slice(0, 120),
      lines: {
        create: input.lines.map((line) => ({
          accountId: codeToId.get(line.code) as string,
          debit: Math.round(line.debit ?? 0),
          credit: Math.round(line.credit ?? 0),
          memo: line.memo?.slice(0, 200),
        })),
      },
    },
    include: { lines: { include: { account: true } } },
  });
}

/** True when an entry with this source+sourceRef already exists (sync
 * idempotency). An optional sourceKind discriminator lets one payment own
 * several entries (payment vs recognition vs refund) without collisions. */
export async function entryExists(
  source: string,
  sourceRef: string
): Promise<boolean> {
  const found = await db.journalEntry.findFirst({
    where: { source, sourceRef },
    select: { id: true },
  });
  return found !== null;
}

/* ------------------------------------------------------------------ */
/* Payment → journal posting                                           */
/* ------------------------------------------------------------------ */

export interface PaymentPostingResult {
  taxable: number;
  tax: number;
  booksAmount: number;
  taxType: "cgst_sgst" | "igst" | "export";
  currency: string;
}

/**
 * Post the receipt entry for a PAID payment:
 *
 *   INR (tax-inclusive 18%):            USD (zero-rated export):
 *     Dr 1200 Gateway Clearing  total      Dr 1200 Gateway Clearing  total₹
 *     Cr 2200 Deferred Revenue  taxable    Cr 2200 Deferred Revenue  total₹
 *     Cr 2100 GST Payable       tax
 *
 * Monthly plans earn out immediately (recognition entry posted by the
 * caller); yearly plans sit in Deferred Revenue and release 1/12 per
 * month via the recognition sweep.
 */
export async function postPaymentEntry(payment: {
  id: string;
  amount: number;
  currency: string;
  createdAt: Date;
}): Promise<PaymentPostingResult> {
  if (await entryExists("payment", payment.id)) {
    /* Already posted — return the split for the caller's records. */
    const cfg = await getAccountingConfig();
    const { taxable, tax } = splitInclusiveGst(payment.amount, cfg.gstRatePercent);
    return {
      taxable,
      tax,
      booksAmount: payment.amount,
      taxType: payment.currency === "INR" ? cfg.inrTaxType : "export",
      currency: payment.currency,
    };
  }

  const cfg = await getAccountingConfig();

  if (payment.currency === "INR") {
    const { taxable, tax } = payment.amount > 0
      ? splitInclusiveGst(payment.amount, cfg.gstRatePercent)
      : { taxable: 0, tax: 0 };
    await postEntry({
      date: payment.createdAt,
      memo: `Pro subscription payment received (₹${(payment.amount / 100).toFixed(2)} incl. GST)`,
      source: "payment",
      sourceRef: payment.id,
      lines: [
        { code: ACCOUNT_CODES.gatewayClearing, debit: payment.amount },
        { code: ACCOUNT_CODES.deferredRevenue, credit: taxable },
        { code: ACCOUNT_CODES.gstPayable, credit: tax },
      ],
    });
    return { taxable, tax, booksAmount: payment.amount, taxType: cfg.inrTaxType, currency: "INR" };
  }

  /* USD export: convert to INR books, no GST. */
  const booksAmount = Math.round(payment.amount * cfg.usdToInr);
  await postEntry({
    date: payment.createdAt,
    memo: `Pro subscription payment received ($${(payment.amount / 100).toFixed(2)} export @ ₹${cfg.usdToInr}/$ → ₹${(booksAmount / 100).toFixed(2)})`,
    source: "payment",
    sourceRef: payment.id,
    lines: [
      { code: ACCOUNT_CODES.gatewayClearing, debit: booksAmount },
      { code: ACCOUNT_CODES.deferredRevenue, credit: booksAmount },
    ],
  });
  return { taxable: booksAmount, tax: 0, booksAmount, taxType: "export", currency: "USD" };
}

/**
 * Recognize deferred revenue for one payment. Monthly plans and 7-day
 * passes (R28): the whole taxable value moves at payment time — a pass
 * never spans a month boundary. Yearly plans: 1/12 per elapsed calendar
 * month — the sweep posts the cumulative delta, so a lapsed sweep run
 * catches up automatically and re-runs never double-post.
 */
export async function recognizeForPayment(
  payment: { id: string; amount: number; currency: string; createdAt: Date },
  plan: "pro_monthly" | "pro_yearly" | "pro_week"
): Promise<number> {
  const cfg = await getAccountingConfig();
  const { taxable } = payment.currency === "INR"
    ? splitInclusiveGst(payment.amount, cfg.gstRatePercent)
    : { taxable: Math.round(payment.amount * cfg.usdToInr) };

  /* How much of the deferred value should be earned by now? */
  const monthsElapsed =
    plan === "pro_monthly" || plan === "pro_week"
      ? 12
      : wholeMonthsBetween(payment.createdAt, new Date());
  const target = Math.min(taxable, Math.round((taxable * monthsElapsed) / 12));

  /* How much was already earned (recognition entries for this payment)? */
  const prior = await db.journalEntry.findMany({
    where: { source: "recognition", sourceRef: payment.id },
    select: { lines: { select: { debit: true } } },
  });
  /* Recognition lines debit Deferred Revenue — sum of those debits. */
  const already = prior.reduce(
    (sum, entry) => sum + entry.lines.reduce((s, l) => s + l.debit, 0),
    0
  );

  const delta = target - already;
  if (delta <= 0) return 0;

  await postEntry({
    date: new Date(),
    memo: `Revenue recognition — ${
      plan === "pro_monthly"
        ? "monthly plan"
        : plan === "pro_week"
          ? "7-day pass"
          : `yearly plan, month ${Math.min(monthsElapsed, 12)}/12`
    } (${payment.id.slice(0, 8)})`,
    source: "recognition",
    sourceRef: payment.id,
    lines: [
      { code: ACCOUNT_CODES.deferredRevenue, debit: delta },
      { code: ACCOUNT_CODES.subscriptionRevenue, credit: delta },
    ],
  });
  return delta;
}

/**
 * Post the reversing entries for a refunded payment (receipt + any
 * recognition already posted). Idempotent on source "refund".
 */
export async function postRefundEntry(payment: {
  id: string;
  amount: number;
  currency: string;
  createdAt: Date;
}): Promise<boolean> {
  if (await entryExists("refund", payment.id)) return false;

  const original = await db.journalEntry.findFirst({
    where: { source: "payment", sourceRef: payment.id },
    include: { lines: { include: { account: true } } },
  });
  if (!original) return false;

  /* Reverse the receipt (mirror every leg). */
  await postEntry({
    date: new Date(),
    memo: `Refund issued — reversing receipt ${original.entryNo}`,
    source: "refund",
    sourceRef: payment.id,
    lines: original.lines.map((line) => ({
      code: line.account.code,
      credit: line.debit,
      debit: line.credit,
    })),
  });

  /* Reverse recognition posted so far (mirror). */
  const recognized = await db.journalEntry.findMany({
    where: { source: "recognition", sourceRef: payment.id },
    include: { lines: { include: { account: true } } },
  });
  for (const entry of recognized) {
    await postEntry({
      date: new Date(),
      memo: `Refund issued — reversing recognition ${entry.entryNo}`,
      source: "refund",
      sourceRef: payment.id,
      lines: entry.lines.map((line) => ({
        code: line.account.code,
        credit: line.debit,
        debit: line.credit,
      })),
    });
  }
  return true;
}

/** Whole calendar months between two dates (floor). */
function wholeMonthsBetween(from: Date, to: Date): number {
  if (to <= from) return 0;
  let months =
    (to.getFullYear() - from.getFullYear()) * 12 +
    (to.getMonth() - from.getMonth());
  /* Partial month: only count a month once its anniversary day passed. */
  if (to.getDate() < from.getDate()) months -= 1;
  return Math.max(0, months);
}
