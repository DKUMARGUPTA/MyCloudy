/**
 * P9-F5B smoke: the PURE surface logic of create-electronic-invoice (91st)
 * + pdf-to-e-invoice (92nd) — payload building, prefill merge, profile
 * values, draft serialize/restore. No DOM, no React (bun-native).
 * Run: bun scripts/smoke-p9-f5b.ts
 */
import { calc, parseInvoiceRun } from "../tools/create-invoice/model";
import { buildCiiXml } from "../tools/einvoice-common/cii";
import { extractInvoiceFields } from "../tools/einvoice-common/extract";
import {
  EINV_MAX_ITEMS,
  EINV_PROFILES,
  buildInvOption,
  emptyEInvoiceForm,
  gstStateOf,
  mergeExtracted,
  normalizeProfile,
  parseDraft,
  parseInvOption,
  sampleEInvoiceState,
  serializeDraft,
} from "../tools/einvoice-common/payload";

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

/* ------------------------- payload building ------------------------- */
console.log("payload building");

const sample = sampleEInvoiceState();
const raw = buildInvOption(sample);
check("payload is { s } JSON", typeof raw === "string" && "s" in JSON.parse(raw));
const back = parseInvoiceRun(String(raw)); // the worker's exact parse path
check(
  "worker round-trip keeps fields",
  back.s.biz.name === "Sharma Traders" &&
    back.s.biz.gstin === "29ABCDE1234F1Z5" &&
    back.s.cli.gstin === "27PQRSX6789K1Z2" &&
    back.s.no === "INV-2026-042" &&
    back.s.date === "2026-10-20"
);
check(
  "worker round-trip keeps all items",
  back.s.items.length === 3 &&
    back.s.items[0].d === "Steel bracket" &&
    back.s.items[1].r === "80.50" &&
    back.s.items[2].g === "0"
);

const fresh = emptyEInvoiceForm();
const freshRaw = buildInvOption(fresh);
const freshBack = parseInvoiceRun(String(freshRaw));
check(
  "blank form round-trips with its one row",
  freshBack.s.items.length === 1 &&
    freshBack.s.date === fresh.date &&
    freshBack.s.due === fresh.due &&
    freshBack.s.ro === true
);
check(
  "blank form has sane defaults",
  fresh.ty === "simple-invoice" &&
    fresh.cur === "INR" &&
    fresh.tr === "18" &&
    /^\d{4}-\d{2}-\d{2}$/.test(fresh.date) &&
    /^\d{4}-\d{2}-\d{2}$/.test(fresh.due)
);

check("garbage payload → safe defaults", parseInvOption("{oops").items.length === 1);
check("empty payload → safe defaults", parseInvOption("").items.length === 1);
check("null payload → safe defaults", parseInvOption(null).items.length === 1);
check("typed payload → safe defaults", parseInvOption(42).biz.name === "");

/* ------------------------- prefill merge ------------------------- */
console.log("prefill merge (pdf-to-e-invoice)");

/* The einvoice-common smoke's invoice text, split as a real 2-page read. */
const page1 = `
SHARMA TRADERS
12 MG Road, Bengaluru 560001
GSTIN: 29ABCDE1234F1Z5

TAX INVOICE
Invoice No: INV-2026-042        Date: 20/10/2026

Bill To:
Verma & Sons
GSTIN: 27PQRSX6789K1Z2

Steel bracket  4 x 250.00     1,000.00
Copper wire  10 x 80.50        805.00
`;
const page2 = `
CGST 9%                          162.45
SGST 9%                          162.45

Grand Total                     ₹2,129.90
`;
const ex = extractInvoiceFields([page1, page2]);
const merged = mergeExtracted(fresh, ex);

