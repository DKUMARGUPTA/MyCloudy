/**
 * Smoke: rtf-to-pdf (RB2-c) — RTF → PDF, 100% on-device.
 *
 * House conventions (word-to-pdf precedent): a REAL sample built by the
 * model's own buildSampleRtf, focused mini-fixtures for the group-stack
 * state machine, node:zlib inflate oracle for stream text (with the
 * raw-stream literal fallback — OUR engine's page contents ride
 * UNCOMPRESSED), pdf-lib used ONLY as the reload/parse ORACLE
 * (page counts, FontFile2 / Identity-H via
 * enumerateIndirectObjects), relative imports without .ts,
 * process.exit at the end.
 *
 * Run: bun scripts/smoke-rtf-to-pdf.ts
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

import { PDFDocument } from "pdf-lib";
import { CreateContext } from "../src/lib/own/pdf";

import {
  MAX_PARAS,
  buildSampleRtf,
  estimatePages,
  needsNoto,
  outputBaseName,
  parseRtf,
  stats,
  type RtfDoc,
  type RtfRun,
} from "../tools/rtf-to-pdf/model";
import { drawRtfPdf, type RtfFonts } from "../tools/rtf-to-pdf/render";
import { sniffKind } from "../tools/convert-to-pdf/detect";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(label);
    console.error(`  FAIL ${label}`, actual !== undefined ? JSON.stringify(actual).slice(0, 300) : "");
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const enc = new TextEncoder();
const bytesOf = (s: string): Uint8Array => enc.encode(s);

function allText(doc: RtfDoc): string {
  let out = "";
  for (const para of doc.paras) {
    for (const run of para.runs) out += run.text;
  }
  return out;
}

function paraText(para: { runs: RtfRun[] }): string {
  return para.runs.map((r) => r.text).join("");
}

function runsOf(doc: RtfDoc, needle: string): RtfRun[] {
  const out: RtfRun[] = [];
  for (const para of doc.paras) {
    for (const run of para.runs) {
      if (run.text.includes(needle)) out.push(run);
    }
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
      out += inflateSync(Buffer.from(raw.slice(start, e), "latin1")).toString("latin1");
    } catch {
      // Not deflated — OUR engine's page contents ride raw (classic xref,
      // no /Filter): append them literally so text assertions still see
      // the <HEX> Tj operators (the P6-i readContent recipe).
      out += raw.slice(start, e);
    }
    idx = e + 9;
  }
  return out;
}

/** pdf-lib and OUR engine both emit text as hex tokens (<...> Tj) —
 *  literal, exact-token or bare byte-sequence match (the word-to-pdf
 *  pinned helper). */
function hasText(stream: string, s: string): boolean {
  if (stream.includes(s)) return true;
  const hex = Buffer.from(s, "latin1").toString("hex").toUpperCase();
  if (stream.includes(`<${hex}>`)) return true;
  return hex.length >= 8 ? stream.includes(hex) : false;
}

const notoBytes = new Uint8Array(
  readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf")
);

async function render(
  rtf: string,
  noto: boolean,
  opts: { pageSize?: "auto" | "a4" | "letter"; margin?: "auto" | "normal" | "narrow" } = {}
): Promise<{ bytes: Uint8Array; pages: number; pageW: number; pageH: number }> {
  const doc = parseRtf(bytesOf(rtf));
  if (!doc) throw new Error("fixture failed to parse");
  // The worker's exact recipe on the OWN engine (P6-m): needsNoto →
  // std keys or embedTtf → drawRtfPdf → write().
  const pdfDoc = CreateContext.create();
  let fonts: RtfFonts;
  if (noto) {
    fonts = {
      regular: { ttf: pdfDoc.embedTtf(notoBytes) },
      bold: null,
      italic: null,
      boldItalic: null,
    };
  } else {
    fonts = {
      regular: { std: "helvetica" },
      bold: "helveticaBold",
      italic: "helveticaOblique",
      boldItalic: "helveticaBoldOblique",
    };
  }
  const report = drawRtfPdf(pdfDoc, fonts, doc, {
    pageSize: opts.pageSize ?? "auto",
    margin: opts.margin ?? "auto",
  });
  const bytes = pdfDoc.write();
  const reloaded = await PDFDocument.load(bytes);
  return {
    bytes,
    pages: reloaded.getPageCount(),
    pageW: report.pageW,
    pageH: report.pageH,
  };
}

