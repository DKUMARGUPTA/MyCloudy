/**
 * PRE-BUILD smoke for PHASE-3 batch 3 (csv/json/xml-to-pdf, BMP codec,
 * CBZ round-trip). The pdfjs raster tools (pdf-to-bmp, pdf-to-cbz page
 * rendering) are browser-E2E covered — this smoke drives every pure
 * engine with crafted fixtures in Node.
 *
 *  1. CSV: RFC-4180 parse (quotes, embedded commas/newlines, delimiters)
 *     + table render (pages, hex content markers, oracle reload, repeat
 *     header, multi-page rows).
 *  2. JSON: pretty print (valid/invalid) + mono render with wrap.
 *  3. XML: pretty print nesting + looksLikeXml.
 *  4. BMP codec: encode → decode round-trip (bottom-up + top-down craft,
 *     8-bit palette craft, truncation + unsupported errors).
 *  5. BMP→PDF pipeline: decode + own PNG encode + CreateContext embed.
 *  6. CBZ: zipSync fixture → unzipSync round-trip + natural order.
 *  7. Registry: 134 live tools.
 *
 * Run: bun scripts/smoke-p3b3.ts
 */
import { PDFDocument } from "pdf-lib";

import { parseCsv, renderCsvTable } from "../tools/csv-to-pdf/engine";
import {
  looksLikeXml,
  prettyJson,
  prettyXml,
  renderMonoLines,
} from "../tools/mono-common/engine";
import { decodeBmp, encodeBmp } from "../tools/img-common/bmp";
import { encodePng } from "../tools/img-common/png-encode";
import { CreateContext, decodeStreamBytes, encodeWinAnsiHex, latin1, listPages, parsePdf, resolve } from "../src/lib/own/pdf";
import { zipSync, unzipSync } from "../src/lib/own/zip";
import { liveToolCount } from "../src/lib/tools/registry";

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
const hexMarker = (text: string) =>
  `<${encodeWinAnsiHex(text, "helvetica").toUpperCase()}>`;
const hexCourier = (text: string) =>
  `<${encodeWinAnsiHex(text, "courier").toUpperCase()}>`;

/** All decoded content streams of a doc, joined (object-stream safe). */
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

const A4 = { width: 595.28, height: 841.89 };

/* ------------------------------------------------------------------ */
console.log("1. csv-to-pdf — parse + table render");

{
  // RFC-4180: quoted commas, escaped quotes, embedded newline.
  const csv = [
    'Name,"Amount, INR",Notes',
    '"Doe, John","1,200","said ""hi"""',
    '"Multi","2","line\nbreak"',
    "Plain,3,no quotes",
  ].join("\n");
  const table = parseCsv(csv, ",");
  check("csv: 4 rows", table.rows.length === 4, String(table.rows.length));
  check("csv: quoted comma kept", table.rows[1]?.[1] === "Amount, INR" || table.rows[1]?.[0] === "Doe, John");
  check("csv: escaped quotes kept", table.rows[1]?.[2] === 'said "hi"');
  check("csv: embedded newline kept", table.rows[2]?.[2] === "line\nbreak");
  check("csv: sawQuotes", table.sawQuotes === true);

  // Semicolon + tab.
  check("csv: semicolon delimiter", parseCsv("a;b\nc;d", ";").rows[0]?.length === 2);
  check("csv: tab delimiter", parseCsv("a\tb\nc\td", "\t").rows[0]?.length === 2);

  // Table render.
  const ctx = CreateContext.create();
  const layout = renderCsvTable(ctx, table.rows, {
    pageSize: A4,
    fontSize: 9,
    header: true,
    zebra: true,
    grid: true,
    orientation: "portrait",
  });
  check("csv: 1 page for 4 rows", layout.pages === 1, String(layout.pages));
  check("csv: 3 columns", layout.columns === 3, String(layout.columns));
  const saved = ctx.write();
  const raw = allContent(saved);
  check("csv: header drawn (bold hex)", raw.includes(hexMarker("Name")));
  check("csv: cell drawn", raw.includes(hexMarker("no quotes")) || raw.includes(hexMarker("Plain")));
  const oracle = await PDFDocument.load(saved);
  check("csv: pdf-lib oracle reload", oracle.getPageCount() === 1);

  // Multi-page: enough rows to force a second page + repeated header.
  const many: string[][] = Array.from({ length: 120 }, (_, i) => [
    `Row ${i + 1}`,
    `Value ${i + 1}`,
    `Note ${i + 1}`,
  ]);
  const ctx2 = CreateContext.create();
  const layout2 = renderCsvTable(ctx2, many, {
    pageSize: A4,
    fontSize: 9,
    header: true,
    zebra: true,
    grid: true,
    orientation: "portrait",
  });
  const saved2 = ctx2.write();
  const raw2 = allContent(saved2);
  check("csv: multi-page (120 rows)", layout2.pages >= 2, String(layout2.pages));
  const oracle2 = await PDFDocument.load(saved2);
  check("csv: oracle pages match", oracle2.getPageCount() === layout2.pages);
  check("csv: last row drawn on page 2+", raw2.includes(hexMarker("Value 120")));
}

