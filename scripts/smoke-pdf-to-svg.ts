/**
 * Smoke: pdf-to-svg (RB4-SMOKE-a) — PDF → standalone vector SVG, 100% on-device.
 *
 * House conventions: real fixtures built with pdf-lib, the operator
 * lists + font/image object pools pulled through pdfjs-dist/legacy
 * in-process (the worker's exact resolution path — poolFor/resolveObj/
 * toFontInfo/raw-data images, the same helpers tools/pdf-to-svg/worker.ts
 * uses), node:zlib inflateSync as the INDEPENDENT oracle for the
 * embedded-PNG payload (chunk walk + Sub-filter decode — NOT fflate,
 * NOT the tool's own decoder), local imports without .ts, plain check()
 * helper, process.exit at the end.
 *
 *  1. Pure helpers — xmlEscape, sanitizeSvgText, fmt, mul, colorToHex,
 *     toFontInfo (incl. real pdf.js exportData shapes), opsTable picks,
 *     fixDevanagariVisual (matra + reph + idempotence), parseSvgOptions,
 *     sanitizeSvgBase, svgOutputName, classifySvgError, parseConstructPath
 *     tamper vectors.
 *  2. Synthetic extraction (buildPageSvg driven directly with the REAL
 *     pdfjs OPS table) — text placement/size/fill, bold/italic, TJ piece
 *     splits with exact pen math (hScale×TJ), hostile-glyph escaping,
 *     Devanagari visual→logical repair, invisible render mode, unknown
 *     fonts, rect fast path (+ negative extents), baked M/L path, dash,
 *     even-odd fill, endPath vs clip+paint, save/restore CTM, form
 *     XObject matrices, setGState LW/D/Font, word/char spacing pen,
 *     images (named/repeat/inline, includeImages switch, honest skips),
 *     stroke width under scale + /Rotate 90 (singular-value average),
 *     MAX_ELEMENTS truncation.
 *  3. REAL fixture — a 4-page Letter PDF (EN text hierarchy + bold/
 *     italic runs + XML-hostile text + rectangle/line/genuine `re`
 *     shapes; a Devanagari page with the self-hosted Noto subset; an
 *     embedded-image page; a /Rotate 90 page) built with pdf-lib,
 *     walked through the ACTUAL model pipeline on real pdf.js operator
 *     lists: xmlns/viewBox in exact PDF points, positioned <text> with
 *     exact x/y/font-size/fill, escaped &amp;/&lt;/&gt;/&quot;, Hindi
 *     as repaired UTF-8 (raw visual order proven first), <rect> from
 *     the real `re` operator, baked <path> d strings, the <image>
 *     element with the exact device matrix + an independently
 *     zlib-decoded pixel-exact PNG payload, the rotated page's
 *     transform + local-frame tspan coordinates.
 *  4. Page-range subset — parsePageSpec vectors, single vs multi output
 *     naming, subset content isolation.
 *  5. Rejection vectors — an @cantoo-encrypted PDF (pdf.js demands a
 *     password) → tool.errorEncrypted; garbage bytes → tool.errorCorrupt.
 *  6. Wiring — config/registry/configs/surfaces routed, worker honesty
 *     patterns (document shim, cMaps, invalid-pages guard, naming).
 *  7. i18n — tools/pdf-to-svg/i18n.json en/hi parity, every psvg.* key
 *     used by the surface/config resolves in BOTH src/i18n catalogs
 *     (the merged psvg namespace).
 *
 * Run: bun scripts/smoke-pdf-to-svg.ts
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";
import {
  fill,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
} from "pdf-lib";
import { PDFDocument as CantooPDF } from "@cantoo/pdf-lib";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  buildPageSvg,
  classifySvgError,
  colorToHex,
  fixDevanagariVisual,
  fmt,
  MAX_ELEMENTS,
  MAX_IMAGE_SIDE,
  mul,
  opsTable,
  parseConstructPath,
  parseSvgOptions,
  sanitizeSvgBase,
  sanitizeSvgText,
  SVG_MIME,
  svgOutputName,
  toFontInfo,
  xmlEscape,
  type GlyphObject,
  type SvgFontInfo,
  type SvgImagePayload,
  type SvgOpsTable,
  type SvgOperatorList,
  type SvgPageContext,
} from "../tools/pdf-to-svg/model";
import { parsePageSpec } from "../src/lib/workers/protocol";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(label);
    console.error(
      `  FAIL ${label}`,
      actual !== undefined ? JSON.stringify(actual).slice(0, 400) : ""
    );
  }
}

/** ASCII needles only for latin1-safe hasText-style checks; plain
 * Devanagari .includes() is fine (house rule). */
function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Minimal XML well-formedness (balanced tags, no raw < in text). */
function xmlWellFormed(xml: string): boolean {
  const src = xml
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "");
  const tagRe =
    /<(\/?)([A-Za-z_:][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  const stack: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(src)) !== null) {
    if (src.slice(lastIndex, match.index).includes("<")) return false;
    lastIndex = tagRe.lastIndex;
    const [full, close, name, , selfClose] = match;
    if (selfClose === "/" || full.startsWith("<?") || full.startsWith("<!")) {
      continue;
    }
    if (close === "/") {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name);
    }
  }
  if (src.slice(lastIndex).includes("<")) return false;
  return stack.length === 0;
}

/* ================================================================== */
console.log("── 1. pure helpers ──────────────────────────────────────");
/* ================================================================== */

check(
  "xmlEscape covers & < > \" '",
  xmlEscape(`a & b < c > d "e" 'f'`) ===
    "a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;"
);
check("xmlEscape keeps Devanagari intact", xmlEscape("प्रिया शर्मा") === "प्रिया शर्मा");

check(
  "sanitizeSvgText: controls → space, C0/C1 dropped, Devanagari kept",
  sanitizeSvgText("a\tb\nc\rd\u0000e\u007ff\u009fग") === "ab c d e fग",
  sanitizeSvgText("a\tb\nc\rd\u0000e\u007ff\u009fग")
);
check("sanitizeSvgText keeps plain ASCII", sanitizeSvgText("Hello 42") === "Hello 42");

check("fmt rounds to 2 decimals", fmt(1.2349) === "1.23" && fmt(1.995) === "2");
check("fmt strips trailing zeros", fmt(2.5) === "2.5" && fmt(10) === "10");
check("fmt maps -0 and NaN to 0", fmt(-0) === "0" && fmt(NaN) === "0" && fmt(Infinity) === "0");

check(
  "mul composes matrices in PDF order",
  JSON.stringify(mul([1, 0, 0, -1, 0, 792], [2, 0, 0, 2, 10, 20])) ===
    JSON.stringify([2, 0, 0, -2, 10, 772]),
  mul([1, 0, 0, -1, 0, 792], [2, 0, 0, 2, 10, 20])
);
check(
  "mul is non-commutative (translation order matters)",
  JSON.stringify(mul([1, 0, 0, 1, 10, 0], [1, 0, 0, 1, 0, 5])) !==
    JSON.stringify(mul([1, 0, 0, 1, 0, 5], [1, 0, 0, 1, 10, 0])),
  [
    mul([1, 0, 0, 1, 10, 0], [1, 0, 0, 1, 0, 5]),
    mul([1, 0, 0, 1, 0, 5], [1, 0, 0, 1, 10, 0]),
  ]
);

check(
  "colorToHex maps a pdf.js Uint8ClampedArray(3)",
  colorToHex([51, 102, 153]) === "#336699",
  colorToHex([51, 102, 153])
);
check("colorToHex clamps > 255", colorToHex([300, 0, 0]) === "#ff0000");
check(
  "colorToHex rejects garbage",
  colorToHex(null) === null &&
    colorToHex("red") === null &&
    colorToHex([1, 2]) === null &&
    colorToHex([-5, 0, 0]) === null &&
    colorToHex([NaN, 0, 0]) === null
);

