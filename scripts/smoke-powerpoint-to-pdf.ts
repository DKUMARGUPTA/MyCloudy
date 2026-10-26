/**
 * Smoke: powerpoint-to-pdf (RB2-a) — .pptx → PDF, 100% on-device.
 *
 * House conventions: real fixture built with the model's own fflate
 * zipSync builder, node:zlib inflateRaw oracle for the ZIP entries
 * (NOT fflate), pdf-lib reload + parse-level asserts, real renders by
 * importing the worker's exact render.ts, relative imports without
 * .ts, process.exit at the end.
 *
 * Run: bun scripts/smoke-powerpoint-to-pdf.ts
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";
import { inflateRawSync, inflateSync } from "node:zlib";

import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { strToU8, zipSync } from "../src/lib/own/zip/index";

import {
  buildSamplePptx,
  estimatePages,
  needsNoto,
  outputBaseName,
  parsePptx,
  parsePptxRun,
  PptxParseError,
  statsSlides,
} from "../tools/powerpoint-to-pdf/model";
import { drawPptxPdf, type PptRenderOpts } from "../tools/powerpoint-to-pdf/render";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(label);
    console.error(
      `  FAIL ${label}`,
      actual !== undefined ? JSON.stringify(actual).slice(0, 300) : ""
    );
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * ZIP oracle — walks the central directory and inflates each entry
 * with node:zlib (raw deflate), completely independent of fflate.
 */
