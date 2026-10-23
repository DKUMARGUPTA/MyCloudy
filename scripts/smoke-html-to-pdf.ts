/**
 * Smoke: html-to-pdf (RB2-d) — HTML → PDF, 100% on-device.
 *
 * House conventions: the model's own buildSampleHtml fixture, parse
 * asserts on the typed IR, REAL renders through the worker's exact
 * render.ts (node:zlib inflate oracle for stream text, pdf-lib reload
 * + parse-level font/geometry asserts), outputBaseName vectors and
 * rejection vectors. Relative imports without .ts, process.exit at
 * the end.
 *
 * Run: bun scripts/smoke-html-to-pdf.ts
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

import {
  buildSampleHtml,
  decodeHtmlBytes,
  estimatePages,
  inputTooLarge,
  looksLikeHtml,
  MAX_BLOCKS,
  MAX_TABLE_ROWS,
  needsNoto,
  outputBaseName,
  parseHtml,
  parseHtmlRun,
  stats,
  type HtmlRun,
  type ParsedHtml,
} from "../tools/html-to-pdf/model";
import { drawHtmlPdf, type HtmlFontSet } from "../tools/html-to-pdf/render";

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
/* helpers                                                             */
/* ------------------------------------------------------------------ */

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

/**
 * pdf-lib emits text as hex tokens (<...> Tj) — literal, exact-token
 * or bare byte-sequence match (the RB1 pinned lesson).
 */
function hasText(stream: string, s: string): boolean {
  if (stream.includes(s)) return true;
  const hex = Buffer.from(s, "latin1").toString("hex").toUpperCase();
  if (stream.includes(`<${hex}>`)) return true;
  return hex.length >= 8 ? stream.includes(hex) : false;
}

const notoBytes = new Uint8Array(
  readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf")
);

/** the worker's exact EN font set (8 lazily-embedded base-14 faces). */
function enFontSet(pdfDoc: PDFDocument): HtmlFontSet {
  const cache = new Map<string, PDFFont>();
  const key = (b: boolean, i: boolean, m: boolean): string =>
    `${b ? "B" : ""}${i ? "I" : ""}${m ? "M" : ""}`;
  return {
    isNoto: false,
    resolve(bold, italic, mono) {
      const k = key(bold, italic, mono);
      const hit = cache.get(k);
      if (hit) return hit;
      let font: PDFFont;
      if (mono) {
        font = pdfDoc.embedStandardFont(
          bold && italic
            ? StandardFonts.CourierBoldOblique
            : bold
              ? StandardFonts.CourierBold
              : italic
                ? StandardFonts.CourierOblique
                : StandardFonts.Courier
        );
      } else {
        font = pdfDoc.embedStandardFont(
          bold && italic
            ? StandardFonts.HelveticaBoldOblique
            : bold
              ? StandardFonts.HelveticaBold
              : italic
                ? StandardFonts.HelveticaOblique
                : StandardFonts.Helvetica
        );
      }
      cache.set(k, font);
      return font;
    },
  };
}

async function renderHtml(
  html: string,
  opts: {
    pageSize?: "a4" | "letter";
    margin?: "normal" | "narrow";
    baseFontSize?: number;
    showLinks?: boolean;
  }
): Promise<{ bytes: Uint8Array; pages: number; doc: ParsedHtml }> {
  const doc = parseHtml(html);
  const pdfDoc = await PDFDocument.create();
  let fonts: HtmlFontSet;
  if (needsNoto(doc)) {
    pdfDoc.registerFontkit(fontkit);
    const noto = await pdfDoc.embedFont(notoBytes, { subset: true });
    fonts = { isNoto: true, resolve: () => noto };
  } else {
    fonts = enFontSet(pdfDoc);
  }
  const report = drawHtmlPdf(pdfDoc, fonts, doc, {
    pageSize: opts.pageSize ?? "a4",
    margin: opts.margin ?? "normal",
    baseFontSize: opts.baseFontSize ?? 11,
    showLinks: opts.showLinks ?? false,
  });
  const bytes = await pdfDoc.save();
  const reloaded = await PDFDocument.load(bytes);
  return { bytes, pages: reloaded.getPageCount(), doc };
}