/* ------------------------------------------------------------------ */
console.log("2. json-to-pdf — pretty + mono render");

{
  let pretty: string;
  try {
    pretty = prettyJson('{"name":"DocoPDF","tools":[1,2,3],"nested":{"ok":true}}');
    check("json: parses", true);
  } catch {
    pretty = "";
    check("json: parses", false);
  }
  check(
    "json: pretty has indent",
    pretty.includes('\n  "name"') && pretty.includes('\n    "ok"'),
    pretty.slice(0, 60)
  );

  let threw = false;
  try {
    prettyJson("{not json");
  } catch {
    threw = true;
  }
  check("json: invalid throws", threw);

  const lines = pretty.split("\n");
  const ctx = CreateContext.create();
  const layout = renderMonoLines(ctx, lines, {
    pageSize: A4,
    orientation: "portrait",
    fontSize: 9,
    maxPages: 200,
    colorize: true,
  });
  const saved = ctx.write();
  const raw = allContent(saved);
  check("json: 1 page", layout.pages === 1, String(layout.pages));
  check("json: courier marker", raw.includes(hexCourier('"name"')) || raw.includes(hexCourier('"DocoPDF"')));
  const oracle = await PDFDocument.load(saved);
  check("json: oracle reload", oracle.getPageCount() === 1);

  // Wrapping: one 400-char line wraps across lines.
  const long = "x".repeat(400);
  const ctx2 = CreateContext.create();
  const layout2 = renderMonoLines(ctx2, [long], {
    pageSize: A4,
    orientation: "portrait",
    fontSize: 9,
    maxPages: 200,
    colorize: false,
  });
  check("json: long line wraps to 1 page still", layout2.pages === 1 && layout2.lines >= 2, `${layout2.lines}`);
}

/* ------------------------------------------------------------------ */
console.log("3. xml-to-pdf — pretty + detection");

{
  const xml = '<?xml version="1.0"?><root><item id="1">Alpha</item><item id="2">Beta</item></root>';
  const pretty = prettyXml(xml);
  check("xml: looksLikeXml", looksLikeXml(xml) && !looksLikeXml("plain text"));
  check("xml: decl on own line", pretty.startsWith('<?xml version="1.0"?>'));
  check("xml: nested indent", pretty.includes('\n  <item id="1">'));
  check("xml: text node on own line", pretty.split('\n').some((l) => l.trim() === "Alpha"));
  check("xml: two items indented", (pretty.match(/^  <item/gm) ?? []).length === 2);

  const lines = pretty.split("\n");
  const ctx = CreateContext.create();
  const layout = renderMonoLines(ctx, lines, {
    pageSize: A4,
    orientation: "portrait",
    fontSize: 9,
    maxPages: 200,
    colorize: true,
  });
  const saved = ctx.write();
  check("xml: rendered 1 page", layout.pages === 1);
  const raw = allContent(saved);
  check("xml: courier marker", raw.includes(hexCourier("<root>")) || raw.includes(hexCourier("<item id=\"1\">")));
}

/* ------------------------------------------------------------------ */
console.log("4. bmp codec — encode/decode round trip");