function indirectDump(bytes: Uint8Array): Promise<string> {
  return PDFDocument.load(bytes).then((doc) =>
    [...doc.context.enumerateIndirectObjects()].map(([, o]) => o.toString()).join("\n")
  );
}

/* ------------------------------------------------------------------ */
console.log("── 1. buildSampleRtf + full parse ─────────────────────");
{
  const src = buildSampleRtf();
  check("sample starts with {\\rtf1 magic", src.startsWith("{\\rtf1"), src.slice(0, 16));
  const doc = parseRtf(bytesOf(src));
  check("sample parses", doc !== null);
  if (doc) {
    check(
      "fonttbl index mapping",
      doc.fontNames[0] === "Helvetica" &&
        doc.fontNames[1] === "Times New Roman" &&
        doc.fontNames[2] === "Noto Sans Devanagari",
      doc.fontNames
    );
    check(
      "paperw/h twips→pt (12240×15840 → 612×792)",
      Math.abs(doc.pageW - 612) < 0.01 && Math.abs(doc.pageH - 792) < 0.01,
      `${doc.pageW}×${doc.pageH}`
    );
    check(
      "margins twips→pt (1440 → 72)",
      doc.margins.left === 72 && doc.margins.right === 72 && doc.margins.top === 72 && doc.margins.bottom === 72,
      doc.margins
    );
    const head = doc.paras[0];
    check("first para is the \\qc heading", head.align === "center", head.align);
    check(
      "heading run \\fs32\\b → 16 pt bold",
      head.runs[0].sizePt === 16 && head.runs[0].bold === true,
      head.runs[0]
    );
    const tabs = runsOf(doc, "Prepared by\tAnanya Verma");
    check("\\tab present in run text", tabs.length === 1 && tabs[0].text.includes("\t"), tabs[0]?.text);
    const conf = doc.paras.find((p) => paraText(p).includes("Confidential"));
    check("\\qr alignment parsed", conf !== undefined && conf.align === "right", conf?.align);
    const just = doc.paras.find((p) => p.runs.some((r) => r.text.includes("justified in the source")));
    check("\\qj alignment parsed", just !== undefined && just.align === "justify", just?.align);
    const text = allText(doc);
    check("\\u2344… decodes to नमस्ते", text.includes("नमस्ते"));
    check("\\u2342… decodes to दस्तावेज़", text.includes("दस्तावेज़"));
    check("\\u2361 decodes to ह", text.includes("ह"));
    check("\\'e9 → é", text.includes("é"));
    check("\\'93 → “", text.includes("“") && text.includes("”"));
    const crimson = runsOf(doc, "crimson");
    check(
      "colortbl RGB resolved (\\cf2 → 178,34,52)",
      crimson.length === 1 &&
        crimson[0].color !== undefined &&
        crimson[0].color.r === 178 &&
        crimson[0].color.g === 34 &&
        crimson[0].color.b === 52,
      crimson[0]?.color
    );
    const after = doc.paras.find((p) => p.runs.some((r) => r.text.includes("After the forced page break")));
    check("\\page → next para pageBreakBefore", after !== undefined && after.pageBreakBefore === true);
    const under = runsOf(doc, "stays underlined");
    check("\\ul run underline", under.length === 1 && under[0].underline === true);
    check("needsNoto true for the Hindi sample", needsNoto(doc) === true);
    const st = stats(doc);
    check("stats: paragraphs", st.paraCount >= 8, st.paraCount);
    check("stats: words", st.wordCount > 25, st.wordCount);
    check("stats: not truncated", st.truncated === false);
    check("estimatePages ≥ 2 (forced break)", estimatePages(doc) >= 2, estimatePages(doc));
  }
}

