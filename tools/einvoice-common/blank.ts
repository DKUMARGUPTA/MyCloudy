/**
 * Blank InvoiceState for imported e-invoices (P9 batch 5). Kept separate
 * from create-invoice's model so this module never imports the surface
 * world. All-std family (no GST columns) is the safest import target —
 * tax details stay in the XML where they belong.
 */
import type { InvoiceState } from "../create-invoice/model";

export function emptyInvoice(): InvoiceState {
  return {
    ty: "simple-invoice",
    cur: "INR",
    biz: {
      name: "",
      addr: "",
      gstin: "",
      state: "",
      phone: "",
      email: "",
      bank: "",
      upi: "",
      logo: "",
      sig: "",
    },
    cli: { name: "", addr: "", gstin: "", state: "" },
    pos: "",
    no: "",
    date: "",
    due: "",
    valid: "",
    dMode: "%",
    d: "0",
    tr: "18",
    ro: false,
    adv: "0",
    st: "",
    notes: "",
    terms: "",
    xv: ["", "", ""],
    items: [],
  };
}
