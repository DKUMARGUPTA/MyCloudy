import { db } from "@/lib/db";
import { ensureChartSeeded } from "./chart";
import { entryExists, postPaymentEntry, postRefundEntry, recognizeForPayment } from "./post";
import { issueInvoiceForPayment } from "./invoice";

/**
 * Accounting sync sweep (R27) — the idempotent bridge between the billing
 * tables (Payment/Subscription) and the double-entry books. Safe to run
 * any time; designed to be run on-demand from the admin console and (in
 * production) from the payment-provider webhook.
 *
 * Order of operations per run:
 *   0. seed the chart of accounts (first run only)
 *   1. every PAID payment without a receipt entry  → post + issue invoice
 *   2. monthly plans                               → immediate recognition
 *   3. yearly plans                                → catch-up recognition
 *   4. REFUNDED payments without reversal entries  → reversing entries
 *      + invoice status flips to refunded
 */

export interface SyncResult {
  paymentsPosted: number;
  invoicesIssued: number;
  recognizedTotal: number;
  recognitionEntries: number;
  refundsPosted: number;
  invoicesVoided: number;
}

export async function runAccountingSync(): Promise<SyncResult> {
  await ensureChartSeeded();

  const result: SyncResult = {
    paymentsPosted: 0,
    invoicesIssued: 0,
    recognizedTotal: 0,
    recognitionEntries: 0,
    refundsPosted: 0,
    invoicesVoided: 0,
  };

  /* ---- 1. Paid payments → receipt entry + invoice ----------------- */
  const paidPayments = await db.payment.findMany({
    where: { status: "paid" },
    orderBy: { createdAt: "asc" },
  });

  for (const payment of paidPayments) {
    const alreadyPosted = await entryExists("payment", payment.id);
    if (!alreadyPosted) {
      await postPaymentEntry(payment);
      result.paymentsPosted += 1;
    }
    const existingInvoice = await db.invoice.findUnique({
      where: { paymentId: payment.id },
      select: { invoiceNo: true },
    });
    if (!existingInvoice) {
      await issueInvoiceForPayment(payment);
      result.invoicesIssued += 1;
    }
  }

  /* ---- 2+3. Recognition (plan-aware, catch-up safe) ---------------- */
  const activeSubs = await db.subscription.findMany({
    where: { status: { in: ["active", "cancelled", "pending", "expired"] } },
    select: { userId: true, plan: true, status: true },
  });
  const planByUser = new Map<string, "pro_monthly" | "pro_yearly">();
  for (const sub of activeSubs) {
    if (sub.plan === "pro_monthly" || sub.plan === "pro_yearly") {
      planByUser.set(sub.userId, sub.plan);
    }
  }

  for (const payment of paidPayments) {
    if (payment.status !== "paid") continue;
    const plan = planByUser.get(payment.userId);
    if (plan !== "pro_monthly" && plan !== "pro_yearly") continue;
    const recognized = await recognizeForPayment(payment, plan);
    if (recognized > 0) {
      result.recognizedTotal += recognized;
      result.recognitionEntries += 1;
    }
  }

  /* ---- 4. Refunds → reversals + voided invoices -------------------- */
  const refundedPayments = await db.payment.findMany({
    where: { status: "refunded" },
  });
  for (const payment of refundedPayments) {
    const posted = await postRefundEntry(payment);
    if (posted) result.refundsPosted += 1;
    const invoice = await db.invoice.findUnique({
      where: { paymentId: payment.id },
    });
    if (invoice && invoice.status === "paid") {
      await db.invoice.update({
        where: { id: invoice.id },
        data: { status: "refunded" },
      });
      result.invoicesVoided += 1;
    }
  }

  return result;
}