console.log("── 2. group-stack state machine (mini fixtures) ────────");
{
  // nested groups: bold on inside {…} only
  const nested = parseRtf(bytesOf("{\\rtf1\\pard A {\\b bold} B\\par}"));
  check("nested fixture parses", nested !== null);
  if (nested) {
    check("nested para count", nested.paras.length === 1, nested.paras.length);
    const runs = nested.paras[0].runs;
    check(
      "bold on/off via nested groups",
      runs.length === 3 &&
        runs[0].text === "A " && runs[0].bold === false &&
        runs[1].text === "bold" && runs[1].bold === true &&
        runs[2].text === " B" && runs[2].bold === false,
      runs
    );
  }
  // \plain resets char state
  const plain = parseRtf(bytesOf("{\\rtf1\\pard\\b\\i x \\plain y\\par}"));
  check("plain fixture parses", plain !== null);
  if (plain) {
    const runs = plain.paras[0].runs;
    check(
      "\\plain resets bold+italic",
      runs.length === 2 &&
        runs[0].bold === true && runs[0].italic === true &&
        runs[1].bold === false && runs[1].italic === false,
      runs
    );
  }
  // \pard resets alignment (persistence across \par otherwise)
  const q2 = parseRtf(bytesOf("{\\rtf1\\pard\\qc centred\\par\\pard\\ql left\\par}"));
  check(
    "\\pard resets alignment",
    q2 !== null && q2.paras[0].align === "center" && q2.paras[1].align === "left",
    q2?.paras.map((p) => p.align)
  );
  // \fs sizes
  const fs = parseRtf(bytesOf("{\\rtf1\\pard\\fs32 big\\fs20 small\\par}"));
  check(
    "\\fs half-points → pt",
    fs !== null && fs.paras[0].runs[0].sizePt === 16 && fs.paras[0].runs[1].sizePt === 10,
    fs?.paras[0].runs.map((r) => r.sizePt)
  );
  // \u decode incl. signed negative
  const u1 = parseRtf(bytesOf("{\\rtf1\\pard\\u2361?\\par}"));
  check("\\u2361? → ह", u1 !== null && allText(u1) === "ह", u1 && allText(u1));
  const u2 = parseRtf(bytesOf("{\\rtf1\\pard\\u-63192?\\par}"));
  check("\\u-63192? → न (signed 16-bit)", u2 !== null && allText(u2) === "न", u2 && allText(u2));
  const u3 = parseRtf(bytesOf("{\\rtf1\\pard\\uc2\\u2361??xy\\par}"));
  check("\\uc2 skips 2 substitution chars", u3 !== null && allText(u3) === "हxy", u3 && allText(u3));
  // \'hh WinAnsi
  const hex = parseRtf(bytesOf("{\\rtf1\\pard caf\\'e9 and \\'95 bullet\\par}"));
  const hexText = hex ? allText(hex) : "";
  check("\\'e9 → é", hexText.includes("café"), hexText);
  check("\\'95 → •", hexText.includes("•"), hexText);
  // escaped literals
  const esc = parseRtf(bytesOf("{\\rtf1\\pard a\\\\b\\{c\\}\\par}"));
  check(
    "escaped literals \\\\ \\{ \\}",
    esc !== null && allText(esc) === "a\\b{c}",
    esc && allText(esc)
  );
  // stylesheet resolution + approximation
  const st = parseRtf(
    bytesOf("{\\rtf1{\\stylesheet{\\s1\\fs32\\b Heading 1;}{\\s3\\i Fine;}}\\pard\\s1 Big\\par\\pard\\s2 Mid\\par\\pard\\s3 It\\par}")
  );
  check("stylesheet fixture parses", st !== null);
  if (st) {
    const r1 = st.paras[0].runs[0];
    check("real \\s1 style (fs32 + bold)", r1.sizePt === 16 && r1.bold === true, r1);
    const r2 = st.paras[1].runs[0];
    check("approx \\s2 → 13 pt bold", r2.sizePt === 13 && r2.bold === true, r2);
    const r3 = st.paras[2].runs[0];
    check("real \\s3 style (italic)", r3.italic === true, r3);
  }
  // tables flatten to text lines
  const tbl = parseRtf(bytesOf("{\\rtf1\\pard\\intbl a\\cell b\\cell\\row\\pard after\\par}"));
  const tblText = tbl ? allText(tbl) : "";
  check("\\cell→tab flatten, \\row→para", tbl !== null && tblText.includes("a\tb"), tblText);
  // starred + info destinations skipped
  const skip1 = parseRtf(bytesOf("{\\rtf1{\\*\\generator Riched20 10.0}\\pard keep\\par}"));
  check("{\\*\\generator} skipped", skip1 !== null && allText(skip1) === "keep", skip1 && allText(skip1));
  const skip2 = parseRtf(bytesOf("{\\rtf1{\\info{\\author John}{\\company Acme}}\\pard body\\par}"));
  check("{\\info} skipped", skip2 !== null && allText(skip2) === "body", skip2 && allText(skip2));
  const skip3 = parseRtf(bytesOf("{\\rtf1{\\pict\\picw100\\pich50 89504e470d0a1a0a}}\\pard body2\\par}"));
  check("{\\pict} hex skipped", skip3 !== null && allText(skip3) === "body2", skip3 && allText(skip3));
  const skip4 = parseRtf(
    bytesOf("{\\rtf1{\\object{\\*\\objdata\\bin 8 12345678}}\\pard body3\\par}")
  );
  check("{\\objdata \\bin} skipped", skip4 !== null && allText(skip4) === "body3", skip4 && allText(skip4));
  // header/paragraph geometry default
  const def = parseRtf(bytesOf("{\\rtf1\\pard tiny\\par}"));
  check(
    "defaults: Letter + 90 pt margins",
    def !== null &&
      Math.abs(def.pageW - 612) < 0.01 && Math.abs(def.pageH - 792) < 0.01 &&
      def.margins.left === 90,
    def && [def.pageW, def.pageH, def.margins.left]
  );
  // custom paperw/h (landscape)
  const land = parseRtf(bytesOf("{\\rtf1\\paperw15840\\paperh12240\\pard x\\par}"));
  check(
    "\\paperw15840\\paperh12240 → 792×612 pt",
    land !== null && Math.abs(land.pageW - 792) < 0.01 && Math.abs(land.pageH - 612) < 0.01,
    land && [land.pageW, land.pageH]
  );
}

