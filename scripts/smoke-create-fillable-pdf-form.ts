/**
 * PRE-BUILD smoke test for the Create fillable PDF form tool (P3-FORM, the
 * 65th tool). Proves the ZERO-MISTAKE core with hand-computed vectors
 * before the tool is trusted:
 *
 *  1. GEOMETRY (model.ts): px→pt with y-flip, grid snap, boxRect label
 *     offset, checkbox square centring, radio rows, wrapText (greedy wrap
 *     + hard break), column-flow nextSlot.
 *  2. NAMES: slugify (formula-safe, no leading digit, no hyphen),
 *     uniqueName dedupe, asciiSafe WinAnsi stripping, exportValueFor.
 *  3. FORMULA COMPILER: tokenizer + recursive-descent parser + JS emit
 *     (exact strings), every error class (unknown identifier with
 *     near-match, non-number reference, target kind, duplicate target,
 *     empty, bad char, syntax), cycle detection with the exact path,
 *     self-cycle, stable topological order (diamond case).
 *  4. EMITTED JS IS EXECUTABLE — the sandbox proof: every compiled
 *     script is run with new Function + a mock Doc.getField and produces
 *     the hand-computed number (the ISO 32000-1 action actually works).
 *  5. PARSE: template instantiate → serialize → parseFormDoc round-trip
 *     (radio height growth is an explicit vector), tampered payloads
 *     (unknown kinds, NaN/off-page geometry, name dedupe, >10 pages,
 *     garbage JSON → blank doc).
 *  6. PDF (render.ts): drives the worker's EXACT build code with the
 *     self-hosted Noto font read from disk — order-form template (10
 *     fields, /AA /C JS exact, /CO topological order, AFNumber/AFDate
 *     actions, required flags, multiline, maxLength), leave template
 *     (dropdown options), event template (radio group export values),
 *     2-page placement with the exact widget /Rect, a Hindi + ₹ build
 *     (embedded font + text-showing ops in the content stream), the
 *     extracted /C scripts re-executed from the RELOADED PDF end-to-end,
 *     and a tampered payload that still builds.
 *
 * Run: bun scripts/smoke-create-fillable-pdf-form.ts
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import fontkit from "@pdf-lib/fontkit";
import {
  PDFArray,
  PDFBool,
  PDFDocument,
  PDFDict,
  PDFName,
  PDFRef,
  PDFString,
  PDFCheckBox,
  PDFTextField,
} from "pdf-lib";

import {
  asciiSafe,
  blankDoc,
  boxRect,
  calcScript,
  collectIds,
  compileRules,
  docIsEmpty,
  emitJs,
  exportValueFor,
  findCycle,
  heightForOptions,
  labelHeight,
  lineHeight,
  nextSlot,
  outputBaseName,
  PAGE_H_PX,
  parseFormDoc,
  pxToPtRect,
  radioRows,
  slugify,
  snap,
  tokenize,
  parseTokens,
  uniqueName,
  wrapText,
  type CalcRule,
  type FieldEl,
  type FieldKind,
  type FormDoc,
} from "../tools/create-fillable-pdf-form/model";
import {
  AF_DATE_FORMAT,
  AF_NUMBER_FORMAT,
  AF_NUMBER_KEYSTROKE,
  drawFormPdf,
} from "../tools/create-fillable-pdf-form/render";
import { instantiateTemplate, templateById } from "../tools/create-fillable-pdf-form/templates";

let failures = 0;
let checks = 0;
function eq(actual: unknown, expected: unknown, what: string): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok  ${what}`);
  } else {
    failures++;
    console.error(`  FAIL ${what}\n       expected ${e}\n       actual   ${a}`);
  }
}
function ok(cond: boolean, what: string): void {
  checks += 1;
  if (cond) {
    console.log(`  ok  ${what}`);
  } else {
    failures++;
    console.error(`  FAIL ${what}`);
  }
}

const identity = (k: string): string => k;

/* ------------------------------------------------------------------ */
/* 1. GEOMETRY                                                          */
/* ------------------------------------------------------------------ */
console.log("\n[1] geometry — px→pt, snap, boxRect, radio, wrap, nextSlot");

// PAGE_H_PX = 841.89 / 0.75 = 1122.52 (hand: 841.89 × 4/3).
eq(PAGE_H_PX, 1122.52, "PAGE_H_PX = 1122.52 (A4 ÷ 0.75)");

// pxToPtRect: x=40,y=112,w=320,h=40 → x=30, y=(1122.52−112−40)×0.75=727.89.
eq(
  pxToPtRect({ x: 40, y: 112, w: 320, h: 40 }),
  { x: 30, y: 727.89, w: 240, h: 30 },
  "pxToPtRect y-flip (40,112,320,40) → (30,727.89,240,30)"
);
eq(pxToPtRect({ x: 0, y: 0, w: 100, h: 50 }), { x: 0, y: (1122.52 - 50) * 0.75, w: 75, h: 37.5 }, "pxToPtRect origin");