{
  // 3×2 RGBA test image.
  const w = 3;
  const h = 2;
  const rgba = new Uint8Array([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
    255, 255, 0, 255, 0, 255, 255, 255, 128, 128, 128, 255,
  ]);
  const bmp = encodeBmp({ width: w, height: h, rgba });
  check("bmp: BM signature", bmp[0] === 0x42 && bmp[1] === 0x4d);
  check("bmp: size field (54 + 2 padded rows)", bmp.length === 54 + 12 * 2, String(bmp.length)); // 3px*3B=9 → row padded to 12
  const decoded = decodeBmp(bmp);
  check("bmp: decode dims", decoded.width === w && decoded.height === h);
  check(
    "bmp: pixels round-trip",
    Buffer.compare(Buffer.from(decoded.rgba), Buffer.from(rgba)) === 0
  );

  // Top-down craft (negative height), 24-bit.
  const td = new Uint8Array(54 + 12 * 2);
  td[0] = 0x42; td[1] = 0x4d;
  td[14] = 40;
  td[18] = 3; // width
  td[22] = 0xff && td[22]; // placeholder
  // height = -2 (0xFFFFFFFE)
  td[22] = 0xfe; td[23] = 0xff; td[24] = 0xff; td[25] = 0xff;
  td[26] = 1;
  td[28] = 24;
  td[10] = 54;
  // Row 0 (top): red, green, blue ; Row 1: white, gray, black
  td[54] = 0; td[55] = 0; td[56] = 255; // BGR red
  td[57] = 0; td[58] = 255; td[59] = 0; // green
  td[60] = 255; td[61] = 0; td[62] = 0; // blue
  td[66] = 255; td[67] = 255; td[68] = 255; // white
  td[69] = 128; td[70] = 128; td[71] = 128; // gray
  td[72] = 0; td[73] = 0; td[74] = 0; // black
  const tdDecoded = decodeBmp(td);
  check("bmp: top-down dims", tdDecoded.width === 3 && tdDecoded.height === 2);
  check(
    "bmp: top-down first pixel red",
    tdDecoded.rgba[0] === 255 && tdDecoded.rgba[1] === 0 && tdDecoded.rgba[2] === 0
  );
  check(
    "bmp: top-down row 2 gray",
    tdDecoded.rgba[16] === 128 && tdDecoded.rgba[17] === 128 && tdDecoded.rgba[18] === 128
  );

  // 8-bit palette craft.
  const pal = new Uint8Array(54 + 4 * 256 + 8 * 2);
  pal[0] = 0x42; pal[1] = 0x4d;
  pal[14] = 40;
  pal[18] = 2; // width
  pal[22] = 2; // height (bottom-up)
  pal[26] = 1;
  pal[28] = 8; // bpp
  const dataOffset = 14 + 40 + 256 * 4;
  pal[10] = dataOffset; pal[11] = (dataOffset >> 8) & 0xff;
  // Palette: 0 = red, 1 = blue.
  const palStart = 54;
  pal[palStart + 2] = 255; // entry 0 R
  pal[palStart + 4 * 1] = 255; // entry 1 B
  // Bottom-up: stored row 0 = image bottom. Index pixels.
  pal[dataOffset] = 0; pal[dataOffset + 1] = 1;
  // Top row sits at +4 (row stride is 4 — 2 pixels padded to 4 bytes).
  pal[dataOffset + 4] = 1; pal[dataOffset + 5] = 0;
  const palDecoded = decodeBmp(pal);
  check("bmp: palette dims", palDecoded.width === 2 && palDecoded.height === 2);
  check(
    "bmp: palette colors mapped",
    palDecoded.rgba[0] === 0 && palDecoded.rgba[2] === 255 &&
    palDecoded.rgba[4] === 255 && palDecoded.rgba[6] === 0 &&
    palDecoded.rgba[8] === 255 && palDecoded.rgba[10] === 0 &&
    palDecoded.rgba[12] === 0 && palDecoded.rgba[14] === 255
  );

  // Honest errors.
  let truncated: string | null = null;
  try {
    decodeBmp(bmp.subarray(0, 60));
  } catch (error) {
    truncated = (error as Error).message;
  }
  check("bmp: truncation error", truncated === "b2p.errorTruncated", String(truncated));

  let unsupported: string | null = null;
  const rle = new Uint8Array(bmp);
  rle[30] = 1; // BI_RLE8
  try {
    decodeBmp(rle);
  } catch (error) {
    unsupported = (error as Error).message;
  }
  check("bmp: RLE unsupported error", unsupported === "b2p.errorUnsupportedBmp", String(unsupported));

  let notBmp: string | null = null;
  try {
    decodeBmp(new Uint8Array([1, 2, 3, 4]));
  } catch (error) {
    notBmp = (error as Error).message;
  }
  check("bmp: not-a-bmp error", notBmp === "b2p.errorNotBmp", String(notBmp));
}