function findRuns(doc: ParsedHtml, pred: (r: HtmlRun) => boolean): HtmlRun[] {
  const out: HtmlRun[] = [];
  for (const b of doc.blocks) {
    if (b.kind === "pre" || b.kind === "rule" || b.kind === "table") continue;
    for (const r of b.runs) if (pred(r)) out.push(r);
  }
  return out;
}

/** pure-WinAnsi EN fixture (the render vectors need NO font embed). */
const EN_FIXTURE = `<!DOCTYPE html>
<html><head><title>Test Page</title></head><body>
<h1>Big Heading</h1>
<h2>Second Level</h2>
<p>Plain paragraph with <b>bold part</b> and <i>italic part</i> and <u>underline part</u>.</p>
<p>Line one<br>Line two after break</p>
<ul><li>First bullet</li><li>Second bullet
<ol><li>Nested one</li><li>Nested two</li></ol>
</li></ul>
<blockquote><p>Quoted insight goes here</p></blockquote>
<hr>
<pre>
code line one
  code line two indented
</pre>
<p>See <a href="https://example.com/docs">the docs</a> for details.</p>
<table><tr><th>Name</th><th>Value</th></tr><tr><td>alpha</td><td>1</td></tr><tr><td>beta</td><td>2</td></tr></table>
</body></html>`;

/* ------------------------------------------------------------------ */
console.log("── 1. buildSampleHtml parse (the real fixture) ──────────");
{
  const html = buildSampleHtml();
  const doc = parseHtml(html);
  const dump = JSON.stringify(doc);
  const st = stats(doc);

  check("title extracted from <title>", doc.title === "Quarterly Report — Project Falcon", doc.title);
  check("script content excluded", !dump.includes("dataLayer") && !dump.includes("gtag"));
  check("style content excluded", !dump.includes("font-family") && !dump.includes("sans-serif"));
  check("comment excluded", !dump.includes("navigation placeholder") && !dump.includes("footer"));
  check("doctype skipped (no DOCTYPE text anywhere)", !dump.includes("DOCTYPE") && !dump.includes("doctype html"));
  check("h1 level 1 present", doc.blocks.some((b) => b.kind === "heading" && b.level === 1));
  check("h2 level 2 present", doc.blocks.some((b) => b.kind === "heading" && b.level === 2));
  check("h3 level 3 present", doc.blocks.some((b) => b.kind === "heading" && b.level === 3));
  check(
    "h1 carries the page heading text",
    doc.blocks.some(
      (b) => b.kind === "heading" && b.level === 1 && b.runs.some((r) => r.text.includes("Project Falcon"))
    )
  );

  const boldRun = findRuns(doc, (r) => r.bold && r.text.includes("Ananya Verma"));
  check("inline <b> run bold", boldRun.length === 1, boldRun);
  const italicRun = findRuns(doc, (r) => r.italic && r.text.includes("three regions"));
  check("inline <em> run italic", italicRun.length === 1, italicRun);
  const underlineRun = findRuns(doc, (r) => r.underline && r.text.includes("Note"));
  check("inline <u> run underline", underlineRun.length === 1, underlineRun);
  check("inline <strong> run bold (12% above)", findRuns(doc, (r) => r.bold && r.text.includes("12% above")).length === 1);

  const items = doc.blocks.filter((b) => b.kind === "list-item");
  const depth1 = items.filter((b) => b.kind === "list-item" && b.depth === 1);
  check("nested list depths present (depth 0 + depth 1)", items.length >= 5 && depth1.length === 2, { items: items.length, depth1: depth1.length });
  const ordered = doc.blocks.filter((b) => b.kind === "list-item" && b.ordered);
  check(
    "ordered numbers honour start=2",
    ordered.length === 2 && ordered.every((b) => b.kind === "list-item" && (b.number === 2 || b.number === 3)),
    ordered.map((b) => (b.kind === "list-item" ? b.number : null))
  );

  const quote = doc.blocks.find((b) => b.kind === "quote");
  check(
    "blockquote present with its text",
    quote !== undefined && quote.kind === "quote" && quote.runs.some((r) => r.text.includes("Fastest growth")),
    quote
  );
  check("hr rule block present", doc.blocks.some((b) => b.kind === "rule"));

  const pre = doc.blocks.find((b) => b.kind === "pre");
  check(
    "pre preserves whitespace (multi-space + newlines)",
    pre !== undefined && pre.kind === "pre" && pre.text.includes("build   6.2s") && pre.text.includes("\n"),
    pre && pre.kind === "pre" ? pre.text : pre
  );
  check("pre starts at first content line ($ falcon)", pre !== undefined && pre.kind === "pre" && pre.text.startsWith("$ falcon"));

  const table = doc.blocks.find((b) => b.kind === "table");
  check(
    "table grid dims 4×3 with header",
    table !== undefined &&
      table.kind === "table" &&
      table.grid.length === 4 &&
      table.grid[0].length === 3 &&
      table.headerRow === true,
    table && table.kind === "table" ? { rows: table.grid.length, cols: table.grid[0].length, header: table.headerRow } : table
  );
  check(
    "table cells decoded (th + td)",
    table !== undefined && table.kind === "table" && table.grid[0][0] === "Region" && table.grid[2][1] === "€ 1.4M",
    table && table.kind === "table" ? table.grid[2] : table
  );

  check("entity &amp; → &", dump.includes("& the analytics team"));
  check("entity &mdash; → —", findRuns(doc, (r) => r.text.includes("—")).length >= 2);
  check("entity &#2361; → ह (Devanagari)", findRuns(doc, (r) => r.text.includes("हिंदी")).length === 1);
  check("entity &hellip; → …", findRuns(doc, (r) => r.text.includes("…")).length === 1);
  check("entities &copy; &reg; → © ®", findRuns(doc, (r) => r.text.includes("©") && r.text.includes("®")).length === 1);

  const linkRun = findRuns(doc, (r) => r.link === "https://example.com/falcon/q3");
  check("anchor href captured on the run", linkRun.length === 1 && linkRun[0].text === "Q3 dashboard", linkRun);

  check("img alt recorded in brackets", findRuns(doc, (r) => r.text === "[Revenue chart]" && r.italic).length === 1);
  check("form controls skipped (no Subscribe / placeholder)", !dump.includes("Subscribe") && !dump.includes("you@example.com"));

  check("stats agree with blocks", st.blockCount === doc.blocks.length && st.tables === 1 && st.headings >= 4, st);
  check("word count sane", st.wordCount > 60, st.wordCount);
  check("estimatePages ≥ 1", estimatePages(doc) >= 1);
  check("needsNoto true for the sample (हिंदी)", needsNoto(doc) === true);
}