// snap: 35→32, 36→40 (Math.round(4.5)=5), 44→48.
eq(snap(35), 32, "snap(35)=32");
eq(snap(36), 40, "snap(36)=40 (half rounds up)");
eq(snap(44), 48, "snap(44)=48");

// lineHeight + labelHeight.
eq(Math.round(lineHeight(12) * 100) / 100, 16.8, "lineHeight(12)=16.8 (float-safe)");
eq(labelHeight({ label: "Qty", fs: 12 }), 18, "labelHeight fs12 = 18");
eq(labelHeight({ label: "", fs: 12 }), 0, "labelHeight empty label = 0");

// boxRect: label present → box under the label; empty label → flush.
eq(
  boxRect({ kind: "text", x: 40, y: 112, w: 320, h: 40, label: "A", fs: 12 } as FieldEl),
  { x: 40, y: 130, w: 320, h: 22 },
  "boxRect text field (label lifts box by 18px)"
);
eq(
  boxRect({ kind: "text", x: 40, y: 112, w: 320, h: 60, label: "", fs: 12 } as FieldEl),
  { x: 40, y: 112, w: 320, h: 60 },
  "boxRect no label (flush, full height — lh 0 keeps h)"
);
// checkbox: w=16,h=34,label,fs=12 → lh=18, size=max(8,floor(min(16,16)))=16.
eq(
  boxRect({ kind: "checkbox", x: 40, y: 112, w: 16, h: 34, label: "ok", fs: 12 } as FieldEl),
  { x: 40, y: 130, w: 16, h: 16 },
  "boxRect checkbox 16×16 centred under label"
);
// checkbox squeezed: h−lh=10 → size=10.
eq(
  boxRect({ kind: "checkbox", x: 0, y: 0, w: 20, h: 28, label: "x", fs: 12 } as FieldEl),
  { x: 0, y: 18, w: 10, h: 10 },
  "boxRect checkbox squeezed (size floor 8 → 10 here)"
);
// radio rows: h=72, fs=12, label, 3 options → rowH=18, circle=14, rows at +18.
const radio = {
  kind: "radio",
  x: 40,
  y: 112,
  w: 220,
  h: 72,
  fs: 12,
  label: "Pick",
  options: ["a", "b", "c"],
} as FieldEl;
eq(
  radioRows(radio).map((r) => [r.y, r.h, r.circle, r.cy]),
  [
    [130, 18, 14, 132],
    [148, 18, 14, 150],
    [166, 18, 14, 168],
  ],
  "radioRows geometry (rowH 18, circle 14, centred)"
);
// heightForOptions: fs=12, label, 4 options → 18 + 4×18 = 90.
eq(heightForOptions(radio, 4), 90, "heightForOptions 4 options = 90");

// wrapText with a deterministic measurer (2 units per char).
const measure2 = (s: string): number => s.length * 2;
eq(wrapText("hello world", 10, 12, measure2), ["hello", "world"], "wrapText greedy split");
eq(wrapText("abcdefghij", 6, 12, measure2), ["abc", "def", "ghi", "j"], "wrapText hard-break long word");
eq(wrapText("a\n\nb", 100, 12, measure2), ["a", "", "b"], "wrapText honors \\n + blank lines");
eq(wrapText("", 100, 12, measure2), [""], "wrapText empty → ['']");

// nextSlot: empty page → margin; one 220px element at 40 → next at x=264.
eq(nextSlot([], 120, 40), { x: 40, y: 40 }, "nextSlot empty page → margin");
eq(
  nextSlot(
    [{ id: "e", kind: "text", x: 40, y: 40, w: 220, h: 40, text: "", fs: 12 }],
    120,
    40
  ),
  { x: 264, y: 40 },
  "nextSlot skips a 220px element (264 = 40 + 220 rounded to grid)"
);

/* ------------------------------------------------------------------ */
/* 2. NAMES                                                             */
/* ------------------------------------------------------------------ */
console.log("\n[2] names — slugify, uniqueName, asciiSafe, exportValueFor");

eq(slugify("Full Name"), "full_name", "slugify spaces → _");
eq(slugify("123 abc"), "f_123_abc", "slugify leading digit → f_ prefix");
eq(slugify("Price ₹/kg"), "price_kg", "slugify strips ₹/ (one _ run)");
eq(slugify(""), "field", "slugify empty → field");
eq(slugify("---"), "field", "slugify punctuation-only → field");
eq(slugify("  leave_from  "), "leave_from", "slugify trims");

const taken = new Set<string>(["qty"]);
eq(uniqueName("qty", taken), "qty_2", "uniqueName collision → _2");
eq(uniqueName("qty", taken), "qty_3", "uniqueName second collision → _3");

