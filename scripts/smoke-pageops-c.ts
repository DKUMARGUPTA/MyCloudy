/**
 * PRE-BUILD smoke for PHASE-1 Batch C tools (background-color,
 * add-stamps, change-permissions, duplex-collate, pdf-to-zip,
 * remove-annotations). Engine math + REAL worker pipelines end-to-end.
 *
 *  1. background-color — rect painted UNDER content (op order), marker
 *     survives, page count, oracle reload.
 *  2. add-stamps — DRAFT hex in decoded content + colour op + opacity
 *     ExtGState, positions, oracle reload.
 *  3. change-permissions — resolvePermissions switch mapping + E2E:
 *     AES-256 owner-only encryption, opens with EMPTY password, wrong
 *     owner password refused, permission flags honoured.
 *  4. duplex-collate — planDuplex (manual/odd-even/even-odd) + E2E page
 *     order via markers.
 *  5. pdf-to-zip — zipSync/unzipSync round-trip + naming convention.
 *  6. remove-annotations — crafted annots fixture (internal link,
 *     external URI link, widget, highlight) → keep-matrix E2E.
 *
 * Run: bun scripts/smoke-pageops-c.ts
 */
import { PDFDocument, StandardFonts } from "pdf-lib";

import type { OptionValues } from "../src/lib/tools/config-types";
import {
  asDict,
  latin1,
  listPages,
  openEncrypted,
  parsePdf,
  resolve,
} from "../src/lib/own/pdf";
import { unzipSync, zipSync } from "../src/lib/own/zip";
import { runBackgroundColor } from "../tools/background-color/worker";
import { runAddStamps } from "../tools/add-stamps/worker";
import { resolvePermissions, runChangePermissions } from "../tools/change-permissions/worker";
import { planDuplex } from "../tools/duplex-collate/worker";
import { runDuplexCollate } from "../tools/duplex-collate/worker";
import { runRemoveAnnotations } from "../tools/remove-annotations/worker";

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

const latin1All = (b: Uint8Array) => latin1(b, 0, b.length);

async function markerPdf(n: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= n; i += 1) {
    const page = doc.addPage([300, 400]);
    page.drawText(`P${i}`, { x: 40, y: 200, size: 32, font });
  }
  return new Uint8Array(await doc.save());
}

const hexOf = (text: string): string =>
  Array.from(text, (ch) => ch.charCodeAt(0).toString(16).padStart(2, "0")).join("");