/* ---------------- toFontInfo (real pdf.js exportData shapes) -------- */
check(
  "toFontInfo: real pdf.js standard-font object (Helvetica-Bold)",
  (() => {
    const info = toFontInfo({
      name: "Helvetica-Bold",
      fallbackName: "sans-serif",
      bold: true,
      italic: false,
    });
    return (
      info !== null &&
      info.family === "Helvetica-Bold" &&
      info.generic === "sans-serif" &&
      info.bold === true &&
      info.italic === false &&
      info.fontMatrix0 === 0.001
    );
  })()
);
check(
  "toFontInfo: embedded Noto object carries its fontMatrix",
  (() => {
    const info = toFontInfo({
      name: "NotoSansDevanagari-Regular-735",
      fallbackName: "sans-serif",
      fontMatrix: [0.001, 0, 0, 0.001, 0, 0],
    });
    return (
      info !== null &&
      info.family === "NotoSansDevanagari-Regular-735" &&
      info.fontMatrix0 === 0.001 &&
      info.bold === false
    );
  })()
);
check(
  "toFontInfo: bold detected from the name when the flag is absent",
  toFontInfo({ name: "Arial-Black" })?.bold === true &&
    toFontInfo({ name: "Times-Italic" })?.italic === true
);
check(
  "toFontInfo: generic classification",
  toFontInfo({ name: "Courier" })?.generic === "monospace" &&
    toFontInfo({ name: "Times-Roman" })?.generic === "serif" &&
    toFontInfo({ name: "Verdana" })?.generic === "sans-serif"
);
check(
  "toFontInfo: fallbackName used when name is absent",
  (() => {
    const info = toFontInfo({ fallbackName: "monospace" });
    return info !== null && info.family === "monospace" && info.generic === "monospace";
  })()
);
check(
  "toFontInfo: null/undefined/garbage → null",
  toFontInfo(null) === null &&
    toFontInfo(undefined) === null &&
    toFontInfo("bold") === null &&
    toFontInfo({})?.family === "sans-serif"
);
check(
  "toFontInfo: non-standard fontMatrix0 honoured",
  toFontInfo({ name: "Weird", fontMatrix: [0.002, 0, 0, 0.002, 0, 0] })?.fontMatrix0 === 0.002
);

/* ---------------- fixDevanagariVisual ---------------- */
check(
  "fixDevanagariVisual repairs a pre-base matra",
  fixDevanagariVisual("िप्रया शर्मा") === "प्रिया शर्मा"
);
check(
  "fixDevanagariVisual repairs the fixture's shaped output",
  fixDevanagariVisual("त्रैमािसक िरपोटर्") === "त्रैमासिक रिपोर्ट"
);
check(
  "fixDevanagariVisual repairs a dangling reph",
  fixDevanagariVisual("पोटर्") === "पोर्ट"
);
check(
  "fixDevanagariVisual leaves the logical ligature form alone",
  fixDevanagariVisual("र्पोट") === "र्पोट"
);
check("fixDevanagariVisual leaves plain text", fixDevanagariVisual("hello नमस्ते") === "hello नमस्ते");
check(
  "fixDevanagariVisual is idempotent",
  (() => {
    const shaped = "िप्रया शमार् की िडवाइस";
    return fixDevanagariVisual(fixDevanagariVisual(shaped)) === fixDevanagariVisual(shaped);
  })()
);

/* ---------------- option coercion + naming ---------------- */
{
  const defaults = parseSvgOptions({});
  check(
    "parseSvgOptions honest defaults",
    defaults.pages === "all" && defaults.includeImages === true,
    defaults
  );
  const full = parseSvgOptions({ pages: "1-3, 5", includeImages: false });
  check(
    "parseSvgOptions honours every field",
    full.pages === "1-3, 5" && full.includeImages === false
  );
  const garbage = parseSvgOptions({ pages: 42, includeImages: "no" });
  check(
    "parseSvgOptions: wrong types degrade (switch stays truthy-safe)",
    garbage.pages === "all" && garbage.includeImages === true,
    garbage
  );
  check("parseSvgOptions keeps a blank pages spec as all", parseSvgOptions({ pages: "   " }).pages === "all");
}

check("sanitizeSvgBase strips .pdf", sanitizeSvgBase("My Report.pdf") === "My Report");
check(
  "sanitizeSvgBase replaces path-unsafe chars",
  sanitizeSvgBase('we/ird*name?.pdf') === "we_ird_name_"
);
check("sanitizeSvgBase keeps Devanagari", sanitizeSvgBase("रिपोर्ट final.pdf") === "रिपोर्ट final");
check("sanitizeSvgBase clamps to 120 chars", sanitizeSvgBase(`${"y".repeat(200)}.pdf`).length === 120);
check("sanitizeSvgBase empty → document", sanitizeSvgBase(".pdf") === "document" && sanitizeSvgBase("") === "document");

check(
  "svgOutputName single page → base.svg",
  svgOutputName("report", 1, true) === "report.svg"
);
check(
  "svgOutputName multi page → base_pageN.svg",
  svgOutputName("report", 3, false) === "report_page3.svg"
);

check(
  "classifySvgError: password → encrypted, canvas → generic, else corrupt",
  classifySvgError("PasswordException: No password given") === "tool.errorEncrypted" &&
    classifySvgError("Incorrect Password") === "tool.errorEncrypted" &&
    classifySvgError("Cannot use canvas") === "tool.errorGeneric" &&
    classifySvgError("Invalid PDF structure") === "tool.errorCorrupt"
);

check("SVG_MIME is image/svg+xml", SVG_MIME === "image/svg+xml");
check("honest guards: element cap + image side", MAX_ELEMENTS === 20000 && MAX_IMAGE_SIDE === 16384);

/* ---------------- opsTable picks ---------------- */
{
  const table = opsTable(OPS as unknown as Record<string, unknown>);
  check(
    "opsTable picks the real pdfjs codes",
    table.setFont === OPS.setFont &&
      table.constructPath === OPS.constructPath &&
      table.rectangle === OPS.rectangle &&
      table.showText === OPS.showText &&
      table.paintImageXObject === OPS.paintImageXObject,
    { setFont: table.setFont, constructPath: table.constructPath }
  );
  const tampered = opsTable({
    save: "x",
    restore: 3.5,
    transform: 91,
  });
  check(
    "opsTable: non-integer/missing values become -1",
    tampered.save === -1 && tampered.restore === -1 && tampered.transform === 91 && tampered.fill === -1,
    tampered
  );
}

/* ---------------- parseConstructPath tamper vectors ---------------- */
{
  const ops = opsTable(OPS as unknown as Record<string, unknown>);
  check(
    "parseConstructPath parses a pure rectangle",
    (() => {
      const p = parseConstructPath(ops, [
        [OPS.rectangle],
        [100, 200, 50, 30],
        [100, 200, 150, 230],
      ]);
      return (
        p !== null &&
        p.rect !== null &&
        p.rect.x === 100 &&
        p.rect.y === 200 &&
        p.rect.w === 50 &&
        p.rect.h === 30 &&
        p.cmds.length === 5
      );
    })()
  );
  check(
    "parseConstructPath normalizes negative extents",
    (() => {
      const p = parseConstructPath(ops, [
        [OPS.rectangle],
        [100, 200, -50, -30],
        [],
      ]);
      return p?.rect != null && p.rect.x === 50 && p.rect.y === 170 && p.rect.w === 50 && p.rect.h === 30;
    })()
  );
  check(
    "parseConstructPath: mixed ops kill the rect fast path",
    (() => {
      const p = parseConstructPath(ops, [
        [OPS.rectangle, OPS.moveTo],
        [100, 200, 50, 30, 400, 500],
        [],
      ]);
      return p !== null && p.rect === null && p.cmds.length === 6;
    })()
  );
  check(
    "parseConstructPath: garbage args → null",
    parseConstructPath(ops, ["nope", 5]) === null &&
      parseConstructPath(ops, [null, null]) === null &&
      parseConstructPath(ops, [[], []]) === null
  );
  check(
    "parseConstructPath: unknown op code → null (whole path dropped)",
    parseConstructPath(ops, [[9999], [1, 2]]) === null
  );
  check(
    "parseConstructPath: curveTo2 doubles the current point as first control",
    (() => {
      const p = parseConstructPath(ops, [
        [OPS.moveTo, OPS.curveTo2],
        [10, 20, 30, 40, 50, 60],
        [],
      ]);
      return (
        p !== null &&
        p.cmds[1]?.cmd === "C" &&
        JSON.stringify(p.cmds[1]?.pts) === JSON.stringify([10, 20, 30, 40, 50, 60])
      );
    })()
  );
  check(
    "parseConstructPath: curveTo3 doubles the endpoint as second control",
    (() => {
      const p = parseConstructPath(ops, [
        [OPS.curveTo3],
        [10, 20, 30, 40],
        [],
      ]);
      return (
        p !== null &&
        p.cmds[0]?.cmd === "C" &&
        JSON.stringify(p.cmds[0]?.pts) === JSON.stringify([10, 20, 30, 40, 30, 40])
      );
    })()
  );
}