eq(asciiSafe("₹200 – café"), "200 - caf", "asciiSafe strips ₹/–/é (dash mapped)");
eq(asciiSafe("a\u00a0b\u2019c"), "a b'c", "asciiSafe nbsp→space, curly quote→'");
eq(asciiSafe("plain"), "plain", "asciiSafe passthrough");

eq(exportValueFor("Option 1", 0), "option_1", "exportValueFor slug");
eq(exportValueFor("₹$$", 2), "opt3", "exportValueFor unsalvageable → opt{n} (1-based)");

/* ------------------------------------------------------------------ */
/* 3. FORMULA COMPILER                                                  */
/* ------------------------------------------------------------------ */
console.log("\n[3] formula compiler — tokenize, parse, emit, errors, cycles, topo");

eq(
  tokenize("qty * price").toks,
  [
    { t: "id", v: "qty" },
    { t: "op", v: "*" },
    { t: "id", v: "price" },
  ],
  "tokenize qty * price"
);
ok(tokenize("a $ b").error, "tokenize rejects $");
ok(!tokenize("a - 2.5").error, "tokenize accepts minus + decimal");
eq(
  tokenize("-qty * 2").toks,
  [
    { t: "op", v: "-" },
    { t: "id", v: "qty" },
    { t: "op", v: "*" },
    { t: "num", v: "2" },
  ],
  "tokenize unary minus"
);

ok(parseTokens(tokenize("(a+b)*c").toks), "parse (a+b)*c");
ok(parseTokens(tokenize("-a * 2").toks), "parse unary minus");
ok(parseTokens(tokenize("a + + b").toks), "parse unary plus chain");
ok(!parseTokens(tokenize("a +").toks), "parse rejects trailing operator");
ok(!parseTokens(tokenize("()").toks), "parse rejects empty parens");
ok(!parseTokens(tokenize("a b").toks), "parse rejects two identifiers in a row");
ok(!parseTokens(tokenize("").toks), "parse rejects empty");

eq(
  emitJs(tokenize("qty * price").toks),
  'g("qty") * g("price")',
  "emitJs ids → g(\"…\")"
);
eq(emitJs(tokenize("(a+b)*2.5").toks), '( g("a") + g("b") ) * 2.5', "emitJs preserves parens verbatim");
eq(collectIds(tokenize("a + a + b").toks), ["a", "b"], "collectIds dedupe, order preserved");

const TOTAL_JS = calcScript('g("qty") * g("price")');
eq(
  TOTAL_JS,
  'event.value = (function(){var d=this;var g=function(n){var f=d.getField(n);if(!f){return 0;}var v=parseFloat(f.value);return isNaN(v)?0:v;};return (g("qty") * g("price"));}).call(this);',
  "calcScript exact emitted string"
);

const numFields = (names: string[]): { name: string; kind: FieldKind }[] =>
  names.map((name) => ({ name, kind: "number" }));
const FIELDS = numFields([
  "qty",
  "price",
  "discount",
  "total",
  "tax",
  "grand",
  "a",
  "b",
  "c",
  "d",
  "x",
]);
const rules = (rs: [string, string][]): CalcRule[] =>
  rs.map(([target, expr], i) => ({ id: `r${i}`, target, expr }));

// Order-form chain: total ← qty·price; tax ← total·0.18; grand ← total+tax−discount.
const calc = compileRules(
  rules([
    ["total", "qty * price"],
    ["tax", "total * 0.18"],
    ["grand", "total + tax - discount"],
  ]),
  [...FIELDS, { name: "customer", kind: "text" }]
);
ok(calc.ok, "compile order-form rules ok");
eq(calc.compiled.map((c) => c.target), ["total", "tax", "grand"], "topological order (dependencies first)");
eq(calc.compiled[0].js, calcScript('g("qty") * g("price")'), "total JS exact");
eq(calc.compiled[1].js, calcScript('g("total") * 0.18'), "tax JS exact");
eq(calc.compiled[2].js, calcScript('g("total") + g("tax") - g("discount")'), "grand JS exact");
eq(calc.compiled[2].deps, ["total", "tax", "discount"], "grand deps listed");

// Diamond: b ← a+1; c ← a+2; d ← b+c → [b, c, d].
const diamond = compileRules(
  rules([
    ["d", "b + c"],
    ["b", "a + 1"],
    ["c", "a + 2"],
  ]),
  FIELDS
);
ok(diamond.ok, "diamond ok");
eq(diamond.compiled.map((c) => c.target), ["b", "c", "d"], "diamond stable topo (definition order among ready)");

