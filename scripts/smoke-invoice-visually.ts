/**
 * P9-F5A smoke: create-invoice-visually payload contract. The surface's
 * payload builders are internal; this locks their exact contract by
 * mirroring the shape (the web2pdf-helper method).
 * Run: bun scripts/smoke-invoice-visually.ts
 */
import {
  calc,
  parseInvoiceRun,
  sanitizeBlockOrder,
  type InvoiceState,
} from "../tools/create-invoice/model";
import { BLOCK_KEYS } from "../tools/create-invoice/model";
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

/* Mirror of the surface's payload contract:
   JSON.stringify({ s, ord: ord.filter(not hidden), ac, hidden }) */
function draftToPayload(d: {
  s: InvoiceState;
  ord: string[];
  hidden: string[];
  ac: string;
}): string {
  return JSON.stringify({
    s: d.s,
    ord: d.ord.filter((k) => !d.hidden.includes(k)),
    ac: d.ac,
    hidden: d.hidden,
  });
}

console.log("create-invoice-visually payload contract");

// A realistic visual draft: full ord, one hidden block, emerald accent.
const state: InvoiceState = parseInvoiceRun("{}").s;
state.ty = "gst-invoice";
state.biz.name = "Sharma Traders";
state.biz.gstin = "29ABCDE1234F1Z5";
state.biz.state = "29";
state.cli.name = "Verma & Sons";
state.cli.gstin = "27PQRSX6789K1Z2";
state.cli.state = "27";
state.pos = "27";
state.no = "INV-V-001";
state.date = "2026-10-21";
state.due = "2026-11-20";
state.items = [
  { d: "Steel bracket", h: "7325", q: "4", r: "250", g: "18" },
  { d: "Consulting", h: "9983", q: "1", r: "1200", g: "18" },
];

const ord = sanitizeBlockOrder(BLOCK_KEYS);
const hidden = ["terms"];
const payload = draftToPayload({ s: state, ord, hidden, ac: "#0b6b4d" });

const run = parseInvoiceRun(payload);
check("payload round-trips to InvoiceRun", run.s.biz.name === "Sharma Traders" && run.s.items.length === 2);
check("hidden block removed from ord", !run.ord.includes("terms" as never) && run.ord.length === ord.length - 1);
check("accent passes the #rrggbb gate", /^#[0-9a-fA-F]{6}$/.test(run.ac) && run.ac === "#0b6b4d");
check("ord is a valid full chain otherwise", ord.length === BLOCK_KEYS.length && Array.isArray(run.ord));
check("unknown extra field (hidden) tolerated", Array.isArray((JSON.parse(payload) as Record<string, unknown>).hidden));

// The worker path: calc over the payload state → drawInvoice inputs.
const c = calc(run.s);
check("calc computes totals", c.sub === 220000 && c.tot > 0, `sub=${c.sub}`);
check("GST split by party states (inter → IGST)", c.ig > 0 && c.cg === 0);

// Accent sanity from the source: no blue/indigo hexes in the surface.
const src = readFileSync("tools/create-invoice-visually/surface.tsx", "utf8");
const hexes = [...src.matchAll(/#([0-9a-fA-F]{6})/g)].map((m) => m[1].toLowerCase());
const banned = ["2563eb", "1d4ed8", "3b82f6", "4f46e5", "4338ca", "6366f1", "818cf8", "1e40af"];
const offenders = hexes.filter((h) => banned.includes(h));
check("no blue/indigo accent hexes", offenders.length === 0, offenders.join(","));

// DropZone-free: config declares noFile + the shared worker re-export.
const cfg = readFileSync("tools/create-invoice-visually/config.ts", "utf8");
check("config noFile surface-owns", cfg.includes("noFile: true"));
const wrk = readFileSync("tools/create-invoice-visually/worker.ts", "utf8");
check("worker re-exports create-invoice engine", wrk.includes('../create-invoice/worker'));

// i18n invv section present in both catalogs (merge ran).
const en = JSON.parse(readFileSync("src/i18n/en.json", "utf8"));
const hi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8"));
check("invv merged en=hi", "invv" in en && "invv" in hi && Object.keys(en.invv).length === Object.keys(hi.invv).length && Object.keys(en.invv).length >= 60);

console.log(`\n${pass} passed, ${fail} failed (of ${pass + fail})`);
if (fail > 0) process.exit(1);