/* ------------------------------------------------------------------ */
console.log("5. bmp→pdf pipeline — decode + own PNG + embed");

{
  const w = 4;
  const h = 4;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    rgba[i * 4] = (i * 37) % 256;
    rgba[i * 4 + 1] = (i * 73) % 256;
    rgba[i * 4 + 2] = (i * 11) % 256;
    rgba[i * 4 + 3] = 255;
  }
  const bmp = encodeBmp({ width: w, height: h, rgba });
  const decoded = decodeBmp(bmp);

  const png = encodePng(decoded.width, decoded.height, decoded.rgba);
  check("png: signature", png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47);
  check("png: IHDR dims", png[16] === 0 && png[17] === 0 && png[18] === 0 && png[19] === w && png[23] === h);

  const ctx = CreateContext.create();
  const embedded = ctx.embedPng(png);
  const ptW = (decoded.width * 72) / 96;
  const ptH = (decoded.height * 72) / 96;
  ctx.addPage(ptW, ptH).drawImage(embedded, { x: 0, y: 0, width: ptW, height: ptH });
  const saved = ctx.write();
  const oracle = await PDFDocument.load(saved);
  check("b2p: oracle reload 1 page", oracle.getPageCount() === 1);
  const raw = latin1All(saved);
  check("b2p: image XObject present", raw.includes("/Subtype /Image") || raw.includes("/Subtype/Image"));
}

/* ------------------------------------------------------------------ */
console.log("6. cbz — zip round trip + natural order");

{
  const w = 8;
  const h = 6;
  const mk = (seed: number): Uint8Array => {
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i += 1) {
      rgba[i * 4] = (i * seed) % 256;
      rgba[i * 4 + 1] = (i * seed * 3) % 256;
      rgba[i * 4 + 2] = (i * seed * 7) % 256;
      rgba[i * 4 + 3] = 255;
    }
    return encodePng(w, h, rgba);
  };
  const entries: Record<string, Uint8Array> = {
    "page-1.jpg": mk(11), // mislabeled .jpg but PNG bytes — magic wins
    "page-2.png": mk(13),
    "page-10.png": mk(17),
    "__MACOSX/junk.png": mk(19),
    "page-3.png": mk(23),
  };
  const zipped = zipSync(entries, { level: 6 });
  check("cbz: zip signature", zipped[0] === 0x50 && zipped[1] === 0x4b);

  const back = unzipSync(zipped);
  const names = Object.keys(back).filter(
    (n) => !n.startsWith("__MACOSX/") && /\.(jpe?g|png|bmp|gif)$/i.test(n)
  );
  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  check("cbz: junk skipped", names.length === 4, JSON.stringify(names));
  check(
    "cbz: natural order (2 before 10)",
    names[1] === "page-2.png" && names[2] === "page-3.png" && names[3] === "page-10.png",
    JSON.stringify(names)
  );
  check(
    "cbz: bytes round-trip",
    Buffer.compare(Buffer.from(back["page-10.png"]!), Buffer.from(entries["page-10.png"]!)) === 0
  );
}

/* ------------------------------------------------------------------ */
console.log("7. registry — live tool count");

{
  // 127 + 7 = 134 live, 137 total (3 AI deferred).
  check("registry: 141 live tools", liveToolCount === 141, String(liveToolCount));
}

/* ------------------------------------------------------------------ */
console.log("");
console.log(`smoke-p3b3: ${pass} pass, ${fail} fail`);
if (fail > 0) {
  process.exit(1);
}