// Every error class:
eq(
  compileRules(rules([["grand", "totl + tax"]]), FIELDS).errors,
  [{ rule: 0, key: "form.calcErrUnknown", name: "totl", near: "total" }],
  "unknown identifier + near-match suggestion"
);
eq(
  compileRules(rules([["grand", "customer + 1"]]), [...FIELDS, { name: "customer", kind: "text" }]).errors,
  [{ rule: 0, key: "form.calcErrNotNumber", name: "customer" }],
  "non-number reference rejected"
);
eq(
  compileRules(rules([["customer", "qty * 2"]]), [...FIELDS, { name: "customer", kind: "text" }]).errors,
  [{ rule: 0, key: "form.calcErrTargetKind", name: "customer" }],
  "target of a text kind rejected"
);
eq(
  compileRules(rules([["nope", "2"]]), FIELDS).errors,
  [{ rule: 0, key: "form.calcErrTarget", name: "nope" }],
  "unknown target rejected"
);
eq(
  compileRules(rules([["total", ""]]), FIELDS).errors,
  [{ rule: 0, key: "form.calcErrEmpty" }],
  "empty expression rejected"
);
eq(
  compileRules(rules([["total", "2 $ 3"]]), FIELDS).errors,
  [{ rule: 0, key: "form.calcErrChar" }],
  "bad character rejected"
);
eq(
  compileRules(rules([["total", "2 +"]]), FIELDS).errors,
  [{ rule: 0, key: "form.calcErrSyntax" }],
  "syntax error rejected"
);
const dup = compileRules(
  rules([
    ["total", "qty"],
    ["total", "price"],
  ]),
  FIELDS
);
ok(!dup.ok && dup.errors.some((e) => e.key === "form.calcErrDup" && e.rule === 1), "duplicate target rejected (rule index 1)");
eq(
  compileRules(rules([["a", "b + 1"], ["b", "a - 1"]]), FIELDS).errors,
  [{ rule: -1, key: "form.calcErrCycle", detail: "a → b → a" }],
  "cycle a→b→a reported with the exact path"
);
eq(
  compileRules(rules([["x", "x + 1"]]), FIELDS).errors,
  [{ rule: -1, key: "form.calcErrCycle", detail: "x → x" }],
  "self-cycle reported"
);
eq(findCycle(new Map([["a", ["b"]], ["b", ["a"]]])), ["a", "b", "a"], "findCycle raw path");
eq(findCycle(new Map([["a", ["b"]], ["b", []]])), null, "findCycle acyclic → null");

/* ------------------------------------------------------------------ */
/* 4. EMITTED JS IS EXECUTABLE — the sandbox proof                      */
/* ------------------------------------------------------------------ */
console.log("\n[4] emitted JS executes (mock Doc.getField — ISO 32000-1 action)");

function runJs(js: string, values: Record<string, string>): unknown {
  const event: { value?: unknown } = {};
  const doc = {
    getField: (n: string) => (Object.prototype.hasOwnProperty.call(values, n) ? { value: values[n] } : null),
  };
  // The exact context Acrobat gives a field /C action: `this` = Doc, `event` global.
  const fn = new Function("event", js);
  fn.call(doc, event);
  return event.value;
}

eq(runJs(calc.compiled[0].js, { qty: "3", price: "49.5" }), 148.5, "total: 3 × 49.5 = 148.5");
eq(runJs(calc.compiled[1].js, { total: "148.5" }), 26.73, "tax: 148.5 × 0.18 = 26.73");
eq(
  runJs(calc.compiled[2].js, { total: "148.5", tax: "26.73", discount: "10" }),
  165.23,
  "grand: 148.5 + 26.73 − 10 = 165.23"
);
eq(runJs(calc.compiled[0].js, { price: "49.5" }), 0, "missing field reads 0");
eq(runJs(calc.compiled[0].js, { qty: "abc", price: "2" }), 0, "non-numeric reads 0");
eq(runJs(calc.compiled[0].js, { qty: "", price: "2" }), 0, "empty string reads 0");
const neg = compileRules(rules([["tax", "0.18 * -qty"]]), FIELDS);
ok(neg.ok, "unary minus compiles");
eq(runJs(neg.compiled[0].js, { qty: "50" }), -9, "unary minus: 0.18 × −50 = −9");
const prec = compileRules(rules([["tax", "qty + price * 2"]]), FIELDS);
eq(runJs(prec.compiled[0].js, { qty: "1", price: "2" }), 5, "precedence: 1 + 2×2 = 5 (no paren rewrite)");
const paren = compileRules(rules([["tax", "(qty + price) * 2"]]), FIELDS);
eq(runJs(paren.compiled[0].js, { qty: "1", price: "2" }), 6, "parens: (1 + 2)×2 = 6");

/* ------------------------------------------------------------------ */
/* 5. PARSE — round-trip, tamper, blanks                                */
/* ------------------------------------------------------------------ */
console.log("\n[5] parseFormDoc — round-trips, coercion, limits");