/* ================================================================== */
console.log("── 2. synthetic extraction (real OPS table) ─────────────");
/* ================================================================== */

/** Growable operator list (the getOperatorList result shape). */
class OpList implements SvgOperatorList {
  fnArray: number[] = [];
  argsArray: unknown[][] = [];
  add(fn: number, args: unknown[] = []): this {
    this.fnArray.push(fn);
    this.argsArray.push(args);
    return this;
  }
  get list(): SvgOperatorList {
    return { fnArray: this.fnArray, argsArray: this.argsArray };
  }
}

const OPS_TABLE: SvgOpsTable = opsTable(OPS as unknown as Record<string, unknown>);

/** Glyph factory (the pdf.js showText entry shape). */
const g = (unicode: string, width = 500): GlyphObject => ({
  unicode,
  width,
  isSpace: unicode === " ",
  isInFont: true,
});

const SYN_FONTS = new Map<string, SvgFontInfo>([
  ["f-plain", { family: "Helvetica", generic: "sans-serif", bold: false, italic: false, fontMatrix0: 0.001 }],
  ["f-bold", { family: "Helvetica-Bold", generic: "sans-serif", bold: true, italic: false, fontMatrix0: 0.001 }],
  ["f-ital", { family: "Helvetica-Oblique", generic: "sans-serif", bold: false, italic: true, fontMatrix0: 0.001 }],
  ["f-noto", { family: "NotoSansDevanagari", generic: "sans-serif", bold: false, italic: false, fontMatrix0: 0.001 }],
]);

const SYN_IMAGES = new Map<string, SvgImagePayload>();
SYN_IMAGES.set("img_rgba", {
  width: 2,
  height: 2,
  kind: 3, // RGBA_32BPP
  data: new Uint8ClampedArray([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 0, 255,
  ]),
});

/** The worker's exact context contract (pool resolution replicated). */
function synCtx(
  overrides: Partial<Pick<SvgPageContext, "width" | "height" | "baseTransform" | "includeImages">> = {}
): SvgPageContext {
  return {
    width: 612,
    height: 792,
    baseTransform: [1, 0, 0, -1, 0, 792],
    includeImages: true,
    resolveFont: (ref: unknown): Promise<SvgFontInfo | null> =>
      Promise.resolve(
        typeof ref === "string" ? (SYN_FONTS.get(ref) ?? null) : null
      ),
    resolveImage: (objId: unknown): Promise<SvgImagePayload | null> =>
      Promise.resolve(
        typeof objId === "string" ? (SYN_IMAGES.get(objId) ?? null) : null
      ),
    ...overrides,
  };
}

async function run(
  ops: SvgOpsTable,
  list: OpList,
  ctx: SvgPageContext = synCtx()
): Promise<{ svg: string; body: string; stats: ReturnType<typeof buildPageSvg> extends Promise<infer R> ? R : never }> {
  const result = await buildPageSvg(ops, list.list, ctx);
  const body = result.svg.split("\n").slice(3, -1).join("\n");
  return { svg: result.svg, body, stats: result.stats };
}

/* ---------------- (a) plain text placement ---------------- */
{
  const list = new OpList()
    .add(OPS.beginText)
    .add(OPS.setFillRGBColor, [new Uint8ClampedArray([51, 102, 153])])
    .add(OPS.setFont, ["f-plain", 11])
    .add(OPS.setTextMatrix, [1, 0, 0, 1, 72, 720])
    .add(OPS.showText, [[g("H", 722), null, g("e", 556), g("l", 222)]]);
  const { body, stats } = await run(OPS_TABLE, list);
  check(
    "plain run: exact x/y/font-size/fill (pt == SVG unit)",
    body ===
      `<text x="72" y="72" font-family="Helvetica, sans-serif" font-size="11" fill="#336699" xml:space="preserve">Hel</text>`,
    body
  );
  check("plain run counted once", stats.texts === 1 && stats.rects === 0, stats);
}

/* ---------------- (b) bold + italic attributes ---------------- */
{
  const list = new OpList()
    .add(OPS.beginText)
    .add(OPS.setFont, ["f-bold", 22])
    .add(OPS.setTextMatrix, [1, 0, 0, 1, 72, 720])
    .add(OPS.showText, [[g("T", 611)]])
    .add(OPS.endText)
    .add(OPS.beginText)
    .add(OPS.setFont, ["f-ital", 10])
    .add(OPS.setTextMatrix, [1, 0, 0, 1, 100, 700])
    .add(OPS.showText, [[g("I", 278)]]);
  const { body } = await run(OPS_TABLE, list);
  check(
    "font-weight bold carried",
    body.includes('font-weight="bold"') && body.includes('font-size="22"'),
    body
  );
  check("font-style italic carried", body.includes('font-style="italic"'), body);
}

/* ---------------- (c) TJ piece splits with exact pen math ---------------- */
{
  // width 500 @ size 10 → advance 5; TJ -100 → +1 → second piece at +6.
  const list = new OpList()
    .add(OPS.beginText)
    .add(OPS.setFont, ["f-plain", 10])
    .add(OPS.setTextMatrix, [1, 0, 0, 1, 72, 720])
    .add(OPS.showText, [[g("A", 500), -100, g("B", 500)]]);
  const { body } = await run(OPS_TABLE, list);
  check(
    "TJ adjustment moves the pen by -n/1000 × size (× hScale=1)",
    body.includes('<tspan x="72" y="72">A</tspan><tspan x="78" y="72">B</tspan>'),
    body
  );
}
{
  // hScale 50%: residual carries a transform — pieces are emitted in the
  // transform's LOCAL frame (the double-translation guard).
  const list = new OpList()
    .add(OPS.beginText)
    .add(OPS.setFont, ["f-plain", 10])
    .add(OPS.setHScale, [50])
    .add(OPS.setTextMatrix, [1, 0, 0, 1, 72, 720])
    .add(OPS.showText, [[g("A", 500), -100, g("B", 500)]]);
  const { body } = await run(OPS_TABLE, list);
  check(
    "hScale 50%: squeeze rides a transform",
    body.includes('transform="matrix(0.5 0 0 1 72 72)"'),
    body
  );
  check(
    "hScale 50%: TJ move scaled by hScale (pen 3 → local 6)",
    body.includes('<tspan x="0" y="0">A</tspan><tspan x="6" y="0">B</tspan>'),
    body
  );
}

/* ---------------- (d) XML-hostile glyphs ---------------- */
{
  const list = new OpList()
    .add(OPS.beginText)
    .add(OPS.setFont, ["f-plain", 11])
    .add(OPS.setTextMatrix, [1, 0, 0, 1, 72, 700])
    .add(OPS.showText, [[g("&"), g(" "), g("<"), g(" "), g(">"), g(" "), g('"')]]);
  const { body } = await run(OPS_TABLE, list);
  check(
    "hostile glyphs fully escaped",
    body.includes("&amp; &lt; &gt; &quot;") && !body.includes("< &"),
    body
  );
}

/* ---------------- (e) Devanagari visual order repaired ---------------- */
{
  const list = new OpList()
    .add(OPS.beginText)
    .add(OPS.setFont, ["f-noto", 22])
    .add(OPS.setTextMatrix, [1, 0, 0, 1, 72, 720])
    .add(OPS.showText, [
      [g("त"), g("्", 0), g("र", 580), g("ै", 0), g("म", 531), g("ा", 0), g("ि", 0), g("स", 500), g("क", 500)],
    ]);
  const { body } = await run(OPS_TABLE, list);
  check(
    "synthetic shaped Devanagari repaired to logical order",
    body.includes("त्रैमासिक") && !body.includes("मािसक"),
    body
  );
}
{
  const list = new OpList()
    .add(OPS.beginText)
    .add(OPS.setFont, ["f-noto", 22])
    .add(OPS.setTextMatrix, [1, 0, 0, 1, 72, 720])
    .add(OPS.showText, [[g("ि", 0), g("र", 580), g("प", 500), g("ो", 0), g("ट", 500), g("र", 580), g("्", 0)]]);
  const { body } = await run(OPS_TABLE, list);
  check(
    "synthetic reph moved back before its syllable",
    body.includes("रिपोर्ट") && !body.includes("िरपोटर्"),
    body
  );
}

