/** Shared sample InvoiceState for the P9-F5 smokes (single source). */
import type { InvoiceState } from "../tools/create-invoice/model";
import { parseInvoiceRun } from "../tools/create-invoice/model";

export function sampleState(): InvoiceState {
  const s = parseInvoiceRun("{}").s;
  s.ty = "gst-invoice";
  s.cur = "INR";
  s.biz.name = "Sharma Traders";
  s.biz.addr = "12 MG Road\nBengaluru 560001";
  s.biz.gstin = "29ABCDE1234F1Z5";
  s.biz.state = "29";
  s.biz.email = "billing@sharmatraders.example";
  s.biz.bank = "HDFC 50100234567890";
  s.biz.upi = "sharma@hdfcbank";
  s.cli.name = "Verma & Sons";
  s.cli.addr = "4 Lake View\nPune 411001";
  s.cli.gstin = "27PQRSX6789K1Z2";
  s.cli.state = "27";
  s.pos = "27";
  s.no = "INV-2026-042";
  s.date = "2026-10-20";
  s.due = "2026-11-19";
  s.dMode = "f";
  s.d = "100";
  s.tr = "18";
  s.ro = true;
  s.adv = "5000";
  s.notes = "Thank you for your business.";
  s.terms = "Due in 30 days.";
  s.items = [
    { d: "Steel bracket", h: "7325", q: "4", r: "250", g: "18" },
    { d: "Copper wire 2m", h: "8544", q: "10", r: "80.50", g: "18" },
    { d: "Manual labour", h: "9985", q: "1", r: "1200", g: "0" },
  ];
  return s;
}