const leaveSpec = templateById("leave");
const orderSpec = templateById("order");
const eventSpec = templateById("event");
const feedbackSpec = templateById("feedback");
ok(leaveSpec !== undefined && orderSpec !== undefined && eventSpec !== undefined && feedbackSpec !== undefined, "4 templates found");
ok(templateById("nope") === undefined, "unknown template → undefined");

const orderDoc = instantiateTemplate(orderSpec!, "Order", identity);
eq(orderDoc.rules.map((r) => [r.target, r.expr]), [
  ["total", "qty * price"],
  ["tax", "total * 0.18"],
  ["grand", "total + tax - discount"],
], "order template carries the 3 rules");
const qtyEl = orderDoc.pages[0].elements.find((e) => "name" in e && e.name === "qty") as FieldEl;
eq(qtyEl.kind, "number", "order qty is a number field");
ok(qtyEl.required, "order qty required");
const priceEl = orderDoc.pages[0].elements.find((e) => "name" in e && e.name === "price") as FieldEl;
eq(priceEl.format, "rupee", "order price has ₹ format");

// Round-trip (leave, order, event): positions inside clamps → EXACT equality.
for (const [id, doc] of [["leave", instantiateTemplate(leaveSpec!, "L", identity)], ["order", orderDoc], ["event", instantiateTemplate(eventSpec!, "E", identity)]] as [string, FormDoc][]) {
  const back = parseFormDoc(JSON.parse(JSON.stringify(doc)));
  eq(back, doc, `${id}: serialize → parseFormDoc round-trip EXACT`);
}

// Feedback rating radio: h=90 with 5 options grows to 18 + 5×16 = 98 (parse clamp).
const fbDoc = instantiateTemplate(feedbackSpec!, "F", identity);
const fbBack = parseFormDoc(JSON.parse(JSON.stringify(fbDoc)));
const rating = fbBack.pages[0].elements.find((e) => "name" in e && e.name === "rating") as FieldEl;
eq(rating.h, 98, "feedback radio height grows to fit 5 options (90 → 98)");

// Tampered payload: NaN-ish, off-page, unknown kind, name dedupe, option filtering.
const tampered = parseFormDoc({
  title: "x".repeat(200),
  pages: [
    {
      elements: [
        { kind: "text", id: "a", x: "NaN-ish", y: -5, w: 99999, h: 40, fs: 99, text: "t" },
        { kind: "laser", id: "b" },
        { kind: "text", id: "c", x: 40, y: 100, w: 100, h: 18, fs: 12, text: "ok" },
        { kind: "number", id: "n1", name: "qty", x: 40, y: 200, w: 120, h: 40, label: "Q", options: ["a", 5, "b"] },
        { kind: "number", id: "n2", name: "qty", x: 40, y: 250, w: 120, h: 40, label: "Q2" },
        { kind: "radio", id: "r1", name: "pick", x: 40, y: 300, w: 200, h: 50, label: "P", options: "nope" },
      ],
    },
  ],
  rules: [{ id: "r1", target: 7, expr: 9 }],
});
eq(tampered.title.length, 120, "title sliced to 120");
eq(tampered.pages[0].elements.length, 5, "unknown kind dropped (5 of 6 survive)");
const t0 = tampered.pages[0].elements[0];
eq([t0.x, t0.y, t0.w, t0.fs], [40, 0, 753.7066666666666, 48], "geometry coerced (NaN→margin, y clamp, w clamp, fs cap)");
const names = tampered.pages[0].elements.filter((e): e is FieldEl => "name" in e).map((e) => e.name);
eq(names, ["qty", "qty_2", "pick"], "duplicate names deduped (qty, qty_2)");
const radioEl = tampered.pages[0].elements.find((e): e is FieldEl => "name" in e && e.name === "pick") as FieldEl;
eq(radioEl.options, ["Option 1", "Option 2", "Option 3"], "non-array options → kind defaults");
eq(
  compileRules(tampered.rules, tampered.pages[0].elements.filter((e): e is FieldEl => "name" in e)).errors[0].key,
  "form.calcErrNoTarget",
  "coerced rules (str 7 → '') rejected honestly — no-target fires first"
);

// >10 pages truncated.
const many = parseFormDoc({ pages: Array.from({ length: 12 }, () => ({ elements: [] })) });
eq(many.pages.length, 10, "pages capped at MAX_PAGES 10");

// Garbage.
eq(parseFormDoc("{bad json").pages.length, 1, "garbage JSON → single blank page");
eq(parseFormDoc(undefined).pages.length, 1, "undefined → blank doc");
ok(docIsEmpty(blankDoc("")), "blankDoc is empty");
ok(!docIsEmpty(orderDoc), "order template is not empty");

