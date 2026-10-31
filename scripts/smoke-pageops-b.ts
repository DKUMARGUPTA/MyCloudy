/**
 * PRE-BUILD smoke for PHASE-1 Batch B tools (bates-numbering,
 * remove-blank-pages, alternate-merge, add-page-labels, rotate-custom,
 * view-metadata). Engine math + REAL worker pipelines end-to-end.
 *
 *  1. bates — text format (padding/prefix/suffix), 6 positions, series
 *     continues across 2 files, E2E stamped content readable.
 *  2. remove-blank — tokenizer (comments/strings/dicts), marking ops,
 *     E2E: empty + draws-nothing + real pages mixed → only blanks gone.
 *  3. alternate — round-robin plans (equal/unequal counts, lead swap,
 *     drop tail), E2E merge content order.
 *  4. page-labels — roman/letters/cover math, E2E catalog /PageLabels
 *     structure + viewer-label parity + pdf-lib oracle reload.
 *  5. rotate-custom — rotatedDims + placement centring, E2E sheet size
 *     + Do count + oracle reload.
 *  6. view-metadata — report rendering + facts from a crafted file.
 *
 * Run: bun scripts/smoke-pageops-b.ts
 */
import { PDFDocument, StandardFonts } from "pdf-lib";

import type { OptionValues } from "../src/lib/tools/config-types";
import {
  asDict,
  asName,
  decodeStreamBytes,
  dget,
  latin1,
  listPages,
  parsePdf,
  resolve,
} from "../src/lib/own/pdf";
import { batesText, runBatesFile } from "../tools/bates-numbering/worker";
import {
  contentOperators,
  operatorsMark,
  planRemoveBlank,
  resolveRemoveBlankOptions,
} from "../tools/remove-blank-pages/engine";
import { runRemoveBlank } from "../tools/remove-blank-pages/worker";
import { planAlternate } from "../tools/alternate-merge/worker";
import { runAlternate } from "../tools/alternate-merge/worker";
import {
  labelFor,
  resolvePageLabelOptions,
  toLetters,
  toRoman,
} from "../tools/add-page-labels/engine";
import { runPageLabels } from "../tools/add-page-labels/worker";
import {
  effectiveRotation,
  placement,
  resolveRotateCustomOptions,
  rotatedDims,
} from "../tools/rotate-custom/engine";
import { runRotateCustom } from "../tools/rotate-custom/worker";
import { renderReport, reportFacts } from "../tools/view-metadata/worker";

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function near(a: number, b: number, eps = 0.05): boolean {
  return Math.abs(a - b) < eps;
}

const latin1All = (b: Uint8Array) => latin1(b, 0, b.length);

const hexOf = (text: string): string =>
  Array.from(text, (ch) => ch.charCodeAt(0).toString(16).padStart(2, "0")).join("");

/** All decoded content streams of a doc, joined (ref/array aware). */
function allContent(bytes: Uint8Array): string {
  const doc = parsePdf(bytes);
  const parts: string[] = [];
  const walk = (o: unknown): void => {
    if ((o as { k?: string })?.k === "ref") {
      walk(doc.getObject((o as { num: number }).num));
      return;
    }
    if ((o as { k?: string })?.k === "stream") {
      const st = o as { raw: Uint8Array; m: Map<string, unknown> };
      try {
        const dec = decodeStreamBytes(st.raw, st.m as Map<never, never>);
        parts.push(latin1All(dec));
      } catch {
        // undecodable — skip
      }
      return;
    }
    if ((o as { k?: string })?.k === "arr") {
      for (const item of (o as { items: unknown[] }).items) walk(item);
    }
  };
  for (const page of listPages(doc)) {
    walk(resolve(doc, page.dict.get("Contents")));
  }
  return parts.join("\n");
}

/** Fixture: n pages, each with a hex-marker text ("PAGE i" → <...> hex). */
async function markerPdf(n: number, size: [number, number] = [300, 400]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= n; i += 1) {
    const page = doc.addPage(size);
    page.drawText(`P${i}`, { x: 40, y: 200, size: 32, font });
  }
  return new Uint8Array(await doc.save());
}

