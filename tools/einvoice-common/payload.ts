/**
 * Pure e-invoice surface helpers (P9 batch 5) — the state math behind the
 * create-electronic-invoice and pdf-to-e-invoice surfaces, kept OUT of the
 * TSX files so the smoke script (bun, no DOM) can prove every rule:
 *
 *  - the run payload ({ s } JSON → parseInvoiceRun round-trip),
 *  - the prefill merge (extractInvoiceFields result → form fields),
 *  - the localStorage draft serialize/restore,
 *  - the profile select values (Factur-X / XRechnung),
 *  - GST-state derivation from a GSTIN prefix (for the CGST/SGST vs
 *    IGST split calc() makes — the form has no state dropdowns).
 *
 * NO React, NO DOM, NO storage side effects — callers own those.
 */

import { parseInvoiceRun, plus, today, type InvoiceState } from "../create-invoice/model";
import { GST_STATES } from "../create-invoice/types";
import { emptyInvoice } from "./blank";
import type { ExtractResult } from "./extract";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** The e-invoice form's item-row cap (compact form, 25 is plenty). */
export const EINV_MAX_ITEMS = 25;

/** The two guideline profiles the shared worker understands. */
export const EINV_PROFILES = ["facturx", "xrechnung"] as const;
export type EinvProfile = (typeof EINV_PROFILES)[number];

export function normalizeProfile(v: unknown): EinvProfile {
  return v === "xrechnung" ? "xrechnung" : "facturx";
}

/** "27PQRSX6789K1Z2" → "27"; unknown prefix → "" (blank counts as intra-state). */
export function gstStateOf(gstin: string): string {
  const code = gstin.slice(0, 2);
  return GST_STATES.some((s) => s.slice(0, 2) === code) ? code : "";
}

/* ------------------------------------------------------------------ */
/* Blank + sample states                                               */
/* ------------------------------------------------------------------ */

/**
 * Fresh form state: one empty item row, today's date, due +15 days,
 * GST 18 default — the create-invoice fresh-S recipe minus every field
 * the e-invoice form does not show (logo, bank, terms… stay empty).
 */
export function emptyEInvoiceForm(): InvoiceState {
  const s = emptyInvoice();
  return {
    ...s,
    no: "",
    date: today(),
    due: plus(15),
    tr: "18",
    ro: true,
    items: [{ d: "", h: "", q: "1", r: "", g: "18" }],
  };
}

/** Demo invoice for the "Load sample" button (matches the smoke fixture). */
export function sampleEInvoiceState(): InvoiceState {
  return {
    ...emptyEInvoiceForm(),
    biz: {
      ...emptyInvoice().biz,
      name: "Sharma Traders",
      gstin: "29ABCDE1234F1Z5",
      state: "29",
      addr: "12 MG Road\nBengaluru 560001",
      email: "billing@sharmatraders.example",
    },
    cli: {
      name: "Verma & Sons",
      gstin: "27PQRSX6789K1Z2",
      state: "27",
      addr: "4 Lake View\nPune 411001",
    },
    pos: "27",
    no: "INV-2026-042",
    items: [
      { d: "Steel bracket", h: "7325", q: "4", r: "250", g: "18" },
      { d: "Copper wire 2m", h: "8544", q: "10", r: "80.50", g: "18" },
      { d: "Manual labour", h: "9985", q: "1", r: "1200", g: "0" },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Run payload (the "inv" option the shared worker parses)              */
/* ------------------------------------------------------------------ */

/** Surface → worker: the exact `{ s }` JSON string options.inv carries. */
export function buildInvOption(s: InvoiceState): string {
  return JSON.stringify({ s });
}

/** Worker-boundary round-trip: the payload a run actually receives. */
export function parseInvOption(raw: unknown): InvoiceState {
  if (typeof raw !== "string" || raw.length === 0) return emptyEInvoiceForm();
  const run = parseInvoiceRun(raw);
  // parseInvoiceRun guarantees ≥1 item row; keep exactly what it produced
  // so the form mirrors the worker's view 1:1.
  return run.s;
}

/* ------------------------------------------------------------------ */
/* Prefill merge (pdf-to-e-invoice)                                    */
/* ------------------------------------------------------------------ */

/**
 * Merges an extraction result into the current form. Only fields the
 * extractor actually FOUND are taken (checked against `notes`, because
 * extract.ts also writes heuristic defaults like tr="0" that are NOT
 * findings) — everything the user typed stays. `ex.empty` short-circuits.
 */
export function mergeExtracted(
  current: InvoiceState,
  ex: ExtractResult
): InvoiceState {
  if (ex.empty) return current;
  const f = ex.state;
  const has = (field: string): boolean =>
    ex.notes.some((n) => n.field === field);

  const next: InvoiceState = { ...current };
  next.cur = f.cur;
  next.no = has("Invoice number") ? f.no : current.no;
  next.date = has("Invoice date") && f.date ? f.date : current.date;

  if (has("Seller GSTIN") && f.biz.gstin) {
    next.biz = {
      ...next.biz,
      gstin: f.biz.gstin,
      state: gstStateOf(f.biz.gstin) || next.biz.state,
    };
  }
  if (has("Seller name") && f.biz.name) {
    next.biz = { ...next.biz, name: f.biz.name };
  }
  if (has("Buyer GSTIN") && f.cli.gstin) {
    next.cli = {
      ...next.cli,
      gstin: f.cli.gstin,
      state: gstStateOf(f.cli.gstin) || next.cli.state,
    };
    next.pos = gstStateOf(f.cli.gstin) || current.pos;
  }
  if (has("Buyer name") && f.cli.name) {
    next.cli = { ...next.cli, name: f.cli.name };
  }
  if (has("GST rate hint") && f.tr) {
    next.tr = f.tr;
  }
  if (has("Grand total found") && f.items.length > 0) {
    // The extractor parks the grand total as one placeholder row — the
    // user refines it into real lines. The rate hint rides along so the
    // parked row lands on the discovered GST bucket when there is one.
    const rate = has("GST rate hint") && f.tr ? f.tr : current.tr;
    next.items = f.items.map((it) => ({ ...it, g: it.g || rate }));
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* localStorage draft                                                   */
/* ------------------------------------------------------------------ */

export interface EinvDraft {
  s: InvoiceState;
  profile: EinvProfile;
  /** ISO timestamp of the last edit (shown in the restore banner). */
  at: string;
}

export function serializeDraft(
  s: InvoiceState,
  profile: EinvProfile
): string {
  return JSON.stringify({ s, profile, at: new Date().toISOString() });
}

/** Unreadable/tampered drafts → null (never a crash, never a wrong form). */
export function parseDraft(raw: string | null): EinvDraft | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (typeof o.s !== "object" || o.s === null) return null;
    const run = parseInvoiceRun(JSON.stringify({ s: o.s }));
    return {
      s: run.s,
      profile: normalizeProfile(o.profile),
      at: typeof o.at === "string" ? o.at : "",
    };
  } catch {
    return null;
  }
}