/* ---------------- (f) invisible text + unknown font + size 0 ---------------- */
{
  const list = new OpList()
    .add(OPS.beginText)
    .add(OPS.setFont, ["f-plain", 11])
    .add(OPS.setTextRenderingMode, [3])
    .add(OPS.setTextMatrix, [1, 0, 0, 1, 72, 720])
    .add(OPS.showText, [[g("h", 500)]])
    .add(OPS.setTextRenderingMode, [0])
    .add(OPS.setFont, ["f-unknown", 11])
    .add(OPS.showText, [[g("i", 500)]])
    .add(OPS.setFont, ["f-plain", 0])
    .add(OPS.showText, [[g("j", 500)]]);
  const { svg, stats } = await run(OPS_TABLE, list);
  check(
    "render mode 3 + unknown font + size 0 → honest skips",
    stats.texts === 0 && !svg.includes(">h<") && !svg.includes(">i<") && !svg.includes(">j<"),
    stats
  );
}

/* ---------------- (g) rectangle fast path ---------------- */
{
  const list = new OpList()
    .add(OPS.save)
    .add(OPS.setFillRGBColor, [new Uint8ClampedArray([255, 0, 0])])
    .add(OPS.constructPath, [[OPS.rectangle], [100, 200, 50, 30], [100, 200, 150, 230]])
    .add(OPS.fill)
    .add(OPS.restore)
    .add(OPS.constructPath, [[OPS.rectangle], [100, 200, -50, -30], []])
    .add(OPS.fill);
  const { body, stats } = await run(OPS_TABLE, list);
  check(
    "re operator → exact baked <rect> (y-down viewBox)",
    body.includes('<rect x="100" y="562" width="50" height="30" fill="#ff0000"/>'),
    body
  );
  check(
    "negative extents normalized to the same device box",
    body.includes('<rect x="50" y="592" width="50" height="30"'),
    body
  );
  check("two rects counted", stats.rects === 2, stats);
}

/* ---------------- (h) M/L path + stroke + dash ---------------- */
{
  const list = new OpList()
    .add(OPS.save)
    .add(OPS.setStrokeRGBColor, [new Uint8ClampedArray([0, 0, 0])])
    .add(OPS.setLineWidth, [2])
    .add(OPS.setDash, [[3, 2], 0])
    .add(OPS.constructPath, [[OPS.moveTo, OPS.lineTo], [72, 80, 300, 80], [72, 80, 300, 80]])
    .add(OPS.stroke)
    .add(OPS.restore);
  const { body } = await run(OPS_TABLE, list);
  check(
    "M/L path baked with stroke + dash",
    body ===
      `<path d="M72 712L300 712" fill="none" stroke="#000000" stroke-width="2" stroke-dasharray="3 2"/>`,
    body
  );
}

/* ---------------- (i) even-odd fill ---------------- */
{
  const list = new OpList()
    .add(OPS.constructPath, [
      [OPS.moveTo, OPS.lineTo, OPS.lineTo, OPS.closePath],
      [10, 10, 60, 10, 60, 60],
      [],
    ])
    .add(OPS.eoFill);
  const { body } = await run(OPS_TABLE, list);
  check("eoFill carries fill-rule=evenodd", body.includes('fill-rule="evenodd"'), body);
}

/* ---------------- (j) endPath vs clip-then-paint ---------------- */
{
  const endOnly = new OpList()
    .add(OPS.constructPath, [[OPS.rectangle], [0, 0, 50, 50], []])
    .add(OPS.endPath);
  const { body } = await run(OPS_TABLE, endOnly);
  check("endPath paints nothing", body.trim() === "", body);

  const clipped = new OpList()
    .add(OPS.constructPath, [[OPS.rectangle], [0, 0, 50, 50], []])
    .add(OPS.clip)
    .add(OPS.fill);
  const { body: clipBody, stats } = await run(OPS_TABLE, clipped);
  check(
    "clip keeps the path for a following paint (approximated honestly)",
    stats.rects === 1 && clipBody.includes('<rect x="0" y="742" width="50" height="50"'),
    { stats, clipBody }
  );

  const clipEnd = new OpList()
    .add(OPS.constructPath, [[OPS.rectangle], [0, 0, 50, 50], []])
    .add(OPS.clip)
    .add(OPS.endPath);
  const { body: clipEndBody } = await run(OPS_TABLE, clipEnd);
  check("clip + endPath paints nothing", clipEndBody.trim() === "", clipEndBody);
}

/* ---------------- (k) non-axis-aligned CTM → carried transform ---------------- */
{
  const list = new OpList()
    .add(OPS.save)
    .add(OPS.transform, [0, 1, -1, 0, 50, 50])
    .add(OPS.setStrokeRGBColor, [new Uint8ClampedArray([255, 0, 0])])
    .add(OPS.setLineWidth, [2])
    .add(OPS.setDash, [[4, 2], 0])
    .add(OPS.constructPath, [
      [OPS.moveTo, OPS.lineTo, OPS.lineTo, OPS.closePath],
      [100, 200, 150, 200, 150, 230],
      [],
    ])
    .add(OPS.stroke)
    .add(OPS.restore);
  const { body } = await run(OPS_TABLE, list);
  check(
    "rotated CTM: transform carries the matrix, d stays in PDF space",
    body.includes('transform="matrix(0 -1 -1 0 50 742)"') &&
      body.includes('d="M100 200L150 200L150 230L100 230Z"'),
    body
  );
  check(
    "rotated CTM: stroke-width/dash stay RAW (the matrix scales them)",
    body.includes('stroke-width="2"') && body.includes('stroke-dasharray="4 2"'),
    body
  );
}

/* ---------------- (l) save/restore CTM scoping ---------------- */
{
  const list = new OpList()
    .add(OPS.save)
    .add(OPS.transform, [2, 0, 0, 2, 0, 0])
    .add(OPS.setStrokeRGBColor, [new Uint8ClampedArray([0, 0, 0])])
    .add(OPS.setLineWidth, [2])
    .add(OPS.constructPath, [[OPS.moveTo, OPS.lineTo], [100, 200, 150, 200], []])
    .add(OPS.stroke)
    .add(OPS.restore)
    .add(OPS.constructPath, [[OPS.moveTo, OPS.lineTo], [100, 200, 150, 200], []])
    .add(OPS.stroke);
  const { body } = await run(OPS_TABLE, list);
  check(
    "scaled CTM bakes doubled coordinates",
    body.includes('d="M200 392L300 392"'),
    body
  );
  check(
    "stroke width scaled by the device matrix (2×2 pen → 4)",
    body.includes('stroke-width="4"'),
    body
  );
  check(
    "restore returns the CTM (unscaled again)",
    countOf(body, 'd="M100 592L150 592"') === 1,
    body
  );
}

/* ---------------- (m) /Rotate 90 base transform ---------------- */
{
  // A rotated page's baseTransform is [0,1,1,0,0,0] — the stroke pen
  // must NOT collapse to width 0 (the singular-value average fix).
  const list = new OpList()
    .add(OPS.setStrokeRGBColor, [new Uint8ClampedArray([0, 0, 0])])
    .add(OPS.setLineWidth, [2])
    .add(OPS.constructPath, [[OPS.moveTo, OPS.lineTo], [72, 80, 300, 80], []])
    .add(OPS.stroke);
  const ctx = synCtx({
    width: 792,
    height: 612,
    baseTransform: [0, 1, 1, 0, 0, 0],
  });
  const { body } = await run(OPS_TABLE, list, ctx);
  check(
    "/Rotate 90 page: stroke width survives (σ-average, not |a|+|d|)",
    body.includes('stroke-width="2"') && body.includes("d="),
    body
  );
}

/* ---------------- (n) form XObject CTM ---------------- */
{
  const list = new OpList()
    .add(OPS.paintFormXObjectBegin, [[1, 0, 0, 1, 10, 20], [0, 0, 100, 100]])
    .add(OPS.constructPath, [[OPS.rectangle], [100, 200, 50, 30], []])
    .add(OPS.fill)
    .add(OPS.paintFormXObjectEnd)
    .add(OPS.constructPath, [[OPS.rectangle], [100, 200, 50, 30], []])
    .add(OPS.fill);
  const { body, stats } = await run(OPS_TABLE, list);
  check(
    "form XObject matrix composes with the page CTM",
    body.includes('<rect x="110" y="542" width="50" height="30"'),
    body
  );
  check(
    "form XObject end restores the outer CTM",
    body.includes('<rect x="100" y="562" width="50" height="30"') && stats.rects === 2,
    { body, stats }
  );
}