const nameDoc = (title: string): FormDoc => ({ title, pages: [{ id: "p1", elements: [] }], rules: [] });
eq(outputBaseName(nameDoc("My Form 2026!")), "My-Form-2026", "outputBaseName sanitizes");
eq(outputBaseName(nameDoc("!!!")), "fillable-form", "outputBaseName fallback");
eq(outputBaseName(nameDoc("")), "fillable-form", "outputBaseName empty → fallback");

/* ------------------------------------------------------------------ */
/* 6. REAL PDF BUILDS                                                   */
/* ------------------------------------------------------------------ */
console.log("\n[6] real PDF builds (render.ts + self-hosted Noto from disk)");

const fontBytes = new Uint8Array(
  readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf")
);

async function build(doc0: FormDoc): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset: true });
  drawFormPdf(doc, font, doc0);
  const bytes = await doc.save();
  ok(Buffer.from(bytes.subarray(0, 5)).toString() === "%PDF-", "saved bytes start with %PDF-");
  return await PDFDocument.load(bytes, { updateMetadata: false });
}

function fieldBy(name: string, loaded: PDFDocument) {
  return loaded.getForm().getFields().find((f) => f.getName() === name);
}
function aaJs(field: { acroField: { dict: PDFDict } }, key: "C" | "F" | "K"): string | undefined {
  const aa = field.acroField.dict.get(PDFName.of("AA"));
  if (!(aa instanceof PDFDict)) return undefined;
  const action = aa.get(PDFName.of(key));
  if (!(action instanceof PDFDict)) return undefined;
  const js = action.get(PDFName.of("JS"));
  return js instanceof PDFString ? js.asString() : undefined;
}
function contentBytes(page: { node: { Contents: () => unknown } }): Uint8Array {
  const contents = page.node.Contents();
  const streams: Uint8Array[] = [];
  const push = (s: unknown): void => {
    if (s && typeof s === "object" && "getContents" in (s as object)) {
      streams.push((s as { getContents: () => Uint8Array }).getContents());
    }
  };
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i += 1) push(contents.lookup(i));
  } else {
    push(contents);
  }
  const total = streams.reduce((n, s) => n + s.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const s of streams) {
    out.set(s, off);
    off += s.length;
  }
  return out;
}

// --- 6a. order-form template ---------------------------------------
{
  const loaded = await build(orderDoc);
  const form = loaded.getForm();
  eq(loaded.getPageCount(), 1, "order: 1 page");
  eq(form.getFields().length, 10, "order: 10 fields");
  const names10 = form.getFields().map((f) => f.getName()).sort();
  eq(
    names10,
    ["customer", "discount", "grand", "notes", "order_date", "price", "product", "qty", "tax", "total"],
    "order: field names"
  );
  const qty = form.getTextField("qty");
  ok(qty.isRequired(), "order: qty required");
  const total = form.getTextField("total");
  eq(aaJs(total, "C"), calcScript('g("qty") * g("price")'), "order: total /AA /C JS EXACT");
  eq(aaJs(total, "F"), AF_NUMBER_FORMAT, "order: total /AA /F = AFNumber_Format (calc + format coexist)");
  eq(aaJs(total, "K"), AF_NUMBER_KEYSTROKE, "order: total /AA /K = AFNumber_Keystroke");
  const tax = form.getTextField("tax");
  eq(aaJs(tax, "C"), calcScript('g("total") * 0.18'), "order: tax /AA /C JS EXACT");
  const grand = form.getTextField("grand");
  eq(aaJs(grand, "C"), calcScript('g("total") + g("tax") - g("discount")'), "order: grand /AA /C JS EXACT");
  const date = form.getTextField("order_date");
  eq(aaJs(date, "F"), AF_DATE_FORMAT, "order: date /AA /F = AFDate_FormatEx dd/mm/yyyy");
  eq(aaJs(date, "K"), 'AFDate_KeystrokeEx("dd/mm/yyyy");', "order: date /AA /K = AFDate_KeystrokeEx");
  const notes = form.getTextField("notes");
  ok(notes.isMultiline(), "order: notes is multiline");

  // /CO in topological order (compare object numbers with the field refs).
  const co = form.acroForm.dict.get(PDFName.of("CO"));
  ok(co instanceof PDFArray, "order: /CO array exists");
  if (co instanceof PDFArray) {
    const coNums = [0, 1, 2].map((i) => {
      const r = co.get(i);
      return r instanceof PDFRef ? r.objectNumber : -1;
    });
    eq(
      coNums,
      [total.ref?.objectNumber, tax.ref?.objectNumber, grand.ref?.objectNumber],
      "order: /CO lists total → tax → grand (topological)"
    );
  }
  eq(form.acroForm.dict.get(PDFName.of("NeedAppearances")), PDFBool.True, "order: NeedAppearances true");

  // The ultimate e2e: extract the /C scripts FROM THE RELOADED PDF and run
  // them in the sandbox, /CO order, like Acrobat would.
  const values: Record<string, string> = { qty: "3", price: "49.5", discount: "10" };
  const run = (f: { acroField: { dict: PDFDict } }): unknown =>
    runJs(aaJs(f, "C") ?? "", values);
  const total2 = run(total);
  values.total = String(total2);
  const tax2 = run(tax);
  values.tax = String(tax2);
  const grand2 = run(grand);
  eq([total2, tax2, grand2], [148.5, 26.73, 165.23], "order: scripts extracted from the PDF execute 148.5 → 26.73 → 165.23");
}