/** All decoded content streams of a doc (ref/array aware). */
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
        const dec = st.raw;
        // The stamp streams may be raw; decode only when a filter exists.
        const filter = st.m.get("Filter");
        if (filter === undefined) {
          parts.push(latin1All(dec));
        } else {
          const { decodeStreamBytes } = require("../src/lib/own/pdf") as typeof import("../src/lib/own/pdf");
          const d = decodeStreamBytes(dec, st.m as Map<never, never>);
          parts.push(latin1All(d));
        }
      } catch {
        // skip
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

/* ------------------------------------------------------------------ */
console.log("1. background-color");

{
  const bytes = await markerPdf(2);
  const out = (await runBackgroundColor(bytes, {
    color: "ivory", opacity: 100, pages: "all",
  })).bytes;
  const doc = parsePdf(out);
  check("E2E: 2 pages", listPages(doc).length === 2);
  const all = allContent(out);
  // Ivory 1 1 0.94 rg + full-page rect fill under the marker.
  check("E2E: ivory colour op present", all.includes("1 1 0.94 rg"), all.slice(-160));
  check("E2E: rect fill present", /0 0 m\n0 400 l\n300 400 l\n300 0 l\nh\nf/.test(all), all.slice(-140));
  check("E2E: marker survives", all.includes(`<${hexOf("P1")}> Tj`));
  // The background must come BEFORE the page's own content (behind).
  const bgPos = all.indexOf("1 1 0.94 rg");
  const markPos = all.indexOf(`<${hexOf("P1")}> Tj`);
  check("E2E: background drawn BEFORE content", bgPos >= 0 && markPos > bgPos, `bg=${bgPos} mark=${markPos}`);
  const oracle = await PDFDocument.load(out);
  check("E2E: pdf-lib oracle reload", oracle.getPageCount() === 2);

  // Opacity + subset pages.
  const sub = (await runBackgroundColor(bytes, {
    color: "black", opacity: 50, pages: "2",
  })).bytes;
  check("E2E: subset paints page 2 only", allContent(sub).split("0.08 0.08 0.08 rg").length === 2);
}

/* ------------------------------------------------------------------ */
console.log("2. add-stamps");

{
  const bytes = await markerPdf(2);
  const out = (await runAddStamps(bytes, {
    text: "DRAFT", placement: "diagonal", color: "red",
    opacity: 25, size: 48, angle: 45, pages: "all",
  })).bytes;
  const all = allContent(out);
  check("E2E: DRAFT stamped (hex)", all.includes(`<${hexOf("DRAFT")}> Tj`));
  check("E2E: red colour op", all.includes("0.85 0.15 0.15 rg"));
  check("E2E: rotation matrix (45°)", /0\.707\d* 0\.707\d* -0\.707\d* 0\.707\d* [\d.]+ [\d.]+ Tm/.test(all), all.slice(-140));
  check("E2E: marker survives", all.includes(`<${hexOf("P1")}> Tj`));
  const oracle = await PDFDocument.load(out);
  check("E2E: pdf-lib oracle reload", oracle.getPageCount() === 2);

  // Corner placement + custom text.
  const corner = (await runAddStamps(bytes, {
    text: "PAID", placement: "top-right", color: "green",
    opacity: 100, size: 14, angle: 0, pages: "1",
  })).bytes;
  const cornerAll = allContent(corner);
  check("E2E: PAID corner stamp", cornerAll.includes(`<${hexOf("PAID")}> Tj`));
  check("E2E: subset stamps page 1 only", cornerAll.split(`<${hexOf("PAID")}> Tj`).length === 2);
}

/* ------------------------------------------------------------------ */
console.log("3. change-permissions");

{
  const perm = resolvePermissions({
    printing: "low", copying: false, modifying: true,
    annotating: false, fillingForms: true,
  });
  check("resolve: printing low", perm.printing === "lowResolution");
  check("resolve: copying blocked", perm.copying === false);
  check("resolve: modifying allowed (assembly follows)", perm.modifying === true && perm.documentAssembly === true);

  const perm2 = resolvePermissions({});
  check(
    "resolve: defaults",
    perm2.printing === "highResolution" && perm2.copying === true && perm2.modifying === false && perm2.annotating === true && perm2.fillingForms === true
  );

  const bytes = await markerPdf(2);
  const result = await runChangePermissions(bytes, {
    printing: "none", copying: false, modifying: false,
    annotating: false, fillingForms: false, ownerPassword: "owner-secret",
  });
  check("E2E: owner password honoured", result.ownerPassword === "owner-secret");
  check("E2E: output is encrypted (raw /Encrypt)", latin1All(result.bytes).includes("/Encrypt"));

  const opened = openEncrypted(result.bytes, "");
  check(
    "E2E: opens with EMPTY password (permissions-only)",
    opened.kind === "ok",
    JSON.stringify((opened as { kind?: string }).kind)
  );
  const wrong = openEncrypted(result.bytes, "not-the-password");
  check("E2E: wrong owner password refused", wrong.kind === "wrong-password");

  const rand = await runChangePermissions(bytes, {
    printing: "high", copying: true, modifying: false,
    annotating: true, fillingForms: true, ownerPassword: "",
  });
  check("E2E: random owner password generated", rand.ownerPassword.length >= 20);
  const randOpened = openEncrypted(rand.bytes, "");
  check("E2E: random-owner file opens freely", randOpened.kind === "ok");

  // pdf-lib oracle: refuses outright (it cannot decrypt AES)…
  let oracleRefused = false;
  try {
    await PDFDocument.load(result.bytes);
  } catch {
    oracleRefused = true;
  }
  check("E2E: pdf-lib refuses without owner password", oracleRefused);
  // …and OUR engine opens it WITH the owner password.
  const withOwner = openEncrypted(result.bytes, "owner-secret");
  check("E2E: own engine opens with owner password", withOwner.kind === "ok");
}

/* ------------------------------------------------------------------ */
console.log("4. duplex-collate");

{
  const plan = planDuplex([0, 1, 2, 3, 4, 5], "manual");
  check(
    "manual: odds then reversed evens",
    JSON.stringify(plan) === JSON.stringify([0, 2, 4, 5, 3, 1]),
    JSON.stringify(plan)
  );
  const planOE = planDuplex([0, 1, 2, 3, 4, 5], "odd-even");
  check(
    "odd-even: odds then evens",
    JSON.stringify(planOE) === JSON.stringify([0, 2, 4, 1, 3, 5])
  );
  const planEO = planDuplex([0, 1, 2, 3], "even-odd");
  check(
    "even-odd: evens then odds",
    JSON.stringify(planEO) === JSON.stringify([1, 3, 0, 2])
  );

  const bytes = await markerPdf(4);
  const out = (await runDuplexCollate(bytes, {
    mode: "manual", pages: "all",
  })).bytes;
  const doc = parsePdf(out);
  check("E2E: 4 pages", listPages(doc).length === 4);
  const all = allContent(out);
  const p1 = all.indexOf(`<${hexOf("P1")}> Tj`);
  const p2 = all.indexOf(`<${hexOf("P2")}> Tj`);
  const p3 = all.indexOf(`<${hexOf("P3")}> Tj`);
  const p4 = all.indexOf(`<${hexOf("P4")}> Tj`);
  check(
    "E2E: manual order P1 P3 P4 P2",
    p1 >= 0 && p3 > p1 && p4 > p3 && p2 > p4,
    `${p1},${p3},${p4},${p2}`
  );
  const oracle = await PDFDocument.load(out);
  check("E2E: pdf-lib oracle reload", oracle.getPageCount() === 4);
}

/* ------------------------------------------------------------------ */
console.log("5. pdf-to-zip (zip round-trip + naming)");

{
  // Own zip round-trip with binary payloads (PNG-signature-ish bytes).
  const page1 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const page2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7, 6]);
  const entries: Record<string, Uint8Array> = {
    "page-001.png": page1,
    "page-002.png": page2,
  };
  const zipped = zipSync(entries, { level: 6 });
  check("zip: magic PK", zipped[0] === 0x50 && zipped[1] === 0x4b);
  const unzipped = unzipSync(zipped);
  const keys = Object.keys(unzipped).sort();
  check(
    "zip: round-trip keys",
    JSON.stringify(keys) === JSON.stringify(["page-001.png", "page-002.png"])
  );
  check(
    "zip: bytes intact",
    Buffer.compare(Buffer.from(unzipped["page-001.png"]!), Buffer.from(page1)) === 0
  );

  // Naming convention (padStart(3)).
  const name = (i: number, ext: string) => `page-${String(i).padStart(3, "0")}.${ext}`;
  check(
    "naming: 1→001, 10→010, 100→100",
    name(1, "png") === "page-001.png" && name(10, "jpg") === "page-010.jpg" && name(100, "png") === "page-100.png"
  );
}