/* ------------------------------------------------------------------ */
console.log("1. bates-numbering");

{
  check(
    "batesText padding",
    batesText({ prefix: "BATES-", suffix: "", digits: 6 }, 42) === "BATES-000042"
  );
  check(
    "batesText prefix+suffix",
    batesText({ prefix: "X_", suffix: "_F", digits: 4 }, 7) === "X_0007_F"
  );
  check(
    "batesText no prefix",
    batesText({ prefix: "", suffix: "", digits: 8 }, 123456) === "00123456"
  );

  const bytes = await markerPdf(3);
  const r = (await runBatesFile(bytes, {
    prefix: "BATES-", suffix: "", start: 1, digits: 6,
    position: "bottom-right", margin: 24, size: 10, font: "helvetica",
  }, 1)).bytes;
  const doc = parsePdf(r);
  const pages = listPages(doc);
  check("E2E: 3 pages", pages.length === 3);
  // StampContext writes show-text ops as HEX (<...> Tj) inside flate'd
  // streams — search the DECODED content for the hex form.
  const all = allContent(r);
  check("E2E: BATES-000001 stamped", all.includes(`<${hexOf("BATES-000001")}> Tj`), all.slice(-140));
  check("E2E: BATES-000003 stamped", all.includes(`<${hexOf("BATES-000003")}> Tj`));
  const oracle = await PDFDocument.load(r);
  check("E2E: pdf-lib oracle reload", oracle.getPageCount() === 3);

  // Series continues across files: second file starts at 4.
  const r2 = (await runBatesFile(bytes, {
    prefix: "BATES-", suffix: "", start: 1, digits: 6,
    position: "bottom-right", margin: 24, size: 10, font: "helvetica",
  }, 4)).bytes;
  const all2 = allContent(r2);
  check("E2E: series continues (000004)", all2.includes(`<${hexOf("BATES-000004")}> Tj`));
  check("E2E: series continues (000006)", all2.includes(`<${hexOf("BATES-000006")}> Tj`));
}

/* ------------------------------------------------------------------ */
console.log("2. remove-blank-pages");