check("seller gstin merged", merged.biz.gstin === "29ABCDE1234F1Z5");
check("seller state derived from gstin", merged.biz.state === "29");
check("buyer gstin merged", merged.cli.gstin === "27PQRSX6789K1Z2");
check("buyer state + pos derived", merged.cli.state === "27" && merged.pos === "27");
check("buyer name after marker", merged.cli.name === "Verma & Sons");
check("invoice number merged", merged.no === "INV-2026-042");
check("date normalised to ISO", merged.date === "2026-10-20");
check(
  "grand total parked as one row",
  merged.items.length === 1 && merged.items[0].r === "2129.90" && merged.items[0].q === "1"
);
check("gst rate hint applied (9+9)", merged.tr === "18");
check("currency INR", merged.cur === "INR");
check(
  "manual fields untouched by merge",
  merged.biz.email === "" && merged.biz.addr === "" && merged.due === fresh.due && merged.adv === fresh.adv
);

/* calc() over the merged form = the numbers the XML will carry. */
const mc = calc(merged);
check(
  "merged form calculates",
  mc.sub === 212990 && mc.L[0].rt === 18 && mc.tot > mc.sub
);

/* Merge must respect manual edits: only FOUND fields overwrite. */
const manual = { ...fresh, no: "MY-OWN-9", tr: "5", biz: { ...fresh.biz, email: "a@b.c" } };
const reMerged = mergeExtracted(manual, ex);
check(
  "merge does not invent unfound fields",
  reMerged.biz.email === "a@b.c"
);

/* Empty extraction is a no-op. */
const emptyEx = extractInvoiceFields(["hello\nworld"]);
check("empty extraction → no-op", mergeExtracted(manual, emptyEx) === manual);

/* No rate hint → tr stays the current value. */
const onlyNo = extractInvoiceFields(["Invoice No: X-1\nTotal ₹10.00\n"]);
const onlyMerged = mergeExtracted({ ...fresh, tr: "5" }, onlyNo);
check("no rate hint keeps current tr", onlyMerged.tr === "5");

/* Scanned-PDF path: all-empty pages → nothing recognised, form usable. */
const scanEx = extractInvoiceFields(["", ""]);
check("scanned pages → empty result", scanEx.empty === true);

/* ------------------------- profile values ------------------------- */
console.log("profile values");

check(
  "profile select values",
  JSON.stringify(EINV_PROFILES) === JSON.stringify(["facturx", "xrechnung"])
);
check("normalize unknown → facturx", normalizeProfile("nope") === "facturx");
check("normalize xrechnung", normalizeProfile("xrechnung") === "xrechnung");
const c2 = calc(sample);
check(
  "facturx guideline in XML",
  buildCiiXml(sample, c2).includes("urn:factur-x.eu:Factur-X:1.0")
);
check(
  "xrechnung guideline in XML",
  buildCiiXml(sample, c2, "xrechnung").includes("xrechnung_3.0")
);

/* ------------------------- draft serialize/restore ------------------------- */
console.log("draft serialize/restore");

const draftRaw = serializeDraft(sample, "xrechnung");
const draft = parseDraft(draftRaw);
check(
  "draft round-trip",
  draft !== null &&
    draft.s.biz.name === "Sharma Traders" &&
    draft.s.items.length === 3 &&
    draft.profile === "xrechnung" &&
    typeof draft.at === "string" &&
    draft.at.length > 0
);
check("draft restore feeds the worker parse", parseInvoiceRun(buildInvOption(draft!.s)).s.no === "INV-2026-042");
check("draft garbage → null", parseDraft("not json") === null);
check("draft wrong shape → null", parseDraft("{}") === null);
check("draft tampered s → null", parseDraft(JSON.stringify({ s: "x", profile: "facturx" })) === null);
check("draft null-safe", parseDraft(null) === null);

/* ------------------------- limits + helpers ------------------------- */
console.log("limits + helpers");

check("item cap is 25", EINV_MAX_ITEMS === 25);
check("gstStateOf valid prefix", gstStateOf("29ABCDE1234F1Z5") === "29");
check("gstStateOf invalid prefix", gstStateOf("XXnope") === "");
check(
  "sample state is runnable",
  sample.biz.name !== "" &&
    sample.items.length === 3 &&
    calc(sample).tot > 0
);

/* ------------------------- summary ------------------------- */
console.log(`\n${pass} passed, ${fail} failed (of ${pass + fail})`);
if (fail > 0) process.exit(1);