function unzipOracle(bytes: Uint8Array): Map<string, Uint8Array> {
  const buf = Buffer.from(bytes);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("no EOCD");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOff = buf.readUInt32LE(eocd + 16);
  let p = cdOff;
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad CD signature");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");
    if (buf.readUInt32LE(localOff) !== 0x04034b50) {
      throw new Error("bad local header signature");
    }
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.slice(dataStart, dataStart + compSize);
    const data = method === 0 ? comp : inflateRawSync(comp);
    out.set(name, new Uint8Array(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function inflatedText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  let out = "";
  let idx = 0;
  for (;;) {
    const s = raw.indexOf("stream", idx);
    if (s < 0) break;
    let start = s + 6;
    if (raw[start] === "\r") start++;
    if (raw[start] === "\n") start++;
    const e = raw.indexOf("endstream", start);
    if (e < 0) break;
    try {
      out += inflateSync(Buffer.from(raw.slice(start, e), "latin1")).toString(
        "latin1"
      );
    } catch {
      /* non-flate stream (font) */
    }
    idx = e + 9;
  }
  return out;
}

/** pdf-lib emits text as hex tokens (<...> Tj) — literal, exact-token
 *  or bare byte-sequence match. */
function hasText(stream: string, s: string): boolean {
  if (stream.includes(s)) return true;
  const hex = Buffer.from(s, "latin1").toString("hex").toUpperCase();
  if (stream.includes(`<${hex}>`)) return true;
  return hex.length >= 8 ? stream.includes(hex) : false;
}

const notoBytes = new Uint8Array(
  readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf")
);

const near = (a: number, b: number, tol = 0.5): boolean =>
  Math.abs(a - b) <= tol;

/* ------------------------------------------------------------------ */
console.log("── 1. sample deck + node:zlib ZIP oracle ────────────────");
{
  const pptx = buildSamplePptx();
  check("fixture is a zip (PK)", pptx[0] === 0x50 && pptx[1] === 0x4b);
  check(
    "local magic PK\\x03\\x04",
    pptx[2] === 0x03 && pptx[3] === 0x04
  );

  let entries: Map<string, Uint8Array>;
  try {
    entries = unzipOracle(pptx);
  } catch (error) {
    entries = new Map();
    check("oracle walks the archive", false, String(error));
  }
  const names = [
    "[Content_Types].xml",
    "_rels/.rels",
    "ppt/presentation.xml",
    "ppt/_rels/presentation.xml.rels",
    "ppt/slides/slide1.xml",
    "ppt/slides/slide2.xml",
    "ppt/slides/_rels/slide1.xml.rels",
    "ppt/notesSlides/notesSlide1.xml",
    "ppt/slideMasters/slideMaster1.xml",
    "ppt/slideLayouts/slideLayout1.xml",
    "ppt/theme/theme1.xml",
  ];
  for (const n of names) {
    check(`zip entry ${n}`, entries.has(n));
  }
  const pres = entries.get("ppt/presentation.xml");
  check(
    "oracle-inflated presentation has 16:9 sldSz",
    pres !== undefined &&
      Buffer.from(pres).toString("utf8").includes('cx="12192000" cy="6858000"')
  );
  const s1 = entries.get("ppt/slides/slide1.xml");
  check(
    "oracle-inflated slide1 has the title",
    s1 !== undefined &&
      Buffer.from(s1).toString("utf8").includes("Quarterly Report")
  );
  const notes = entries.get("ppt/notesSlides/notesSlide1.xml");
  check(
    "oracle-inflated notesSlide has the notes",
    notes !== undefined &&
      Buffer.from(notes).toString("utf8").includes("highlight the 24%")
  );
}

console.log("── 2. parsePptx on the sample ────────────────────────────");
{
  const ppt = parsePptx(buildSamplePptx());
  check("slide count", ppt.slides.length === 2, ppt.slides.length);
  check("slide size 960×540 pt", near(ppt.slideW, 960, 0.01) && near(ppt.slideH, 540, 0.01), `${ppt.slideW}x${ppt.slideH}`);
  check("16:9 aspect", near(ppt.slideW / ppt.slideH, 16 / 9, 0.001));

  const s1 = ppt.slides[0]!;
  check("slide 1 shape count", s1.shapes.length === 2, s1.shapes.length);
  const title = s1.shapes[0]!;
  check("title box in pt", near(title.x, 72) && near(title.y, 36) && near(title.w, 816) && near(title.h, 108), `${title.x},${title.y},${title.w},${title.h}`);
  check("title placeholder detected", title.isTitle === true);
  const trun = title.paras[0]?.runs[0];
  check(
    "title run parsed (text/size/bold/color)",
    trun?.text === "Quarterly Report" &&
      trun?.sizePt === 44 &&
      trun?.bold === true &&
      trun?.color === "1F2937",
    trun
  );

  const body = s1.shapes[1]!;
  check("body box in pt", near(body.x, 72) && near(body.y, 144) && near(body.w, 816) && near(body.h, 360), `${body.x},${body.y},${body.w},${body.h}`);
  check("body is not a title", body.isTitle === false);
  check("body para count", body.paras.length === 3, body.paras.length);
  const p0 = body.paras[0]!;
  check("bullet paragraph flagged", p0.bullet === true);
  check("non-bullet paragraph", body.paras[2]?.bullet === undefined);
  check(
    "bold mid-run parsed",
    p0.runs.some((r) => r.text === "grew 24%" && r.bold === true && r.sizePt === 20)
  );
  const p1 = body.paras[1]!;
  const ital = p1.runs.find((r) => r.italic === true);
  check("italic + colour run parsed", ital?.color === "C0392B" && ital.sizePt === 20, ital);

  const s2 = ppt.slides[1]!;
  check("slide 2 shape count (group flattened)", s2.shapes.length === 3, s2.shapes.length);
  const step1 = s2.shapes[1]!;
  check(
    "group child 1 scaled to pt (2× chExt)",
    near(step1.x, 72) && near(step1.y, 144) && near(step1.w, 720) && near(step1.h, 180),
    `${step1.x},${step1.y},${step1.w},${step1.h}`
  );
  const step2 = s2.shapes[2]!;
  check(
    "group child 2 scaled to pt",
    near(step2.x, 72) && near(step2.y, 324) && near(step2.w, 720) && near(step2.h, 180),
    `${step2.x},${step2.y},${step2.w},${step2.h}`
  );
  check("group child text", step1.paras[0]?.runs[0]?.text === "Step one");

  check(
    "notes parsed for slide 1",
    s1.notes.includes("highlight") && s1.notes.includes("Wrap up"),
    s1.notes
  );
  check("slide 2 has no notes", s2.notes.trim() === "", s2.notes);

  const stats = statsSlides(ppt.slides);
  check("statsSlides counts", stats.slides === 2 && stats.shapes === 5 && stats.notesSlides === 1, stats);
  check("statsSlides words", stats.words >= 20, stats.words);
  check("estimatePages without notes", estimatePages(ppt.slides, false) === 2);
  check("estimatePages with notes", estimatePages(ppt.slides, true) === 4);
  check("needsNoto false for EN deck", needsNoto(ppt) === false);
  check("needsNoto true for Devanagari heading", needsNoto(ppt, "स्लाइड {n} — नोट्स") === true);
}

console.log("── 3. 4:3 custom deck + parse hardening ─────────────────");
{
  const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const NS =
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const fourThirds = zipSync({
    "[Content_Types].xml": strToU8(
      XML_DECL +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
        "</Types>"
    ),
    "_rels/.rels": strToU8(
      XML_DECL +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
        "</Relationships>"
    ),
    "ppt/presentation.xml": strToU8(
      XML_DECL +
        `<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>` +
        '<p:sldSz cx="9144000" cy="6858000"/></p:presentation>'
    ),
    "ppt/_rels/presentation.xml.rels": strToU8(
      XML_DECL +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>' +
        "</Relationships>"
    ),
    "ppt/slides/slide1.xml": strToU8(
      XML_DECL +
        `<p:sld ${NS}><p:cSld><p:spTree>` +
        "<p:grpSpPr/>" +
        "<p:sp><p:nvSpPr><p:cNvPr id=\"2\" name=\"T\"/><p:cNvSpPr/><p:nvPr><p:ph type=\"ctrTitle\"/></p:nvPr></p:nvSpPr>" +
        '<p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="8229600" cy="914400"/></a:xfrm></p:spPr>' +
        "<p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz=\"4000\"/><a:t>Four by Three</a:t></a:r></a:p></p:txBody>" +
        "</p:sp></p:spTree></p:cSld></p:sld>"
    ),
  });
  const ppt = parsePptx(fourThirds);
  check("4:3 slide size", near(ppt.slideW, 720, 0.01) && near(ppt.slideH, 540, 0.01), `${ppt.slideW}x${ppt.slideH}`);
  check("4:3 title box", near(ppt.slides[0]!.shapes[0]!.x, 36) && near(ppt.slides[0]!.shapes[0]!.h, 72));
  check("ctrTitle detected as title", ppt.slides[0]!.shapes[0]!.isTitle === true);

  // boundary coercion
  const garbage = parsePptxRun(JSON.stringify({ nonsense: true }));
  check("parsePptxRun garbage → empty", garbage.slides.length === 0);
  const tampered = parsePptxRun(
    JSON.stringify({
      slides: [
        {
          shapes: [
            {
              x: "not a number",
              y: -99999,
              w: 1e9,
              h: 12,
              paras: [
                {
                  runs: [
                    { text: "ok", bold: "yes", sizePt: 999, color: "xyz" },
                    { text: 42 },
                  ],
                  align: "diagonal",
                  bullet: "no",
                },
              ],
              isTitle: 1,
            },
          ],
          notes: 7,
        },
      ],
    })
  );
  check("tampered run coerced", tampered.slides.length === 1);
  const tshape = tampered.slides[0]!.shapes[0]!;
  check(
    "tampered fields clamped to sane numbers",
    tshape.x === 0 && tshape.y === -1440 && tshape.w === 4032 && tshape.h === 12,
    tshape
  );
  const trun = tshape.paras[0]!.runs[0]!;
  check(
    "tampered run dropped bad fields",
    trun.text === "ok" && trun.bold === false && trun.sizePt === undefined && trun.color === undefined,
    trun
  );
  check("tampered align dropped", tshape.paras[0]!.align === undefined);
  check("tampered notes coerced", tampered.slides[0]!.notes === "");
}

console.log("── 4. REAL renders (worker's exact render.ts) ────────────");
interface RenderOpts {
  noto: boolean;
  pageSize: PptRenderOpts["pageSize"];
  notes?: boolean;
  fit?: boolean;
  margin?: "normal" | "narrow";
  overflow?: boolean;
  hindi?: boolean;
}
async function render(o: RenderOpts): Promise<{
  bytes: Uint8Array;
  pages: number;
  report: ReturnType<typeof drawPptxPdf>;
}> {
  const parsed = parsePptx(buildSamplePptx({ hindi: o.hindi, overflow: o.overflow }));
  const pdfDoc = await PDFDocument.create();
  let font: PDFFont;
  let boldFont: PDFFont | null = null;
  if (o.noto) {
    pdfDoc.registerFontkit(fontkit);
    font = await pdfDoc.embedFont(notoBytes, { subset: true });
  } else {
    font = pdfDoc.embedStandardFont(StandardFonts.Helvetica);
    boldFont = pdfDoc.embedStandardFont(StandardFonts.HelveticaBold);
  }
  const report = drawPptxPdf(pdfDoc, font, boldFont, parsed, {
    pageSize: o.pageSize,
    margin: o.margin ?? "normal",
    notes: o.notes === true,
    fit: o.fit === true,
    notesHeadingFmt: o.hindi ? "स्लाइड {n} — नोट्स" : "Slide {n} — notes",
  });
  const bytes = await pdfDoc.save();
  const reloaded = await PDFDocument.load(bytes);
  return { bytes, pages: reloaded.getPageCount(), report };
}

{
  const out = await render({ noto: false, pageSize: "slide-native" });
  check("EN: %PDF magic + size", out.bytes[0] === 0x25 && out.bytes.length > 1000, out.bytes.length);
  check("EN: one page per slide", out.pages === 2, out.pages);
  const doc = await PDFDocument.load(out.bytes);
  const size = doc.getPage(0).getSize();
  check(
    "slide-native page dims = sldSz/12700 (960×540)",
    near(size.width, 960) && near(size.height, 540),
    `${size.width}x${size.height}`
  );
  const dump = [...doc.context.enumerateIndirectObjects()]
    .map(([, o]) => o.toString())
    .join("\n");
  check("EN: Helvetica in resources", dump.includes("/Helvetica"));
  check("EN: Helvetica-Bold embedded for titles", dump.includes("Helvetica-Bold"));
  check("EN: NO FontFile2 (no embed)", !dump.includes("FontFile2"));
  const txt = inflatedText(out.bytes);
  for (const n of ["Quarterly", "Report", "Revenue", "grew", "Next", "Steps", "Step", "one", "two", "targets"]) {
    check(`EN: "${n}" selectable in stream`, hasText(txt, n));
  }
  check("EN: bullets drawn as real text", txt.includes("<95>") || txt.includes("<2022>"));
  check("EN: no NaN geometry", !txt.includes("NaN"));
  check("EN: no overflow in the sample", out.report.overflowed === 0, out.report.overflowed);

  const a4 = await render({ noto: false, pageSize: "a4" });
  const a4Size = (await PDFDocument.load(a4.bytes)).getPage(0).getSize();
  check("A4 landscape dims", near(a4Size.width, 841.89) && near(a4Size.height, 595.28), `${a4Size.width}x${a4Size.height}`);

  const letter = await render({ noto: false, pageSize: "letter" });
  const lSize = (await PDFDocument.load(letter.bytes)).getPage(0).getSize();
  check("Letter landscape dims", near(lSize.width, 792) && near(lSize.height, 612), `${lSize.width}x${lSize.height}`);

  const fitOut = await render({ noto: false, pageSize: "a4", fit: true });
  check(
    "fit-to-width still 2 pages + no NaN",
    fitOut.pages === 2 && !inflatedText(fitOut.bytes).includes("NaN")
  );

  const narrowOut = await render({ noto: false, pageSize: "a4", margin: "narrow" });
  check("narrow margins render", narrowOut.pages === 2);
}

console.log("── 5. Hindi render + notes pages ────────────────────────");
{
  const hi = await render({ noto: true, pageSize: "slide-native", hindi: true });
  check("HI: %PDF magic", hi.bytes[0] === 0x25 && hi.bytes.length > 1000, hi.bytes.length);
  check("HI: 2 slide pages", hi.pages === 2, hi.pages);
  const hiDoc = await PDFDocument.load(hi.bytes);
  const hiSize = hiDoc.getPage(0).getSize();
  check("HI: slide-native dims", near(hiSize.width, 960) && near(hiSize.height, 540));
  const hiDump = [...hiDoc.context.enumerateIndirectObjects()]
    .map(([, o]) => o.toString())
    .join("\n");
  check("HI: Noto embedded (FontFile2)", hiDump.includes("FontFile2"));
  check("HI: Type0 composite", hiDump.includes("Identity-H"));
  check("HI: no NaN", !inflatedText(hi.bytes).includes("NaN"));

  const enNotes = await render({ noto: false, pageSize: "slide-native", notes: true });
  check("notes on → slides + notes pages", enNotes.pages === 4, enNotes.pages);
  check("notes pages counted", enNotes.report.notesPages === 2, enNotes.report.notesPages);
  const notesTxt = inflatedText(enNotes.bytes);
  check("notes heading drawn", hasText(notesTxt, "Slide 1 — notes") || hasText(notesTxt, "notes"));
  check("notes text searchable (only in notes)", hasText(notesTxt, "highlight"));
  check("notes text searchable 2", hasText(notesTxt, "Wrap"));
  const enNoNotes = await render({ noto: false, pageSize: "slide-native", notes: false });
  check("notes off → notes text absent", !hasText(inflatedText(enNoNotes.bytes), "highlight"));

  const hiNotes = await render({ noto: true, pageSize: "slide-native", hindi: true, notes: true });
  check("HI notes render (4 pages)", hiNotes.pages === 4, hiNotes.pages);
  const hiNotesDump = [...(await PDFDocument.load(hiNotes.bytes)).context.enumerateIndirectObjects()]
    .map(([, o]) => o.toString())
    .join("\n");
  check("HI notes still embeds Noto", hiNotesDump.includes("FontFile2"));
}

console.log("── 6. overflow honesty ──────────────────────────────────");
{
  const out = await render({ noto: false, pageSize: "slide-native", overflow: true });
  check("overflowing text still renders (2 pages)", out.pages === 2, out.pages);
  check("overflow counted in report", out.report.overflowed >= 1, out.report.overflowed);
  check("overflowing text still drawn", hasText(inflatedText(out.bytes), "taller"));
  check("overflow render has no NaN", !inflatedText(out.bytes).includes("NaN"));
}

console.log("── 7. outputBaseName vectors ────────────────────────────");
{
  check("spaces → hyphens", outputBaseName("My Deck.pptx", "en") === "My-Deck", outputBaseName("My Deck.pptx", "en"));
  check("multi-space collapse", outputBaseName("Quarterly  Report 2024.pptx", "en") === "Quarterly-Report-2024");
  check("EN fallback word", outputBaseName("", "en") === "Presentation");
  check("HI fallback word", outputBaseName("", "hi") === "प्रेज़ेंटेशन");
  check("HI fallback on extension-only name", outputBaseName(".pptx", "hi") === "प्रेज़ेंटेशन");
  const hi = outputBaseName("रिपोर्ट: फ़ाइनल?.pptx", "hi");
  check("Devanagari survives + path chars stripped", hi.includes("रिपोर्ट") && !/[?:]/.test(hi), hi);
  const trav = outputBaseName("..\\..\\evil/name.pptx", "en");
  check("path traversal stripped", !trav.includes("/") && !trav.includes("\\") && !trav.includes(":"), trav);
  check("long name capped", outputBaseName("x".repeat(300) + ".pptx", "en").length <= 120);
}

console.log("── 8. rejection vectors ─────────────────────────────────");
{
  const expectCode = (fn: () => unknown, code: string): void => {
    try {
      fn();
      check(`throws ${code}`, false, "no throw");
    } catch (error) {
      check(
        `throws ${code}`,
        error instanceof PptxParseError && error.code === code,
        error instanceof Error ? error.message : String(error)
      );
    }
  };
  expectCode(() => parsePptx(new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05])), "pptx-not-zip");
  expectCode(
    () =>
      parsePptx(
        new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3, 4])
      ),
    "pptx-legacy"
  );
  expectCode(() => parsePptx(zipSync({})), "pptx-corrupt");

  // a zip with a presentation but zero slides → empty
  const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const noSlides = zipSync({
    "ppt/presentation.xml": strToU8(
      XML_DECL +
        '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst/><p:sldSz cx="12192000" cy="6858000"/></p:presentation>'
    ),
  });
  expectCode(() => parsePptx(noSlides), "pptx-empty");
}

console.log(
  `\npowerpoint-to-pdf smoke: ${pass} passed, ${fail} failed` +
    (fail ? "\n  " + failures.join("\n  ") : "")
);
process.exit(fail === 0 ? 0 : 1);