// --- 6b. leave template: dropdown + required + no calc ---------------
{
  const leaveDoc = instantiateTemplate(leaveSpec!, "Leave", identity);
  const loaded = await build(leaveDoc);
  const form = loaded.getForm();
  eq(form.getFields().length, 9, "leave: 9 fields");
  eq(
    form.getDropdown("leave_type").getOptions(),
    ["Casual", "Sick", "Earned", "Unpaid"],
    "leave: dropdown options verbatim"
  );
  ok(form.getTextField("applicant").isRequired(), "leave: applicant required");
  ok(!form.getTextField("designation").isRequired(), "leave: designation not required");
  eq(form.acroForm.dict.get(PDFName.of("CO")), undefined, "leave: no /CO (no rules)");
}

// --- 6c. event template: radio group export values + checkbox --------
{
  const eventDoc = instantiateTemplate(eventSpec!, "Event", identity);
  const loaded = await build(eventDoc);
  const form = loaded.getForm();
  eq(
    form.getRadioGroup("workshop").getOptions(),
    ["tpl_event_optai", "tpl_event_optweb", "tpl_event_optdesign"],
    "event: radio export values are ASCII slugs of the option labels"
  );
  const terms = form.getFields().find((f) => f.getName() === "terms");
  ok(terms instanceof PDFCheckBox, "event: terms is a checkbox");
  ok((terms as PDFCheckBox).isRequired(), "event: terms required");
  const donation = form.getTextField("donation");
  eq(aaJs(donation, "F"), AF_NUMBER_FORMAT, "event: donation (₹ format) still AFNumber_Format");
}

// --- 6d. 2-page doc: exact widget /Rect on page 2 ---------------------
{
  const doc2: FormDoc = parseFormDoc({
    title: "Two",
    pages: [
      {
        elements: [
          { kind: "heading", id: "h1", x: 40, y: 40, w: 420, h: 24, fs: 16, text: "Page one" },
          { kind: "text", id: "t1", x: 40, y: 80, w: 220, h: 40, fs: 12, label: "Who", name: "who", required: true },
        ],
      },
      {
        elements: [
          { kind: "number", id: "n1", x: 40, y: 200, w: 120, h: 40, fs: 12, label: "P", name: "amt" },
        ],
      },
    ],
  });
  const loaded = await build(doc2);
  eq(loaded.getPageCount(), 2, "two: 2 pages");
  const page2 = loaded.getPage(1); // pdf-lib getPage is ZERO-based (pinned)
  const annots = page2.node.Annots();
  ok(annots instanceof PDFArray && annots.size() === 1, "two: page 2 carries exactly 1 widget");
  if (annots instanceof PDFArray) {
    const widget = annots.lookup(0);
    ok(widget instanceof PDFDict, "two: widget is a dict");
    if (widget instanceof PDFDict) {
      const rect = widget.get(PDFName.of("Rect"));
      // boxRect: label lifts by 18 → box (40,218,120,22) → pt (30, 661.89, 120, 678.39).
      ok(rect instanceof PDFArray, "two: widget /Rect present");
      if (rect instanceof PDFArray) {
        // pdf-lib CENTERS the 1pt widget border on the rect → /Rect is the
        // requested box inflated by 0.5pt on every side (documented
        // behaviour). The requested box itself is (30, 661.89, 120, 678.39):
        // label lift 18px + y-flip (1122.52−218−22)×0.75.
        const r = [0, 1, 2, 3].map((i) => Number(rect.lookup(i)?.toString?.() ?? NaN));
        eq(
          r.map((v) => Math.round(v * 100) / 100),
          [29.5, 661.39, 120.5, 678.89],
          "two: widget /Rect = requested box ± 0.5pt centered border"
        );
      }
    }
  }
  ok(loaded.getForm().getTextField("who").isRequired(), "two: page-1 field required survives");
}