/* ---------------- (o) setGState LW / D / Font ---------------- */
{
  const list = new OpList()
    .add(OPS.setGState, [
      [
        ["LW", 3],
        ["D", [[4, 2], 0]],
        ["Font", ["f-bold", 14]],
      ],
    ])
    .add(OPS.setStrokeRGBColor, [new Uint8ClampedArray([0, 0, 0])])
    .add(OPS.constructPath, [[OPS.moveTo, OPS.lineTo], [72, 80, 300, 80], []])
    .add(OPS.stroke)
    .add(OPS.beginText)
    .add(OPS.setTextMatrix, [1, 0, 0, 1, 72, 720])
    .add(OPS.showText, [[g("G", 722)]])
    .add(OPS.endText);
  const { body } = await run(OPS_TABLE, list);
  check(
    "setGState LW/D applied to strokes",
    body.includes('stroke-width="3"') && body.includes('stroke-dasharray="4 2"'),
    body
  );
  check(
    "setGState Font applied to text (size + bold)",
    body.includes('font-size="14"') && body.includes('font-weight="bold"'),
    body
  );
}

/* ---------------- (p) word/char spacing pen ---------------- */
{
  // charSpacing 10 on every glyph; wordSpacing 50 on the space; then TJ.
  const list = new OpList()
    .add(OPS.beginText)
    .add(OPS.setFont, ["f-plain", 10])
    .add(OPS.setCharSpacing, [10])
    .add(OPS.setWordSpacing, [50])
    .add(OPS.setTextMatrix, [1, 0, 0, 1, 72, 720])
    .add(OPS.showText, [[g("A", 500), g(" ", 0), -100, g("B", 500)]]);
  const { body } = await run(OPS_TABLE, list);
  // A: 5 + 10 = 15; space: 0 + 50 + 10 = 60 → pen 75; TJ → +1 → 76.
  check(
    "word/char spacing move the pen (piece 2 at +76)",
    body.includes('<tspan x="148" y="72">B</tspan>'),
    body
  );
}

/* ---------------- (q) nextLine / moveText positioning ---------------- */
{
  const list = new OpList()
    .add(OPS.beginText)
    .add(OPS.setFont, ["f-plain", 11])
    .add(OPS.setLeading, [12])
    .add(OPS.setTextMatrix, [1, 0, 0, 1, 72, 720])
    .add(OPS.showText, [[g("F", 556)]])
    .add(OPS.nextLineShowText, [[g("S", 500)]])
    .add(OPS.moveText, [10, -20])
    .add(OPS.showText, [[g("T", 500)]]);
  const { body } = await run(OPS_TABLE, list);
  check(
    "nextLineShowText drops one leading below",
    body.includes('<text x="72" y="84"') && body.includes(">S</text>"),
    body
  );
  check(
    "moveText offsets the pen from the line origin",
    body.includes('<text x="82" y="92"') && body.includes(">T</text>"),
    body
  );
}

/* ---------------- (r) images: named / repeat / inline / switches ------- */
{
  const list = new OpList()
    .add(OPS.save)
    .add(OPS.transform, [120, 0, 0, 60, 72, 200])
    .add(OPS.paintImageXObject, ["img_rgba", 2, 2])
    .add(OPS.restore)
    .add(OPS.paintInlineImageXObject, [
      {
        width: 2,
        height: 2,
        kind: 3,
        data: new Uint8ClampedArray([
          255, 0, 0, 255, 0, 255, 0, 255,
          0, 0, 255, 255, 255, 255, 0, 255,
        ]),
      },
    ]);
  const { body, stats } = await run(OPS_TABLE, list);
  check(
    "named image: unit square + exact device matrix",
    body.includes(
      '<image x="0" y="0" width="1" height="1" preserveAspectRatio="none" transform="matrix(120 0 0 60 72 532)"'
    ) &&
      body.includes('xlink:href="data:image/png;base64,'),
    body.slice(0, 400)
  );
  check(
    "inline image: same geometry via the args payload",
    countOf(body, 'transform="matrix(120 0 0 60 72 532)"') === 2,
    body
  );
  check("two images counted", stats.images === 2, stats);

  const off = await run(
    OPS_TABLE,
    new OpList()
      .add(OPS.transform, [120, 0, 0, 60, 72, 200])
      .add(OPS.paintImageXObject, ["img_rgba", 2, 2]),
    synCtx({ includeImages: false })
  );
  check("includeImages=false skips every image", off.body.trim() === "" && off.stats.images === 0, off.body);

  const missing = await run(
    OPS_TABLE,
    new OpList()
      .add(OPS.transform, [120, 0, 0, 60, 72, 200])
      .add(OPS.paintImageXObject, ["img_missing", 2, 2])
  );
  check("unknown image id → honest skip", missing.body.trim() === "", missing.body);
}
{
  const list = new OpList().add(OPS.paintImageXObjectRepeat, [
    "img_rgba",
    2,
    2,
    [10, 20, 30, 40],
  ]);
  const { body, stats } = await run(OPS_TABLE, list);
  check(
    "repeat image: one <image> per position with the flip matrix",
    body.includes('transform="matrix(2 0 0 2 10 770)"') &&
      body.includes('transform="matrix(2 0 0 2 30 750)"') &&
      stats.images === 2,
    { body: body.slice(0, 300), stats }
  );
}

/* ---------------- (s) truncation guard ---------------- */
{
  const list = new OpList();
  for (let i = 0; i < MAX_ELEMENTS + 5; i += 1) {
    list
      .add(OPS.beginText)
      .add(OPS.setFont, ["f-plain", 6])
      .add(OPS.setTextMatrix, [1, 0, 0, 1, 72, 720])
      .add(OPS.showText, [[g("x", 500)]]);
  }
  const { stats } = await run(OPS_TABLE, list);
  check(
    "element cap: stops at MAX_ELEMENTS and flags truncation",
    stats.texts === MAX_ELEMENTS && stats.truncated === true,
    stats
  );
}

/* ---------------- (t) SVG document structure ---------------- */
{
  const list = new OpList()
    .add(OPS.beginText)
    .add(OPS.setFont, ["f-plain", 11])
    .add(OPS.setTextMatrix, [1, 0, 0, 1, 72, 720])
    .add(OPS.showText, [[g("ok", 500)]]);
  const { svg } = await run(OPS_TABLE, list);
  check("xml declaration first", svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  check(
    "svg root carries both namespaces + pt dimensions + viewBox",
    svg.includes('xmlns="http://www.w3.org/2000/svg"') &&
      svg.includes('xmlns:xlink="http://www.w3.org/1999/xlink"') &&
      svg.includes('width="612pt" height="792pt"') &&
      svg.includes('viewBox="0 0 612 792"') &&
      svg.includes('version="1.1"'),
    svg.split("\n")[1]
  );
  check(
    "white page background rect",
    svg.includes('<rect x="0" y="0" width="612" height="792" fill="#ffffff"/>')
  );
  check("well-formed XML", xmlWellFormed(svg));
  check(
    "no NaN/undefined/Infinity anywhere",
    !svg.includes("NaN") && !svg.includes("undefined") && !svg.includes("Infinity")
  );
  check("document ends with </svg>", svg.endsWith("</svg>\n"));
}

/* ================================================================== */
console.log("── 3. real fixture: pdf-lib build → pdf.js operator list ──");
/* ================================================================== */

const notoBytes = new Uint8Array(
  readFileSync(
    new URL("../public/fonts/NotoSansDevanagari-Regular.ttf", import.meta.url)
  )
);

/** The 2×2 pixel source for the embedded PNG (red/green/blue/yellow). */
const PIX = [
  [255, 0, 0, 255],
  [0, 255, 0, 255],
  [0, 0, 255, 255],
  [255, 255, 0, 255],
];

/**
 * The 4-page fixture (612×792 Letter): EN text hierarchy + styled runs +
 * XML-hostile text + pdf-lib rectangle/line + a genuine `re` operator;
 * Devanagari page (Noto subset); embedded-image page; /Rotate 90 page.
 */
async function buildFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const noto = await doc.embedFont(notoBytes, { subset: true });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ital = await doc.embedFont(StandardFonts.HelveticaOblique);

  const p1 = doc.addPage([612, 792]);
  p1.drawText("Vector Export Fixture", { x: 72, y: 720, size: 22, font: bold });
  p1.drawText("Body text in a calm blue.", {
    x: 72,
    y: 690,
    size: 11,
    font: helv,
    color: rgb(0.2, 0.4, 0.6),
  });
  p1.drawText("Plain start, then", { x: 72, y: 660, size: 11, font: helv });
  p1.drawText("bold middle,", { x: 160, y: 660, size: 11, font: bold });
  p1.drawText("italic tail.", { x: 250, y: 660, size: 11, font: ital });
  p1.drawText('Escaped: a & b, 5 < 6, 7 > 3, "quoted".', {
    x: 72,
    y: 620,
    size: 11,
    font: helv,
  });
  p1.drawRectangle({ x: 72, y: 500, width: 200, height: 80, color: rgb(0.9, 0.9, 0.95) });
  p1.drawLine({ start: { x: 72, y: 460 }, end: { x: 300, y: 460 }, thickness: 2 });
  p1.pushOperators(
    pushGraphicsState(),
    rectangle(400, 460, 120, 50),
    fill(),
    popGraphicsState()
  );
  p1.drawText("Bottom label after shapes.", { x: 72, y: 100, size: 10, font: helv });

  const p2 = doc.addPage([612, 792]);
  p2.drawText("त्रैमासिक रिपोर्ट", { x: 72, y: 720, size: 22, font: noto });
  p2.drawText("प्रिया शर्मा की टीम", { x: 72, y: 680, size: 14, font: noto });
  p2.drawText("यह रिपोर्ट आपके डिवाइस पर बनती है।", {
    x: 72,
    y: 640,
    size: 11,
    font: noto,
  });

  const { pngEncode } = await import("../tools/imgconv/png-encode");
  const png = new Uint8Array(
    await (
      await pngEncode({ width: 2, height: 2, data: new Uint8ClampedArray(PIX.flat()) })
    ).arrayBuffer()
  );
  const img = await doc.embedPng(png);
  const p3 = doc.addPage([612, 792]);
  p3.drawText("Photo page", { x: 72, y: 700, size: 12, font: helv });
  p3.drawImage(img, { x: 72, y: 200, width: 120, height: 60 });

  const p4 = doc.addPage([612, 792]);
  p4.setRotation(degrees(90));
  p4.drawText("Rotated page text", { x: 72, y: 700, size: 12, font: helv });

  return new Uint8Array(await doc.save());
}