console.log("── 2. tokenizer/parser hardening ─────────────────────────");
{
  const doc = parseHtml(EN_FIXTURE);
  const dump = JSON.stringify(doc);
  check("EN fixture: title", doc.title === "Test Page");
  check("EN fixture: <br> becomes a hard break run", findRuns(doc, (r) => r.text.includes("Line one\nLine two")).length === 1, dump.slice(0, 200));
  check("EN fixture: pure WinAnsi → needsNoto false", needsNoto(doc) === false);
  const nested = doc.blocks.filter((b) => b.kind === "list-item" && b.depth === 1);
  check("EN fixture: nested ordered items depth 1", nested.length === 2 && nested.every((b) => b.kind === "list-item" && b.ordered), nested.map((b) => (b.kind === "list-item" ? b.number : null)));

  // void-element auto-close: <br> without any close inside <p>
  const voidDoc = parseHtml("<p>Before<br>After</p>");
  check("void element <br> auto-closes (no stray open)", findRuns(voidDoc, (r) => r.text === "Before\nAfter").length === 1);

  // unclosed <p>: a new <p> auto-closes the previous one
  const unclosed = parseHtml("<div><p>first para<p>second para</div>");
  const paras = unclosed.blocks.filter((b) => b.kind === "para");
  check(
    "<p>text<p>next auto-closes into two paragraphs",
    paras.length === 2 &&
      paras[0].kind === "para" &&
      paras[0].runs.some((r) => r.text.includes("first")) &&
      paras[1].kind === "para" &&
      paras[1].runs.some((r) => r.text.includes("second")),
    paras
  );

  // totally unclosed: flush at EOF
  const eofDoc = parseHtml("<div><p>only para");
  check("unclosed tags tolerated to EOF", eofDoc.blocks.filter((b) => b.kind === "para").length === 1);

  // whitespace collapse + &nbsp; survival
  const ws = parseHtml("<p>one    two\n\tthree&nbsp;&nbsp;four</p>");
  const wsRun = findRuns(ws, (r) => r.text.length > 0);
  check(
    "HTML whitespace collapsed, &nbsp; survives",
    wsRun.length === 1 && wsRun[0].text === "one two three\u00a0\u00a0four",
    wsRun
  );

  // uppercase tags + attributes with quotes
  const upDoc = parseHtml('<DIV><P STYLE="x">Hi <A HREF="https://up.example">link</A></P></DIV>');
  check(
    "case-insensitive tags and attrs",
    findRuns(upDoc, (r) => r.link === "https://up.example").length === 1,
    JSON.stringify(upDoc)
  );

  // head text (other than title) is dropped
  const headDoc = parseHtml("<html><head><title>T</title>stray head words</head><body><p>body text</p></body></html>");
  check("head content ignored except title", !JSON.stringify(headDoc).includes("stray head words") && headDoc.title === "T");

  // windows-1252 charset via <meta charset>
  const cp = decodeHtmlBytes(
    new Uint8Array([0x3c, 0x6d, 0x65, 0x74, 0x61, 0x20, 0x63, 0x68, 0x61, 0x72, 0x73, 0x65, 0x74, 0x3d, 0x22, 0x77, 0x69, 0x6e, 0x64, 0x6f, 0x77, 0x73, 0x2d, 0x31, 0x32, 0x35, 0x32, 0x22, 0x3e, 0x63, 0x61, 0x66, 0xe9]),
  );
  check("windows-1252 meta charset decoded (café)", cp.includes("café"), cp);

  // UTF-8 BOM stripped
  const bom = decodeHtmlBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x3c, 0x70, 0x3e, 0x68, 0x69, 0x3c, 0x2f, 0x70, 0x3e]));
  check("UTF-8 BOM stripped", bom === "<p>hi</p>", bom);
}