// --- 6e. maxLength + multiline + empty-label boxRect ------------------
{
  const doc3: FormDoc = parseFormDoc({
    title: "Caps",
    pages: [
      {
        elements: [
          { kind: "text", id: "t1", x: 40, y: 40, w: 220, h: 40, fs: 12, label: "L", name: "limited", maxLength: 40, required: true },
          { kind: "multiline", id: "m1", x: 40, y: 100, w: 320, h: 98, fs: 12, label: "M", name: "multi", maxLength: 200 },
          { kind: "checkbox", id: "c1", x: 40, y: 220, w: 16, h: 34, fs: 12, label: "ok", name: "agree", required: true },
        ],
      },
    ],
  });
  const loaded = await build(doc3);
  const form = loaded.getForm();
  eq(form.getTextField("limited").getMaxLength(), 40, "caps: maxLength 40 round-trips");
  eq(form.getTextField("multi").getMaxLength(), 200, "caps: multiline maxLength 200");
  ok(form.getTextField("multi").isMultiline(), "caps: multiline flag set");
  ok(form.getCheckBox("agree").isRequired(), "caps: checkbox required");
}

// --- 6f. Hindi + ₹ static text through the embedded Noto --------------
{
  const doc4: FormDoc = parseFormDoc({
    title: "हिंदी फ़ॉर्म",
    pages: [
      {
        elements: [
          { kind: "heading", id: "h1", x: 40, y: 40, w: 420, h: 24, fs: 16, text: "कुल योग ₹ राशि शब्दों में" },
          { kind: "text", id: "s1", x: 40, y: 80, w: 420, h: 18, fs: 12, text: "नाम और पता भरें" },
          { kind: "number", id: "n1", x: 40, y: 120, w: 120, h: 40, fs: 12, label: "राशि", name: "amount", format: "rupee" },
        ],
      },
    ],
  });
  const bytes0 = await (async (): Promise<Uint8Array> => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(fontBytes, { subset: true });
    drawFormPdf(doc, font, doc4);
    return await doc.save();
  })();
  const raw = Buffer.from(bytes0).toString("latin1");
  const loaded = await PDFDocument.load(bytes0, { updateMetadata: false });
  // Font program assert at the PARSE level (dictionaries can live inside
  // compressed object streams — raw byte search is unreliable): the page
  // font must be a Type0 composite whose CIDFontType2 descendant carries a
  // FontFile2/3 program in its descriptor.
  const res = loaded.getPage(0).node.Resources();
  const fontsDict = res instanceof PDFDict ? res.lookup(PDFName.of("Font"), PDFDict) : undefined;
  ok(fontsDict !== undefined && fontsDict.entries().length > 0, "hindi: page carries font resources");
  let embedded = false;
  let isType0 = false;
  if (fontsDict) {
    for (const [, v] of fontsDict.entries()) {
      const fontDict = loaded.context.lookup(v instanceof PDFRef ? v : undefined);
      if (!(fontDict instanceof PDFDict)) continue;
      const sub = fontDict.lookup(PDFName.of("Subtype"));
      if (String(sub) === "/Type0") {
        isType0 = true;
        const cid = fontDict.lookup(PDFName.of("DescendantFonts"), PDFArray)?.lookup(0, PDFDict);
        const desc = cid?.lookup(PDFName.of("FontDescriptor"), PDFDict);
        const file = desc?.get(PDFName.of("FontFile2")) ?? desc?.get(PDFName.of("FontFile3"));
        if (file instanceof PDFRef) embedded = true;
      }
    }
  }
  ok(isType0, "hindi: the page font is a Type0 composite (CID, Noto)");
  ok(embedded, "hindi: descendant font program is EMBEDDED (FontFile2/3 ref)");
  void raw;
  eq(loaded.getForm().getFields().length, 1, "hindi: 1 field");
  eq(loaded.getTitle(), "हिंदी फ़ॉर्म", "hindi: document title");
  const page = loaded.getPage(0);
  const ops = inflateSync(contentBytes(page)).toString("latin1");
  ok(ops.includes("Tj"), "hindi: content stream carries text-showing ops");
  ok(ops.length > 200, "hindi: content stream is substantial (statics drawn)");
}

// --- 6g. tampered payload still builds (never crashes) ----------------
{
  const loaded = await build(parseFormDoc("{total garbage"));
  eq(loaded.getPageCount(), 1, "tamper: garbage builds a blank 1-page form");
  eq(loaded.getForm().getFields().length, 0, "tamper: no fields");
  const bad = await build(
    parseFormDoc({
      pages: [
        { elements: [{ kind: "text", id: "t", x: 1e9, y: -1e9, w: -50, h: 0, fs: 9999, text: "x" }] },
      ],
    })
  );
  eq(bad.getForm().getFields().length, 0, "tamper: clamped static-only doc builds");
  eq(bad.getPageCount(), 1, "tamper: 1 page");
}

/* ------------------------------------------------------------------ */
/* summary                                                              */
/* ------------------------------------------------------------------ */
console.log(
  `\n${failures === 0 ? "ALL GREEN" : "FAILURES"} — ${checks - failures}/${checks} checks passed` +
    (failures ? ` (${failures} failed)` : "")
);
if (failures > 0) process.exit(1);