console.log("── 3. outputBaseName vectors ────────────────────────────");
{
  check("strips .rtf", outputBaseName("Report v2.rtf", "en") === "Report v2");
  check("EN fallback", outputBaseName("", "en") === "Document");
  check("HI fallback", outputBaseName("", "hi") === "दस्तावेज़");
  check("bare .rtf falls back", outputBaseName(".rtf", "en") === "Document");
  check("path chars sanitized", outputBaseName("a/b:c*.rtf", "en") === "a_b_c_", outputBaseName("a/b:c*.rtf", "en"));
  check("devanagari survives", outputBaseName("रिपोर्ट.rtf", "hi") === "रिपोर्ट");
}

console.log("── 4. rejection + hardening vectors ────────────────────");
{
  check("non-RTF text → null", parseRtf(bytesOf("hello world, just a text file")) === null);
  check("empty file → null", parseRtf(new Uint8Array(0)) === null);
  check("binary junk → null", parseRtf(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])) === null);

  // unterminated group — must not hang, content survives
  const unterminated = parseRtf(bytesOf("{\\rtf1{\\fonttbl{\\f0\\fswiss Helvetica;}}\\pard\\b dangling"));
  check(
    "unterminated group parses without hang",
    unterminated !== null && allText(unterminated) === "dangling" && unterminated.paras.length === 1,
    unterminated && [unterminated.paras.length, allText(unterminated)]
  );

  // group depth cap 64
  const deep = parseRtf(bytesOf("{\\rtf1" + "{".repeat(100) + "x"));
  check("depth cap 64 → truncated", deep !== null && deep.truncated === true, deep?.truncated);

  // total token cap
  const many = parseRtf(bytesOf("{\\rtf1 " + "{}".repeat(800000)));
  check("token cap → truncated, no hang", many !== null && many.truncated === true, many?.truncated);

  // paragraph cap
  const capSrc = "{\\rtf1\\pard " + "x\\par ".repeat(MAX_PARAS + 100) + "}";
  const capped = parseRtf(bytesOf(capSrc));
  check(
    "paragraph cap honoured",
    capped !== null && capped.paras.length <= MAX_PARAS && capped.truncated === true,
    capped?.paras.length
  );
}