console.log("── 3. parseHtmlRun boundary coercion ─────────────────────");
{
  check("garbage JSON → empty doc", parseHtmlRun("{not json").blocks.length === 0);
  check("non-object → empty", parseHtmlRun("42").blocks.length === 0);

  const many = parseHtmlRun(
    JSON.stringify({
      title: "x",
      blocks: Array.from({ length: MAX_BLOCKS + 500 }, () => ({
        kind: "para",
        runs: [{ text: "word", bold: false, italic: false, underline: false, mono: false }],
      })),
    })
  );
  check("block clamp honoured (20k)", many.blocks.length <= MAX_BLOCKS && many.truncated === true, many.blocks.length);

  const bigTable = parseHtmlRun(
    JSON.stringify({
      blocks: [
        {
          kind: "table",
          grid: Array.from({ length: MAX_TABLE_ROWS + 50 }, () => ["a", "b"]),
        },
      ],
    })
  );
  const t = bigTable.blocks.find((b) => b.kind === "table");
  check(
    "table row clamp honoured (200)",
    t !== undefined && t.kind === "table" && t.grid.length <= MAX_TABLE_ROWS && bigTable.truncated === true,
    t && t.kind === "table" ? t.grid.length : null
  );

  const badHeading = parseHtmlRun(
    JSON.stringify({ blocks: [{ kind: "heading", level: 9, runs: [{ text: "x" }] }] })
  );
  check("heading level 9 degrades to para", badHeading.blocks[0]?.kind === "para", badHeading.blocks[0]?.kind);

  const control = parseHtmlRun(
    JSON.stringify({
      blocks: [{ kind: "para", runs: [{ text: "a\u0000b\u0007c", bold: 1, italic: "x", link: "http://e" }] }],
    })
  );
  const crun = control.blocks[0]?.kind === "para" ? control.blocks[0].runs[0] : undefined;
  check(
    "control chars stripped, booleans coerced",
    crun !== undefined && crun.text === "abc" && crun.bold === true && crun.italic === false && crun.link === "http://e",
    crun
  );

  const roundTrip = parseHtmlRun(JSON.stringify(parseHtml(EN_FIXTURE)));
  check(
    "round trip preserves block count",
    roundTrip.blocks.length === parseHtml(EN_FIXTURE).blocks.length && roundTrip.title === "Test Page"
  );
}