/* The worker's exact pool plumbing (worker.ts poolFor/resolveObj). */
interface ObjsPool {
  get(objId: string, callback: (data: unknown) => void): null;
}
function resolveObj(pool: ObjsPool, objId: string): Promise<unknown> {
  return new Promise((resolve) => {
    pool.get(objId, (data: unknown) => resolve(data));
  });
}
function poolFor(
  page: { objs: ObjsPool; commonObjs: ObjsPool },
  objId: string
): ObjsPool {
  return objId.startsWith("g_") ? page.commonObjs : page.objs;
}

interface RealPage {
  svg: string;
  body: string;
  stats: Awaited<ReturnType<typeof buildPageSvg>>["stats"];
  rawShowText: string[];
  viewport: { width: number; height: number; transform: number[] };
}

/** Runs the ACTUAL worker pipeline for one page of a real document. */
async function convertPage(
  pdf: { getPage: (n: number) => Promise<unknown> },
  number: number,
  includeImages = true
): Promise<RealPage> {
  const page = (await pdf.getPage(number)) as unknown as {
    getViewport: (params: { scale: number }) => { width: number; height: number; transform: number[] };
    getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
    objs: ObjsPool;
    commonObjs: ObjsPool;
    cleanup: () => void;
  };
  const viewport = page.getViewport({ scale: 1 });
  const opList = await page.getOperatorList();

  // Raw showText unicode strings (proves the visual-order input).
  const rawShowText: string[] = [];
  for (let i = 0; i < opList.fnArray.length; i += 1) {
    if (opList.fnArray[i] === OPS.showText) {
      const glyphs = opList.argsArray[i][0] as { unicode?: unknown }[];
      rawShowText.push(
        glyphs.map((gl) => (typeof gl.unicode === "string" ? gl.unicode : "")).join("")
      );
    }
  }

  const ctx: SvgPageContext = {
    width: viewport.width,
    height: viewport.height,
    baseTransform: viewport.transform as [number, number, number, number, number, number],
    includeImages,
    resolveFont: (ref: unknown): Promise<SvgFontInfo | null> => {
      if (typeof ref !== "string" || ref === "") return Promise.resolve(null);
      return resolveObj(poolFor(page, ref), ref).then(toFontInfo);
    },
    resolveImage: (objId: unknown): Promise<SvgImagePayload | null> => {
      if (typeof objId !== "string" || objId === "") return Promise.resolve(null);
      return resolveObj(poolFor(page, objId), objId).then(
        (raw): SvgImagePayload | null => {
          if (raw === null || typeof raw !== "object") return null;
          const obj = raw as {
            width?: unknown;
            height?: unknown;
            kind?: unknown;
            data?: unknown;
          };
          if (typeof obj.width !== "number" || typeof obj.height !== "number") {
            return null;
          }
          // Bun has no ImageBitmap — the raw-data branch (the one the
          // browser worker falls back to for non-bitmap payloads).
          const data = obj.data;
          if (!(data instanceof Uint8Array) && !(data instanceof Uint8ClampedArray)) {
            return null;
          }
          return {
            width: obj.width,
            height: obj.height,
            kind: typeof obj.kind === "number" ? obj.kind : 0,
            data,
          };
        }
      );
    },
  };

  const result = await buildPageSvg(OPS_TABLE, opList, ctx);
  page.cleanup();
  return {
    svg: result.svg,
    body: result.svg.split("\n").slice(3, -1).join("\n"),
    stats: result.stats,
    rawShowText,
    viewport,
  };
}

const fixture = await buildFixture();
check("fixture built (starts with %PDF)", fixture[0] === 0x25 && fixture.length > 500);

const task = getDocument({ data: fixture.slice(), useSystemFonts: true });
const pdf = await task.promise;
check("pdf.js read all 4 pages", pdf.numPages === 4, pdf.numPages);

/* ---------------- page 1: EN text + shapes ---------------- */
const pg1 = await convertPage(pdf, 1);
check(
  "p1 viewBox is the exact Letter point size",
  pg1.svg.includes('viewBox="0 0 612 792"') &&
    pg1.svg.includes('width="612pt" height="792pt"'),
  pg1.svg.split("\n")[1]
);
check(
  "p1 title: exact position, size, bold, family",
  pg1.body.includes(
    '<text x="72" y="72" font-family="Helvetica-Bold, sans-serif" font-size="22" font-weight="bold" fill="#000000" xml:space="preserve">Vector Export Fixture</text>'
  ),
  pg1.body.split("\n")[0]
);
check(
  "p1 coloured body keeps its rgb fill",
  pg1.body.includes('fill="#336699"') && pg1.body.includes("Body text in a calm blue."),
  pg1.body
);
check(
  "p1 bold/italic runs at their exact x positions",
  pg1.body.includes('<text x="160" y="132" font-family="Helvetica-Bold, sans-serif" font-size="11" font-weight="bold"') &&
    pg1.body.includes('<text x="250" y="132" font-family="Helvetica-Oblique, sans-serif" font-size="11" font-style="italic"'),
  pg1.body
);
check(
  "p1 XML-hostile text fully escaped",
  pg1.body.includes("a &amp; b, 5 &lt; 6, 7 &gt; 3, &quot;quoted&quot;.") &&
    !pg1.body.includes("5 < 6"),
  pg1.body
);
check(
  "p1 pdf-lib rectangle → baked path (pdf-lib never emits `re`)",
  pg1.body.includes('<path d="M72 292L72 212L272 212L272 292Z" fill="#e6e6f2"/>'),
  pg1.body
);
check(
  "p1 drawLine → stroked path with thickness 2",
  pg1.body.includes('<path d="M72 332M72 332L300 332" fill="none" stroke="#000000" stroke-width="2"/>'),
  pg1.body
);
check(
  "p1 genuine `re` operator → the <rect> fast path",
  pg1.body.includes('<rect x="400" y="282" width="120" height="50" fill="#000000"/>'),
  pg1.body
);
check(
  "p1 stats honest: 7 texts, 1 rect, 2 paths",
  pg1.stats.texts === 7 && pg1.stats.rects === 1 && pg1.stats.paths === 2 && pg1.stats.images === 0,
  pg1.stats
);
check("p1 well-formed XML", xmlWellFormed(pg1.svg));
check("p1 no NaN/undefined", !pg1.svg.includes("NaN") && !pg1.svg.includes("undefined"));
check(
  "p1 bottom label survives after the shapes",
  pg1.body.includes("Bottom label after shapes."),
  pg1.body
);