console.log("── 5. REAL renders (worker's exact render.ts) ──────────");
{
  const enRtf = [
    "{\\rtf1\\ansi\\ansicpg1252\\deff0",
    "{\\fonttbl{\\f0\\fswiss Helvetica;}}",
    "\\paperw12240\\paperh15840\\margl1440\\margr1440\\margt1440\\margb1440",
    "\\pard\\qc\\fs32\\b Quarterly Report\\b0\\fs20\\par",
    "\\pard\\fs20 Plain body paragraph with enough words to wrap across a couple of lines when rendered at twelve point on a letter page.\\par",
    "}",
  ].join("\n");

  const en = await render(enRtf, false);
  check("EN: %PDF magic + size", en.bytes[0] === 0x25 && en.bytes.length > 1000, en.bytes.length);
  check("EN: single page for short doc", en.pages === 1, en.pages);
  check("EN: letter dims from \\paperw", Math.abs(en.pageW - 612) < 1 && Math.abs(en.pageH - 792) < 1, `${en.pageW}×${en.pageH}`);
  const enDump = await indirectDump(en.bytes);
  check("EN: Helvetica only — FontFile2 ABSENT", !enDump.includes("FontFile2"));
  check("EN: standard font present", enDump.includes("Helvetica"));
  const txt = inflatedText(en.bytes);
  for (const needle of ["Quarterly", "Report", "Plain", "paragraph"]) {
    check(`EN: "${needle}" selectable in stream (literal or hex)`, hasText(txt, needle));
  }
  check("EN: no NaN geometry", !txt.includes("NaN"));

  const a4 = await render(enRtf, false, { pageSize: "a4" });
  check("A4 override dims", Math.abs(a4.pageW - 595.28) < 1 && Math.abs(a4.pageH - 841.89) < 1, `${a4.pageW}×${a4.pageH}`);

  const land = await render(enRtf.replace("\\paperw12240\\paperh15840", "\\paperw15840\\paperh12240"), false);
  check("landscape \\paperw15840\\paperh12240 → 792×612", Math.abs(land.pageW - 792) < 1 && Math.abs(land.pageH - 612) < 1, `${land.pageW}×${land.pageH}`);

  const narrow = await render(enRtf, false, { margin: "narrow" });
  check("narrow margin override renders", narrow.pages >= 1 && !inflatedText(narrow.bytes).includes("NaN"), narrow.pages);

  // underline + colour ops (pure-EN fixture so the rg triple is clean)
  const opsRtf = [
    "{\\rtf1\\ansi{\\fonttbl{\\f0\\fswiss Helvetica;}}",
    "{\\colortbl;\\red178\\green34\\blue52;}",
    "\\pard\\fs20 plain \\ul underlined\\ulnone  then \\cf1 crimson\\cf0  tail\\par}",
  ].join("\n");
  const ops = await render(opsRtf, false);
  const opsTxt = inflatedText(ops.bytes);
  check("underline: lineTo + stroke ops present", / l\n/.test(opsTxt) && /(^|\n)S\n/.test(opsTxt), opsTxt.slice(-400));
  check(
    "colour: rg fill operator with the \\cf1 triple",
    /0\.69\d*\s+0\.13\d*\s+0\.2\d*\s+rg/.test(opsTxt),
    (opsTxt.match(/[\d.]+ [\d.]+ [\d.]+ rg/g) ?? []).slice(0, 6)
  );
  check("ops: underlined text searchable", hasText(opsTxt, "underlined"));

  // Hindi: \u escapes → Noto subset embed
  const hi = await render(
    "{\\rtf1\\pard\\fs24 \\u2344?\\u2350?\\u2360?\\u2381?\\u2340?\\u2375? \\u2361?\\u2367?\\par}",
    true
  );
  check("HI: %PDF magic", hi.bytes[0] === 0x25 && hi.bytes.length > 1000, hi.bytes.length);
  const hiDump = await indirectDump(hi.bytes);
  check("HI: Noto embedded (FontFile2)", hiDump.includes("FontFile2"));
  check("HI: Type0 composite (Identity-H)", hiDump.includes("Identity-H"));
  check("HI: no NaN", !inflatedText(hi.bytes).includes("NaN"));

  // the full sample (EN + Hindi + tabs + colours + forced break) with Noto
  const sample = await render(buildSampleRtf(), true);
  check("sample render: forced \\page → ≥ 2 pages", sample.pages >= 2, sample.pages);
  check("sample render: letter dims", Math.abs(sample.pageW - 612) < 1 && Math.abs(sample.pageH - 792) < 1, `${sample.pageW}×${sample.pageH}`);
  const sampleTxt = inflatedText(sample.bytes);
  check("sample render: no NaN", !sampleTxt.includes("NaN"));

  // long doc flows across pages
  const longRtf =
    "{\\rtf1\\pard " +
    Array.from({ length: 120 }, (_, i) => `\\fs20 Paragraph number ${i} with several words of body text to fill the page.\\par`).join(" ") +
    "}";
  const longOut = await render(longRtf, false);
  check("long doc breaks pages", longOut.pages >= 3, longOut.pages);
}

