import { db } from "@/lib/db";
import { getAccountingConfig, splitInclusiveGst } from "./chart";

/**
 * Invoicing (R27) — one GST-compliant tax invoice per paid payment.
 *
 * Numbering: DP-INV-000001 … sequential (SQLite's single-writer model
 * makes the count+1 sequence safe here; the unique constraint backstops
 * races anyway). INR domestic sales carry the CGST+SGST (or IGST) split;
 * USD sales are zero-rated exports. The invoice face currency is the
 * payment currency; the books stay INR.
 */

export async function nextInvoiceNo(): Promise<string> {
  const count = await db.invoice.count();
  return `DP-INV-${String(count + 1).padStart(6, "0")}`;
}

export interface InvoiceFromPaymentResult {
  invoiceNo: string;
  taxType: "cgst_sgst" | "igst" | "export";
  taxableAmount: number;
  taxAmount: number;
}

/**
 * Issue (or return the existing) invoice for a paid payment. Also
 * backfills Payment.invoiceNo when the payment row lacks one.
 */
export async function issueInvoiceForPayment(payment: {
  id: string;
  userId: string;
  amount: number;
  currency: string;
  createdAt: Date;
}): Promise<InvoiceFromPaymentResult> {
  const existing = await db.invoice.findUnique({
    where: { paymentId: payment.id },
  });
  if (existing) {
    return {
      invoiceNo: existing.invoiceNo,
      taxType: existing.taxType as InvoiceFromPaymentResult["taxType"],
      taxableAmount: existing.taxableAmount,
      taxAmount: existing.taxAmount,
    };
  }

  const cfg = await getAccountingConfig();
  const user = await db.user.findUnique({
    where: { id: payment.userId },
    select: { email: true, name: true },
  });

  let taxType: "cgst_sgst" | "igst" | "export";
  let taxable: number;
  let tax: number;

  if (payment.currency === "INR") {
    taxType = cfg.inrTaxType;
    const split = payment.amount > 0
      ? splitInclusiveGst(payment.amount, cfg.gstRatePercent)
      : { taxable: 0, tax: 0 };
    taxable = split.taxable;
    tax = split.tax;
  } else {
    taxType = "export";
    taxable = payment.amount;
    tax = 0;
  }

  const invoiceNo = await nextInvoiceNo();
  const invoice = await db.invoice.create({
    data: {
      invoiceNo,
      paymentId: payment.id,
      userId: payment.userId,
      customerEmail: user?.email ?? "unknown@docopdf.com",
      customerName: user?.name,
      issuedAt: payment.createdAt,
      itemCode: "pro_subscription",
      taxType,
      taxableAmount: taxable,
      taxAmount: tax,
      totalAmount: payment.amount,
      currency: payment.currency,
      status: "paid",
    },
  });

  /* Backfill the Payment row's invoice number (account view shows it). */
  await db.payment.update({
    where: { id: payment.id },
    data: { invoiceNo },
  });

  return {
    invoiceNo: invoice.invoiceNo,
    taxType,
    taxableAmount: taxable,
    taxAmount: tax,
  };
}