/* ---------------- page 2: Devanagari repair ---------------- */
const pg2 = await convertPage(pdf, 2);
check(
  "p2 raw extraction is VISUAL order (the repair has real work to do)",
  pg2.rawShowText.some((s) => s.includes("मािसक")) &&
    pg2.rawShowText.some((s) => s.includes("िरपोटर्")) &&
    pg2.rawShowText.some((s) => s.includes("िप्रया")),
  pg2.rawShowText
);
check(
  "p2 SVG carries the repaired logical Hindi",
  pg2.body.includes("त्रैमासिक रिपोर्ट") &&
    pg2.body.includes("प्रिया शर्मा की टीम") &&
    pg2.body.includes("यह रिपोर्ट आपके डिवाइस पर बनती है।"),
  pg2.body
);
check(
  "p2 visual-order artifacts absent from the output",
  !pg2.body.includes("मािसक") &&
    !pg2.body.includes("िरपोटर्") &&
    !pg2.body.includes("िप्रया") &&
    !pg2.body.includes("शमार्") &&
    !pg2.body.includes("िडवाइस"),
  pg2.body
);
check(
  "p2 Noto family substituted (pdf.js appends a subset suffix)",
  pg2.body.includes('font-family="NotoSansDevanagari-Regular') &&
    pg2.body.includes(", sans-serif"),
  pg2.body.split("\n")[0]
);
check(
  "p2 sizes + positions exact (22/14/11 at 72/112/152)",
  pg2.body.includes('font-size="22"') &&
    pg2.body.includes('<text x="72" y="112"') &&
    pg2.body.includes('<text x="72" y="152"'),
  pg2.body
);
check("p2 stats honest: 3 texts", pg2.stats.texts === 3, pg2.stats);

/* ---------------- page 3: embedded image ---------------- */
const pg3 = await convertPage(pdf, 3);
const imageTag = pg3.body.match(/<image[^>]*>/)?.[0] ?? "";
check(
  "p3 image element with the exact device matrix",
  imageTag.includes('<image x="0" y="0" width="1" height="1" preserveAspectRatio="none"') &&
    imageTag.includes('transform="matrix(120 0 0 60 72 532)"'),
  imageTag.slice(0, 220)
);
check(
  "p3 image carries both href forms as a PNG data URI",
  imageTag.includes('xlink:href="data:image/png;base64,') &&
    imageTag.includes(' href="data:image/png;base64,') &&
    imageTag.endsWith('"/>'),
  imageTag.slice(-140)
);
check("p3 label present", pg3.body.includes("Photo page"), pg3.body);
check("p3 stats honest: 1 text + 1 image", pg3.stats.texts === 1 && pg3.stats.images === 1, pg3.stats);

/* The INDEPENDENT oracle: base64 → PNG chunks → node:zlib inflateSync →
 * Sub-filter undo → pixel-exact comparison against the source. */
{
  const b64 = imageTag.match(/xlink:href="data:image\/png;base64,([^"]+)"/)?.[1];
  check("p3 data URI base64 extracted", typeof b64 === "string" && b64.length > 40, b64?.length ?? 0);
  if (typeof b64 === "string") {
    const png = Buffer.from(b64, "base64");
    check(
      "oracle: PNG signature + IHDR 2×2 RGBA",
      png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47 &&
        png.readUInt32BE(16) === 2 && png.readUInt32BE(20) === 2 &&
        png[24] === 8 && png[25] === 6,
      { sig: Array.from(png.slice(0, 8)), w: png.readUInt32BE(16), h: png.readUInt32BE(20) }
    );
    // Walk chunks; concatenate every IDAT.
    let off = 8;
    const idat: Buffer[] = [];
    let ihdrOk = false;
    while (off + 8 <= png.length) {
      const len = png.readUInt32BE(off);
      const type = png.toString("latin1", off + 4, off + 8);
      if (type === "IHDR") ihdrOk = png[off + 8 + 8] === 0 && png[off + 8 + 9] === 0;
      if (type === "IDAT") idat.push(png.subarray(off + 8, off + 8 + len));
      if (type === "IEND") break;
      off += 12 + len;
    }
    check("oracle: IHDR filter/interlace zero", ihdrOk, ihdrOk);
    const raw = inflateSync(Buffer.concat(idat)); // node:zlib — NOT fflate
    const stride = 2 * 4;
    check("oracle: inflated scanline size exact", raw.length === (stride + 1) * 2, raw.length);
    const px = new Uint8Array(stride * 2);
    for (let y = 0; y < 2; y += 1) {
      const filter = raw[y * (stride + 1)];
      const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      for (let x = 0; x < stride; x += 1) {
        const left = x >= 4 ? px[y * stride + x - 4] : 0;
        px[y * stride + x] =
          filter === 1 ? (row[x] + left) & 0xff : filter === 0 ? row[x] : -1;
      }
    }
    check(
      "oracle: pixel-exact RGBA after the Sub-filter undo",
      Array.from(px).join(",") === PIX.flat().join(","),
      Array.from(px)
    );
  }
}

const pg3NoImages = await convertPage(pdf, 3, false);
check(
  "p3 includeImages=false → text-only vector (image absent)",
  !pg3NoImages.body.includes("<image") && pg3NoImages.stats.images === 0 && pg3NoImages.body.includes("Photo page"),
  pg3NoImages.stats
);

/* ---------------- page 4: /Rotate 90 ---------------- */
const pg4 = await convertPage(pdf, 4);
check(
  "p4 rotated viewport: swapped viewBox in points",
  pg4.svg.includes('viewBox="0 0 792 612"') && pg4.svg.includes('width="792pt" height="612pt"'),
  pg4.svg.split("\n")[1]
);
check(
  "p4 rotated text carries a residual transform",
  pg4.body.includes('transform="matrix(0 1 -1 0 700 72)"'),
  pg4.body
);
check(
  "p4 tspan coordinates are in the transform's LOCAL frame (no double translation)",
  pg4.body.includes('<tspan x="0" y="0">Rotated page text</tspan>'),
  pg4.body
);
check("p4 well-formed", xmlWellFormed(pg4.svg));

await pdf.cleanup();
await task.destroy();

/* ================================================================== */
console.log("── 4. page-range subset + naming ─────────────────────────");
/* ================================================================== */

{
  check(
    "parsePageSpec vectors",
    JSON.stringify(parsePageSpec("2", 4)) === "[1]" &&
      JSON.stringify(parsePageSpec("1,3", 4)) === "[0,2]" &&
      parsePageSpec("abc", 4) === null &&
      parsePageSpec("", 4)?.length === 4,
    {
      two: parsePageSpec("2", 4),
      oneThree: parsePageSpec("1,3", 4),
      garbage: parsePageSpec("abc", 4),
      all: parsePageSpec("", 4)?.length,
    }
  );
  const open = parsePageSpec("8-", 4);
  check(
    "open range beyond the last page → empty (worker rejects honestly)",
    open !== null && open.length === 0,
    open
  );

  check(
    "single page output names base.svg",
    svgOutputName("vector-fixture", 2, true) === "vector-fixture.svg"
  );
  check(
    "multi page output names base_pageN.svg",
    svgOutputName("vector-fixture", 1, false) === "vector-fixture_page1.svg" &&
      svgOutputName("vector-fixture", 3, false) === "vector-fixture_page3.svg"
  );

  // Subset "2": only the Hindi page converts; single-page naming applies.
  const task2 = getDocument({ data: fixture.slice(), useSystemFonts: true });
  const pdf2 = await task2.promise;
  const spec = parsePageSpec("2", pdf2.numPages);
  check("spec 2 → [1]", spec !== null && spec.length === 1 && spec[0] === 1, spec);
  const page2Only = await convertPage(pdf2, 2);
  check(
    "subset: Hindi page only (EN page absent)",
    page2Only.body.includes("त्रैमासिक") && !page2Only.body.includes("Vector Export Fixture"),
    page2Only.stats
  );
  const spec13 = parsePageSpec("1,3", pdf2.numPages);
  check(
    "spec 1,3 → pages 1 and 3",
    spec13 !== null && spec13.length === 2 && spec13[0] === 0 && spec13[1] === 2,
    spec13
  );
  const pg3again = await convertPage(pdf2, 3);
  check(
    "subset member 3 keeps its image",
    pg3again.stats.images === 1 && pg3again.body.includes("<image"),
    pg3again.stats
  );
  await pdf2.cleanup();
  await task2.destroy();
}