console.log("── 4. REAL renders (worker's exact render.ts) ───────────");
{
  const out = await renderHtml(EN_FIXTURE, {});
  check("EN: %PDF magic + size", out.bytes[0] === 0x25 && out.bytes.length > 1000, out.bytes.length);
  check("EN: single page for short doc", out.pages === 1, out.pages);
  const size = (await PDFDocument.load(out.bytes)).getPage(0).getSize();
  check("EN: A4 dims", Math.abs(size.width - 595.28) < 1 && Math.abs(size.height - 841.89) < 1, `${size.width}x${size.height}`);

  const txt = inflatedText(out.bytes);
  const needles = [
    "Big Heading",
    "Second Level",
    "bold part",
    "italic part",
    "underline part",
    "First bullet",
    "Nested one",
    "Quoted insight",
    "code line one",
    "the docs",
    "alpha",
    "beta",
  ];
  for (const n of needles) {
    check(`EN: "${n}" selectable in stream (literal or hex)`, hasText(txt, n));
  }
  check("EN: no NaN geometry", !txt.includes("NaN"));

  // EN → NO embedded font file: base-14 Helvetica/Courier only
  const enReloaded = await PDFDocument.load(out.bytes);
  const enDump = [...enReloaded.context.enumerateIndirectObjects()]
    .map(([, o]) => o.toString())
    .join("\n");
  check("EN: FontFile2 ABSENT (no embed)", !enDump.includes("FontFile2"));
  check("EN: Helvetica base font present", enDump.includes("/Helvetica"));
  check("EN: pre block → Courier font resource present", enDump.includes("/Courier"));
  check("EN: bold face present", enDump.includes("/Helvetica-Bold"));

  // vector op proofs: quote bar + underline + hr (l S), pre bg + header fill
  // (closed-path f), table borders (closed-path S) — pdf-lib draws rectangles
  // as m/l/h paths, NOT with the `re` operator.
  check("EN: blockquote accent line ops present (l S)", txt.includes("l\nS"));
  check("EN: pre background fill ops present (h f)", txt.includes("h\nf") && txt.includes("0.945 0.945 0.95 rg"));
  check("EN: table border ops present (h S)", txt.includes("h\nS") && txt.includes("0.62 0.62 0.62 RG"));

  // Letter dims
  const letterOut = await renderHtml(EN_FIXTURE, { pageSize: "letter" });
  const ls = (await PDFDocument.load(letterOut.bytes)).getPage(0).getSize();
  check("Letter dims 612×792", Math.abs(ls.width - 612) < 1 && Math.abs(ls.height - 792) < 1, `${ls.width}x${ls.height}`);

  // narrow margins + font sizes render clean
  const narrowOut = await renderHtml(EN_FIXTURE, { margin: "narrow", baseFontSize: 10 });
  check("narrow + small font renders, no NaN", !inflatedText(narrowOut.bytes).includes("NaN") && narrowOut.pages === 1);
  const largeOut = await renderHtml(EN_FIXTURE, { baseFontSize: 12.5 });
  check("large font renders", largeOut.pages >= 1 && !inflatedText(largeOut.bytes).includes("NaN"));

  // showLinks → href printed footnote-style
  const linksOut = await renderHtml(EN_FIXTURE, { showLinks: true });
  check("showLinks: href appended and searchable", hasText(inflatedText(linksOut.bytes), "https://example.com/docs"));
  const noLinksOut = await renderHtml(EN_FIXTURE, { showLinks: false });
  check("default: href NOT printed", !hasText(inflatedText(noLinksOut.bytes), "https://example.com/docs"));

  // long document paginates
  const longHtml =
    "<html><body>" +
    Array.from(
      { length: 150 },
      (_, i) => `<p>Paragraph number ${i} with several words of body text to fill the page width.</p>`
    ).join("") +
    "</body></html>";
  const longOut = await renderHtml(longHtml, {});
  check("long doc breaks pages", longOut.pages >= 3, longOut.pages);

  // Hindi render: the sample (contains हिंदी) → Noto subset embedded
  const hiOut = await renderHtml(buildSampleHtml(), {});
  check("HI: %PDF magic + size", hiOut.bytes[0] === 0x25 && hiOut.bytes.length > 1000, hiOut.bytes.length);
  const hiReloaded = await PDFDocument.load(hiOut.bytes);
  const hiDump = [...hiReloaded.context.enumerateIndirectObjects()]
    .map(([, o]) => o.toString())
    .join("\n");
  check("HI: Noto embedded (FontFile2)", hiDump.includes("FontFile2"));
  check("HI: Type0 composite (Identity-H)", hiDump.includes("Identity-H"));
  check("HI: no NaN", !inflatedText(hiOut.bytes).includes("NaN"));
  check("HI: sample renders multi-page content fine", hiOut.pages >= 1);
}