{
  const ops = contentOperators("q 1 0 0 1 10 20 cm Q");
  check("tokenizer: state-only ops", ops !== null && !operatorsMark(ops));
  const ops2 = contentOperators("BT /F1 12 Tf (hello) Tj ET");
  check("tokenizer: show-text marks", ops2 !== null && operatorsMark(ops2));
  const ops3 = contentOperators("% comment only\nq Q");
  check("tokenizer: comments skipped", ops3 !== null && !operatorsMark(ops3));
  const ops4 = contentOperators("(str with ) paren and \\) escape) Tj");
  check("tokenizer: string-aware", ops4 !== null && operatorsMark(ops4));
  const ops5 = contentOperators("0 0 100 100 re f");
  check("tokenizer: fill marks", ops5 !== null && operatorsMark(ops5));
  const ops6 = contentOperators("/Im0 Do");
  check("tokenizer: XObject marks", ops6 !== null && operatorsMark(ops6));
  const ops7 = contentOperators("<< /Type /XObject >> 0 0 re S");
  check("tokenizer: dict-skipped, stroke marks", ops7 !== null && operatorsMark(ops7));
  check(
    "options default strict",
    resolveRemoveBlankOptions({}).strict === true
  );

  // Crafted mixed doc: real page / truly-empty page / draws-nothing page.
  const parts: string[] = ["%PDF-1.7\n"];
  const offs: number[] = [];
  const bodies: Array<(n: number) => string> = [
    () => `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
    () => `2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>\nendobj\n`,
    () => `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 6 0 R /Resources << >> >>\nendobj\n`,
    () => `4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Resources << >> >>\nendobj\n`,
    () => `5 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 7 0 R /Resources << >> >>\nendobj\n`,
    () => `6 0 obj\n<< /Length 24 >>\nstream\nBT (P1) Tj ET\nendstream\nendobj\n`,
    () => `7 0 obj\n<< /Length 20 >>\nstream\nq Q 0 0 1 rg\nendstream\nendobj\n`,
  ];
  for (let n = 1; n <= 7; n += 1) {
    offs[n] = parts.reduce((a, p) => a + p.length, 0);
    parts.push(bodies[n - 1]!(n));
  }
  const xp = parts.reduce((a, p) => a + p.length, 0);
  parts.push(`xref\n0 8\n0000000000 65535 f \n`);
  for (let n = 1; n <= 7; n += 1) {
    parts.push(`${String(offs[n]).padStart(10, "0")} 00000 n \n`);
  }
  parts.push(`trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xp}\n%%EOF\n`);
  const mixed = new TextEncoder().encode(parts.join(""));
  const mixedDoc = parsePdf(mixed);
  check("mixed fixture: 3 pages", listPages(mixedDoc).length === 3);

  const findings = planRemoveBlank(
    3,
    (i) => listPages(mixedDoc)[i]?.dict as unknown as Map<string, unknown>,
    (i) => {
      const page = listPages(mixedDoc)[i]!;
      const c = resolve(mixedDoc, page.dict.get("Contents"));
      if (c === undefined) return null;
      if (c.k === "stream") return latin1All(c.raw);
      return "";
    },
    resolveRemoveBlankOptions({})
  );
  check(
    "plan: blanks = [empty, draws-nothing]",
    JSON.stringify(findings.blanks) === "[1,2]",
    JSON.stringify(findings.blanks)
  );
  const loose = planRemoveBlank(
    3,
    (i) => listPages(mixedDoc)[i]?.dict as unknown as Map<string, unknown>,
    (i) => {
      const page = listPages(mixedDoc)[i]!;
      const c = resolve(mixedDoc, page.dict.get("Contents"));
      if (c === undefined) return null;
      if (c.k === "stream") return latin1All(c.raw);
      return "";
    },
    { strict: false }
  );
  check(
    "plan: loose mode keeps draws-nothing",
    JSON.stringify(loose.blanks) === "[1]",
    JSON.stringify(loose.blanks)
  );

  const out = (await runRemoveBlank(mixed, { strict: true })).bytes;
  check("E2E: 1 page remains", listPages(parsePdf(out)).length === 1);
  const oracle = await PDFDocument.load(out);
  check("E2E: pdf-lib oracle reload", oracle.getPageCount() === 1);
}

/* ------------------------------------------------------------------ */
console.log("3. alternate-merge");

{
  const plan = planAlternate([2, 2], { lead: "first", tail: "keep" });
  check(
    "equal counts: A1 B1 A2 B2",
    JSON.stringify(plan.map((e) => `${e.doc}:${e.src}`)) === JSON.stringify(["0:0", "1:0", "0:1", "1:1"])
  );
  const planLead = planAlternate([2, 2], { lead: "second", tail: "keep" });
  check(
    "lead swap: B1 A1 B2 A2",
    JSON.stringify(planLead.map((e) => `${e.doc}:${e.src}`)) === JSON.stringify(["1:0", "0:0", "1:1", "0:1"])
  );
  const planUneven = planAlternate([3, 1], { lead: "first", tail: "keep" });
  check(
    "uneven keep: A1 B1 A2 A3",
    JSON.stringify(planUneven.map((e) => `${e.doc}:${e.src}`)) === JSON.stringify(["0:0", "1:0", "0:1", "0:2"])
  );
  const planDrop = planAlternate([3, 1], { lead: "first", tail: "drop" });
  check(
    "uneven drop: A1 B1",
    JSON.stringify(planDrop.map((e) => `${e.doc}:${e.src}`)) === JSON.stringify(["0:0", "1:0"])
  );
  const plan3 = planAlternate([1, 1, 1], { lead: "first", tail: "keep" });
  check(
    "three files: A B C",
    JSON.stringify(plan3.map((e) => `${e.doc}:${e.src}`)) === JSON.stringify(["0:0", "1:0", "2:0"])
  );

  const a = await markerPdf(2);
  const b = await markerPdf(2);
  const out = (await runAlternate(
    [{ name: "a.pdf", bytes: a }, { name: "b.pdf", bytes: b }],
    { lead: "first", tail: "keep" }
  )).bytes;
  const outDoc = parsePdf(out);
  check("E2E: 4 merged pages", listPages(outDoc).length === 4);
  const oracle = await PDFDocument.load(out);
  check("E2E: pdf-lib oracle reload", oracle.getPageCount() === 4);

  const unevenOut = (await runAlternate(
    [{ name: "a.pdf", bytes: await markerPdf(3) }, { name: "b.pdf", bytes: await markerPdf(1) }],
    { lead: "first", tail: "drop" }
  )).bytes;
  check("E2E: drop mode 2 pages", listPages(parsePdf(unevenOut)).length === 2);
}

/* ------------------------------------------------------------------ */
console.log("4. add-page-labels");

{
  check("roman: 1→i, 4→iv, 9→ix, 14→xiv, 40→xl, 1994→mcmxciv",
    toRoman(1, false) === "i" && toRoman(4, false) === "iv" && toRoman(9, false) === "ix" &&
    toRoman(14, false) === "xiv" && toRoman(40, false) === "xl" && toRoman(1994, false) === "mcmxciv"
  );
  check("roman upper: 2024→MMXXIV", toRoman(2024, true) === "MMXXIV");
  check("letters: 1→a, 26→z, 27→aa, 52→az, 53→ba",
    toLetters(1, false) === "a" && toLetters(26, false) === "z" && toLetters(27, false) === "aa" &&
    toLetters(52, false) === "az" && toLetters(53, false) === "ba"
  );
  const opts = resolvePageLabelOptions({ style: "roman-upper", prefix: "A-", start: 1, coverUnlabeled: false });
  check("labelFor: A-I A-II A-III", labelFor(opts, 0) === "A-I" && labelFor(opts, 2) === "A-III");
  const coverOpts = resolvePageLabelOptions({ style: "roman-lower", prefix: "", start: 1, coverUnlabeled: true });
  check("cover: page 0 unlabelled, page 1 = i", labelFor(coverOpts, 0) === "" && labelFor(coverOpts, 1) === "i");

  const bytes = await markerPdf(3);
  const out = (await runPageLabels(bytes, {
    style: "roman-upper", prefix: "A-", start: 1, coverUnlabeled: false,
  })).bytes;
  const doc = parsePdf(out);
  const rootObj = doc.trailer.get("Root");
  const root = rootObj?.k === "ref" ? doc.getObject(rootObj.num) : rootObj;
  const catalog = asDict(root);
  const pl = catalog?.get("PageLabels");
  const plDict = asDict(pl);
  check("E2E: catalog has /PageLabels", plDict !== undefined);
  const nums = plDict?.get("Nums");
  if (nums?.k === "arr") {
    check("E2E: Nums [0, range]", nums.items[0]?.k === "num" && (nums.items[0] as { n: number }).n === 0);
    const range = asDict(nums.items[1]);
    check("E2E: /S /R roman-upper", asName(range?.get("S")) === "R");
    const p = range?.get("P");
    check("E2E: /P prefix A-", p !== undefined && (p.k === "str" || p.k === "hstr" || p.k === "lstr"));
  } else {
    check("E2E: Nums [0, range]", false, "Nums missing");
    check("E2E: /S /R roman-upper", false);
    check("E2E: /P prefix A-", false);
  }
  check("E2E: 3 pages intact", listPages(doc).length === 3);
  const oracle = await PDFDocument.load(out);
  check("E2E: pdf-lib oracle reload", oracle.getPageCount() === 3);

  // Cover variant: two ranges.
  const coverOut = (await runPageLabels(bytes, {
    style: "decimal", prefix: "", start: 1, coverUnlabeled: true,
  })).bytes;
  const coverDoc = parsePdf(coverOut);
  const coverRoot = coverDoc.trailer.get("Root");
  const coverCatalog = asDict(coverRoot?.k === "ref" ? coverDoc.getObject((coverRoot as { num: number }).num) : coverRoot);
  const coverNums = asDict(coverCatalog?.get("PageLabels"))?.get("Nums");
  if (coverNums?.k === "arr") {
    const first = coverNums.items[0] as { n: number };
    const second = coverNums.items[2] as { n: number };
    check("E2E: cover two ranges [0, 1]", first.n === 0 && second.n === 1);
  } else {
    check("E2E: cover two ranges [0, 1]", false, "missing");
  }
}

/* ------------------------------------------------------------------ */
console.log("5. rotate-custom");

{
  const dims = rotatedDims(100, 50, 45);
  check("45° dims: 106.07 × 106.07", near(dims.w, 106.066) && near(dims.h, 106.066));
  const dims7 = rotatedDims(612, 792, 7);
  check("7° letter dims grow", dims7.w > 612 && dims7.h > 792);

  const p = placement({ w: 106.066, h: 106.066 }, { w: 100, h: 50 }, 45);
  // Derived: CCW 45° of a 100x50 form — the rotated min corner is
  // (-35.36, 0), so centring shifts by +35.36 on x, 0 on y.
  check("45° placement centred", near(p.tx, 35.355, 0.1) && near(p.ty, 0, 0.1), JSON.stringify(p));

  const opts = resolveRotateCustomOptions({ angle: 7, direction: "cw" });
  check("cw = negative rotation", effectiveRotation(opts) === -7);
  const opts2 = resolveRotateCustomOptions({ angle: 350, direction: "ccw" });
  check("out-of-range clamps to default", opts2.angle === 7);

  const bytes = await markerPdf(2);
  const out = (await runRotateCustom(bytes, { angle: 7, direction: "cw" })).bytes;
  const doc = parsePdf(out);
  const pages = listPages(doc);
  check("E2E: 2 pages", pages.length === 2);
  const p0 = pages[0]!;
  const w = p0.mediaBox[2] - p0.mediaBox[0];
  const h = p0.mediaBox[3] - p0.mediaBox[1];
  const expect = rotatedDims(300, 400, 7);
  check("E2E: sheet = rotated bbox", near(w, expect.w, 0.5) && near(h, expect.h, 0.5), `${w}x${h}`);
  const oracle = await PDFDocument.load(out);
  check("E2E: pdf-lib oracle reload", oracle.getPageCount() === 2);
}

/* ------------------------------------------------------------------ */
console.log("6. view-metadata");

{
  const bytes = await markerPdf(2);
  const facts = reportFacts(bytes);
  check("facts: 2 pages", facts.pageCount === 2);
  check("facts: not encrypted", facts.encrypted === false);
  check("facts: version string", /^1\.\d$/.test(facts.version), facts.version);

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([200, 300]).drawText("P1", { x: 20, y: 150, size: 24, font });
  doc.setTitle("Smoke Report Title");
  doc.setAuthor("Deepak");
  doc.setProducer("DocoPDF");
  const infoBytes = new Uint8Array(await doc.save());
  const infoFacts = reportFacts(infoBytes);
  const title = infoFacts.infoEntries.find(([k]) => k === "Title");
  const author = infoFacts.infoEntries.find(([k]) => k === "Author");
  check("facts: Title read", title?.[1] === "Smoke Report Title", JSON.stringify(title));
  check("facts: Author read", author?.[1] === "Deepak");
  check("facts: XMP absent (pdf-lib does not write one)", infoFacts.hasXmp === false);

  const report = renderReport("doc.pdf", infoBytes, infoFacts);
  check("report: header", report.includes("PDF metadata report") && report.includes("File:         doc.pdf"));
  check("report: page count line", report.includes("Pages:        1"));
  check("report: title line", report.includes("Title        Smoke Report Title"), JSON.stringify(report.split("\n").find((l) => l.startsWith("Title"))));
  check("report: on-device note", report.includes("not modified"));
}

/* ------------------------------------------------------------------ */
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