console.log("── 6. universal-converter RTF routing (detect.ts) ──────");
{
  // FIX-3 regression: a .rtf dropped on "Convert to PDF" is plain text, so
  // before the magic sniff it fell through to txt — routing to txt-to-pdf,
  // which prints raw control words. sniffKind must pin the {\rtf magic and
  // hand the file to THIS tool.
  const rtf = sniffKind(
    bytesOf("{\\rtf1\\ansi\\pard hello \\b bold\\b0\\par}"),
    "letter.rtf"
  );
  check("rtf magic → kind rtf", rtf.kind === "rtf", rtf.kind);
  check("rtf label key", rtf.labelKey === "conv.kindRtf", rtf.labelKey);

  // BOM-prefixed RTF (TextEdit writes these) still sniffs as RTF.
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytesOf("{\\rtf1 hi}")]);
  check("BOM + rtf magic → kind rtf", sniffKind(bom, "x.rtf").kind === "rtf");

  // Honest neighbours: plain text stays txt, an SVG stays svg — the new
  // branch must not over-trigger.
  check(
    "plain text → txt",
    sniffKind(bytesOf("hello world"), "a.txt").kind === "txt"
  );
  check(
    "svg → svg",
    sniffKind(bytesOf('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), "a.svg").kind ===
      "svg"
  );
  check(
    "text mentioning rtf mid-body → txt",
    sniffKind(bytesOf("we talk about {\\rtf only later"), "a.txt").kind === "txt"
  );
  const bogus = sniffKind(bytesOf("hello not an rtf"), "renamed.rtf");
  check(
    "content wins over .rtf name (no magic → txt)",
    bogus.kind === "txt",
    bogus.kind
  );
}

console.log(
  `\nrtf-to-pdf smoke: ${pass} passed, ${fail} failed` +
  (fail ? "\n  " + failures.join("\n  ") : "")
);
process.exit(fail === 0 ? 0 : 1);