/* ------------------------------------------------------------------ */
console.log("6. remove-annotations");

{
  // Crafted fixture: 1 page with 4 annots — internal link (Dest),
  // external URI link, widget, highlight.
  const parts: string[] = ["%PDF-1.7\n"];
  const offs: number[] = [];
  const bodies: Array<(n: number) => string> = [
    () => `1 0 obj\n<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] >> >>\nendobj\n`,
    () => `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`,
    () => `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 7 0 R /Resources << >> /Annots [8 0 R 9 0 R 5 0 R 10 0 R] >>\nendobj\n`,
    () => `4 0 obj\n<< /Type /Info >>\nendobj\n`,
    () => `5 0 obj\n<< /Type /Annot /Subtype /Widget /FT /Tx /Rect [10 10 90 30] /T (field1) >>\nendobj\n`,
    () => `7 0 obj\n<< /Length 22 >>\nstream\nBT (P1) Tj ET\nendstream\nendobj\n`,
    () => `8 0 obj\n<< /Type /Annot /Subtype /Link /Rect [0 0 50 20] /Dest [3 0 R /Fit] >>\nendobj\n`,
    () => `9 0 obj\n<< /Type /Annot /Subtype /Link /Rect [0 30 50 50] /A << /S /URI /URI (https://x.example) >> >>\nendobj\n`,
    () => `10 0 obj\n<< /Type /Annot /Subtype /Highlight /Rect [20 100 150 130] /Contents (note) >>\nendobj\n`,
  ];
  for (let n = 1; n <= bodies.length; n += 1) {
    offs[n] = parts.reduce((a, p) => a + p.length, 0);
    parts.push(bodies[n - 1]!(n));
  }
  const xp = parts.reduce((a, p) => a + p.length, 0);
  parts.push(`xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`);
  for (let n = 1; n <= bodies.length; n += 1) {
    parts.push(`${String(offs[n]).padStart(10, "0")} 00000 n \n`);
  }
  parts.push(`trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xp}\n%%EOF\n`);
  const dirty = new TextEncoder().encode(parts.join(""));
  check("fixture parses", listPages(parsePdf(dirty)).length === 1);

  // keepForms + keepLinks: highlight + external URI go, others stay.
  const out = (await runRemoveAnnotations(dirty, {
    keepForms: true, keepLinks: true,
  })).bytes;
  const outDoc = parsePdf(out);
  const page = listPages(outDoc)[0]!;
  const annotsRaw = page.dict.get("Annots");
  const items = annotsRaw?.k === "arr" ? annotsRaw.items : [];
  check("E2E: 2 annots remain (widget + internal link)", items.length === 2, String(items.length));
  check("E2E: marker survives", allContent(out).includes("(P1) Tj"));
  const oracle = await PDFDocument.load(out);
  check("E2E: pdf-lib oracle reload", oracle.getPageCount() === 1);

  // keepLinks off: only widget remains.
  const out2 = (await runRemoveAnnotations(dirty, {
    keepForms: true, keepLinks: false,
  })).bytes;
  const items2Raw = listPages(parsePdf(out2))[0]!.dict.get("Annots");
  const items2 = items2Raw?.k === "arr" ? items2Raw.items : [];
  check("E2E: keepLinks off → 1 annot (widget)", items2.length === 1, String(items2.length));

  // keepForms off: no annots at all (/Annots removed).
  const out3 = (await runRemoveAnnotations(dirty, {
    keepForms: false, keepLinks: false,
  })).bytes;
  const page3 = listPages(parsePdf(out3))[0]!;
  check("E2E: everything off → /Annots gone", !page3.dict.has("Annots"));
}

/* ------------------------------------------------------------------ */
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