console.log("── 5. outputBaseName vectors (title-derived) ────────────");
{
  check(
    "title survives as the base name",
    outputBaseName("Quarterly Report — Project Falcon", "en") === "Quarterly Report — Project Falcon"
  );
  check("file name extension stripped", outputBaseName("my page.html", "en") === "my page");
  check(".htm stripped too", outputBaseName("old.htm", "en") === "old");
  check("empty → Webpage (en)", outputBaseName("", "en") === "Webpage");
  check("empty → वेबपेज (hi)", outputBaseName("", "hi") === "वेबपेज");
  check("whitespace-only → वेबपेज (hi)", outputBaseName("   ", "hi") === "वेबपेज");
  check("path-unsafe chars replaced", outputBaseName("a/b:c*.html", "en") === "a_b_c_");
  check("Devanagari name survives", outputBaseName("मेरा पेज.html", "en") === "मेरा पेज");
  check("long titles capped at 120", outputBaseName("x".repeat(400), "en").length <= 120);
}

console.log("── 6. rejection vectors ─────────────────────────────────");
{
  // DOCUMENTED CHOICE: plain text with no tags is REJECTED at the
  // sniff gate (looksLikeHtml) — this is an HTML tool, and the drop
  // zone + worker both use the same gate. The model itself would
  // treat bare text as one paragraph; the boundary says no.
  check("empty input rejected", looksLikeHtml("") === false);
  check("plain-text-no-tags rejected (documented choice)", looksLikeHtml("just some words here, nothing else") === false);
  check("real HTML accepted", looksLikeHtml(EN_FIXTURE) === true);
  check("doctype-only accepted", looksLikeHtml("<!DOCTYPE html>") === true);
  check("lowercase tag accepted", looksLikeHtml("hello <b>world</b>") === true);
  check("stray '1 < 2' comparison rejected", looksLikeHtml("is 1 < 2 greater? no") === false);

  // garbage bytes decode to replacement noise — no tag shape
  const garbage = decodeHtmlBytes(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x10, 0xff, 0xfe, 0x73, 0x04])
  );
  check("garbage bytes rejected at the gate", !looksLikeHtml(garbage) && garbage.length > 0);

  // empty html → no blocks → the worker errors (h2p.errNoDoc)
  const emptyHtml = parseHtml("<html><head><title>e</title></head><body></body></html>");
  check("empty html → zero blocks (worker error path)", emptyHtml.blocks.length === 0 && emptyHtml.title === "e");

  // 20 MB cap
  check("20 MB exactly allowed", inputTooLarge(20 * 1024 * 1024) === false);
  check("20 MB + 1 rejected", inputTooLarge(20 * 1024 * 1024 + 1) === true);

  // parse never throws on truncation junk
  const junk = parseHtml("<p>" + "x".repeat(50_000) + "<p>" + "y".repeat(50_000));
  check(
    "huge runs capped without throwing",
    junk.blocks.length === 2 && junk.truncated === true,
    { blocks: junk.blocks.length, truncated: junk.truncated }
  );
}

console.log(
  `\nhtml-to-pdf smoke: ${pass} passed, ${fail} failed` +
  (fail ? "\n  " + failures.join("\n  ") : "")
);
process.exit(fail === 0 ? 0 : 1);