/* ================================================================== */
console.log("── 5. rejection vectors (encrypted / garbage) ──────────────");
/* ================================================================== */

{
  const enc = await CantooPDF.create();
  enc.addPage([612, 792]);
  await enc.encrypt({
    userPassword: "secret-one",
    ownerPassword: "secret-two",
    algorithm: "AES-256",
    permissions: {
      printing: "highResolution",
      copying: true,
      modifying: true,
      annotating: true,
      fillingForms: true,
      contentAccessibility: true,
      documentAssembly: true,
    },
  });
  const encBytes = new Uint8Array(await enc.save());
  let encMessage = "";
  try {
    const encTask = getDocument({ data: encBytes.slice() });
    await encTask.promise;
    await encTask.destroy();
  } catch (error) {
    encMessage = error instanceof Error ? error.message : String(error);
  }
  check(
    "encrypted fixture: pdf.js demands a password",
    /password/i.test(encMessage),
    encMessage
  );
  check(
    "encrypted → honest tool.errorEncrypted",
    classifySvgError(encMessage) === "tool.errorEncrypted"
  );

  const garbage = new Uint8Array(2048);
  for (let i = 0; i < garbage.length; i += 1) {
    garbage[i] = (i * 31 + 7) & 0xff;
  }
  let garbageMessage = "";
  try {
    const garbageTask = getDocument({ data: garbage.slice() });
    await garbageTask.promise;
    await garbageTask.destroy();
  } catch (error) {
    garbageMessage = error instanceof Error ? error.message : String(error);
  }
  check("garbage bytes rejected by pdf.js", garbageMessage.length > 0, garbageMessage);
  check(
    "garbage → honest tool.errorCorrupt",
    classifySvgError(garbageMessage) === "tool.errorCorrupt"
  );
}

/* ================================================================== */
console.log("── 6. wiring ─────────────────────────────────────────────");
/* ================================================================== */

{
  const { config } = await import("../tools/pdf-to-svg/config");
  check("config toolId", config.toolId === "pdf-to-svg");
  check("config outputKind image (vector files)", config.outputKind === "image");
  const optionIds = config.options.map((o) => o.id);
  check(
    "config options: pages + includeImages",
    optionIds.includes("pages") && optionIds.includes("includeImages"),
    optionIds
  );
  check(
    "config option kinds",
    config.options[0]?.kind === "pages" && config.options[1]?.kind === "switch"
  );
  check(
    "config option defaults (all + embed on)",
    config.options[0]?.default === "all" && config.options[1]?.default === true
  );
  check(
    "config chains to svg-to-pdf (the round-trip closes)",
    (config.chainToolIds ?? []).includes("svg-to-pdf")
  );
  check(
    "config features/faq bilingual",
    config.features.every((f) => f.en && f.hi) &&
      config.faq.every((q) => q.q.en && q.q.hi && q.a.en && q.a.hi)
  );
  check(
    "config howKeys are psvg.*",
    (config.howKeys ?? []).every((k) => k.startsWith("psvg."))
  );

  const registrySrc = readFileSync("src/lib/tools/registry.ts", "utf8");
  const regMatch = registrySrc.match(
    new RegExp(`id: "pdf-to-svg"[\\s\\S]*?mode: "(D|S)"[\\s\\S]*?enabled: (true|false)`)
  );
  check(
    "registry pdf-to-svg: mode D + enabled: true",
    regMatch?.[1] === "D" && regMatch?.[2] === "true",
    regMatch?.slice(1)
  );
  check(
    "registry honest description (vector, on-device)",
    registrySrc.includes(`id: "pdf-to-svg"`) &&
      /Vector SVG pages/.test(registrySrc)
  );

  const configsSrc = readFileSync("src/lib/tools/configs.ts", "utf8");
  check(
    "TOOL_CONFIGS routes pdf-to-svg",
    /pdfToSvg\.toolId\]\s*:\s*pdfToSvg/.test(configsSrc)
  );
  const surfacesSrc = readFileSync("src/lib/tools/surfaces.tsx", "utf8");
  check(
    "TOOL_SURFACES maps pdf-to-svg",
    /"pdf-to-svg": PdfToSvgSurface/.test(surfacesSrc)
  );

  // Worker honesty: the exact patterns the browser worker must carry.
  const workerSrc = readFileSync("tools/pdf-to-svg/worker.ts", "utf8");
  check(
    "worker loads pdf.js in fake-worker mode with the document shim",
    /loadPdfjsInWorker\(\)/.test(workerSrc) && /workerDocumentShim\(\)/.test(workerSrc)
  );
  check(
    "worker passes cMap/standard-font URLs",
    /cMapUrl: "\/pdfjs\/cmaps\/"/.test(workerSrc) &&
      /standardFontDataUrl: "\/pdfjs\/standard_fonts\/"/.test(workerSrc)
  );
  check(
    "worker rejects an invalid page spec (tool.errorInvalidPages)",
    /tool\.errorInvalidPages/.test(workerSrc)
  );
  check(
    "worker names outputs through svgOutputName",
    /svgOutputName\(/.test(workerSrc) && /SVG_MIME/.test(workerSrc)
  );
  check(
    "worker maps thrown errors via classifySvgError",
    /classifySvgError\(/.test(workerSrc)
  );
  check(
    "worker cleans up page + document objects",
    /page\.cleanup\(\)/.test(workerSrc) && /doc\.cleanup\(\)/.test(workerSrc)
  );
  check(
    "worker handles browser ImageBitmap payloads (OffscreenCanvas path)",
    /bitmapToRgba/.test(workerSrc) && /OffscreenCanvas/.test(workerSrc)
  );
}

/* ================================================================== */
console.log("── 7. i18n ───────────────────────────────────────────────");
/* ================================================================== */

{
  const toolI18n = JSON.parse(
    readFileSync("tools/pdf-to-svg/i18n.json", "utf8")
  ) as { en: { psvg: Record<string, string> }; hi: { psvg: Record<string, string> } };
  const enKeys = Object.keys(toolI18n.en.psvg).sort();
  const hiKeys = Object.keys(toolI18n.hi.psvg).sort();
  check(
    "tool i18n en/hi key parity",
    JSON.stringify(enKeys) === JSON.stringify(hiKeys),
    { en: enKeys.length, hi: hiKeys.length }
  );
  check("tool i18n holds the 23-leaf psvg namespace", enKeys.length === 23, enKeys.length);

  const surfaceSrc = readFileSync("tools/pdf-to-svg/surface.tsx", "utf8");
  const used = new Set<string>();
  for (const m of surfaceSrc.matchAll(/"psvg\.([A-Za-z0-9]+)"/g)) {
    used.add(m[1] as string);
  }
  const { config } = await import("../tools/pdf-to-svg/config");
  for (const k of config.howKeys ?? []) {
    used.add(k.replace(/^psvg\./, ""));
  }
  const missing = [...used].filter((k) => !enKeys.includes(k));
  check(
    "every psvg.* key referenced by surface+config resolves in the tool file",
    missing.length === 0,
    missing
  );
  check(
    "no unused psvg.* keys (tight namespace)",
    enKeys.every((k) => used.has(k)),
    enKeys.filter((k) => !used.has(k))
  );

  // The merged catalogs: every referenced key must resolve in BOTH.
  const en = JSON.parse(readFileSync("src/i18n/en.json", "utf8")) as {
    psvg?: Record<string, unknown>;
  };
  const hi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8")) as {
    psvg?: Record<string, unknown>;
  };
  const missingEn = [...used].filter((k) => !(k in (en.psvg ?? {})));
  const missingHi = [...used].filter((k) => !(k in (hi.psvg ?? {})));
  check(
    "every referenced psvg.* key resolves in src/i18n/en.json",
    missingEn.length === 0,
    missingEn
  );
  check(
    "every referenced psvg.* key resolves in src/i18n/hi.json",
    missingHi.length === 0,
    missingHi
  );
  check(
    "catalog psvg leaf count matches the tool file (23 × 2)",
    Object.keys(en.psvg ?? {}).length === 23 && Object.keys(hi.psvg ?? {}).length === 23,
    {
      en: Object.keys(en.psvg ?? {}).length,
      hi: Object.keys(hi.psvg ?? {}).length,
    }
  );
}

/* ================================================================== */

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("failing:", failures.slice(0, 25).join(" | "));
}
process.exit(fail > 0 ? 1 : 0);
