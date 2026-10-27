/**
 * P9 batch 1+2 smoke: pdf-to-tiff encoder + pdf-to-htmlmd outline engine.
 * Pure logic — runs in Bun, no DOM needed.
 * Run: bun scripts/smoke-p9-d2.ts
 */
import { encodeTiff } from "../tools/pdf-to-tiff/tiff";
import {
  detectHindi,
  documentBodySize,
  escapeHtml,
  escapeMarkdownLead,
  median,
  outlinePage,
  renderHtml,
  renderMarkdown,
  type PageBlocks,
} from "../tools/pdf-to-htmlmd/outline";

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

/* ============================ TIFF ============================ */
console.log("TIFF encoder");

// Page 1: 2x2 red/green/blue/white; Page 2: 1x1 magenta.
const rgba1 = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
const rgba2 = new Uint8ClampedArray([255, 0, 0, 128]); // semi-transparent red → composite check
const tiff = encodeTiff(
  [
    { width: 2, height: 2, rgba: rgba1 },
    { width: 1, height: 1, rgba: rgba2 },
  ],
  300
);

const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
check("header II magic", tiff[0] === 0x49 && tiff[1] === 0x49 && view.getUint16(2, true) === 42);
check("first IFD at 8", view.getUint32(4, true) === 8);

// --- Parse IFD 0 like a real reader would ---
const ifd0 = view.getUint32(4, true);
const n0 = view.getUint16(ifd0, true);
check("13 entries", n0 === 13, `got ${n0}`);
const tags = new Map<number, { type: number; count: number; value: number }>();
for (let i = 0; i < n0; i += 1) {
  const at = ifd0 + 2 + i * 12;
  const tag = view.getUint16(at, true);
  const type = view.getUint16(at + 2, true);
  const count = view.getUint32(at + 4, true);
  const value = type === 3 ? view.getUint16(at + 8, true) : view.getUint32(at + 8, true);
  tags.set(tag, { type, count, value });
}
check("ascending tag order", [...tags.keys()].every((t, i, a) => i === 0 || a[i - 1] < t));
check("ImageWidth 2", tags.get(256)?.value === 2);
check("ImageLength 2", tags.get(257)?.value === 2);
check("Compression none", tags.get(259)?.value === 1);
check("Photometric RGB", tags.get(262)?.value === 2);
check("SamplesPerPixel 3", tags.get(277)?.value === 3);
check("RowsPerStrip = height", tags.get(278)?.value === 2);
check("StripByteCounts w*h*3", tags.get(279)?.value === 12);
check("ResolutionUnit inch", tags.get(296)?.value === 2);
check("NewSubfileType first = 0", tags.get(254)?.value === 0);

// BitsPerSample external: 3 SHORTs = 8,8,8
const bpsOff = tags.get(258)!.value;
check(
  "BitsPerSample 8,8,8",
  view.getUint16(bpsOff, true) === 8 && view.getUint16(bpsOff + 2, true) === 8 && view.getUint16(bpsOff + 4, true) === 8
);
// XResolution rational 300/1
const xresOff = tags.get(282)!.value;
check("XResolution 300/1", view.getUint32(xresOff, true) === 300 && view.getUint32(xresOff + 4, true) === 1);

// Strip pixels: page 1 top-left red, then green, blue, white.
const strip0 = tags.get(273)!.value;
check("pixel 1 red", tiff[strip0] === 255 && tiff[strip0 + 1] === 0 && tiff[strip0 + 2] === 0);
check("pixel 2 green", tiff[strip0 + 3] === 0 && tiff[strip0 + 4] === 255 && tiff[strip0 + 5] === 0);
check("pixel 3 blue", tiff[strip0 + 6] === 0 && tiff[strip0 + 7] === 0 && tiff[strip0 + 8] === 255);
check("pixel 4 white", tiff[strip0 + 9] === 255 && tiff[strip0 + 10] === 255 && tiff[strip0 + 11] === 255);

// --- IFD 1 via the chain ---
const ifd1 = view.getUint32(ifd0 + 2 + n0 * 12, true);
check("IFD chain points at page 2", ifd1 > ifd0 && ifd1 < tiff.length);
const n1 = view.getUint16(ifd1, true);
check("page 2 has 13 entries", n1 === 13);
let w1 = 0, s1 = 0, sub1 = -1;
for (let i = 0; i < n1; i += 1) {
  const at = ifd1 + 2 + i * 12;
  const tag = view.getUint16(at, true);
  if (tag === 256) w1 = view.getUint32(at + 8, true);
  if (tag === 273) s1 = view.getUint32(at + 8, true);
  if (tag === 254) sub1 = view.getUint32(at + 8, true);
}
check("page 2 width 1", w1 === 1);
check("page 2 NewSubfileType = 2 (multi-page)", sub1 === 2);
// rgba red at 50% alpha composited on white = 255,127/128,127/128
const r = tiff[s1], g = tiff[s1 + 1], b = tiff[s1 + 2];
check(
  "alpha composited onto white",
  r === 255 && Math.abs(g - 127) <= 1 && Math.abs(b - 127) <= 1,
  `got rgb(${r},${g},${b})`
);
check("last page next-IFD = 0", view.getUint32(ifd1 + 2 + n1 * 12, true) === 0);
check("total size accounted", tiff.length >= s1 + 3);

// Pad-to-4 check with a 3px-wide page (9 bytes strip → padded 12).
const odd = encodeTiff([{ width: 3, height: 1, rgba: new Uint8ClampedArray(12).fill(255) }], 72);
check("odd strips still encode", odd.length > 0 && odd[0] === 0x49);

// Empty pages must throw.
let threw = false;
try {
  encodeTiff([], 150);
} catch {
  threw = true;
}
check("empty page list throws", threw);

/* ========================= outline engine ========================= */
console.log("outline engine");

interface RawItem {
  str: string;
  transform: number[];
  width: number;
}
function item(str: string, x: number, y: number, size: number): RawItem {
  return { str, transform: [size, 0, 0, size, x, y], width: str.length * size * 0.5 };
}

// --- median ---
check("median odd", median([1, 5, 3]) === 3);
check("median even", median([1, 2, 3, 10]) === 2.5);
check("median empty", median([]) === 10);

// --- documentBodySize: pages of body-10 lines with a few big headings ---
const body = Array.from({ length: 9 }, (_, i) => item(`body line ${i}`, 40, 700 - i * 14, 10));
const docPages = [
  [item("Big Title", 40, 780, 24), ...body],
  [...body.slice(0, 3), item("Section", 40, 780, 13)],
];
const bodySize = documentBodySize(docPages as never);
check("body size = median of lines", Math.abs(bodySize - 10) < 0.01, `got ${bodySize}`);

// --- heading bucketing (Office-tuned: h1 ≥ 2.0, h2 ≥ 1.42, h3 ≥ 1.15) ---
const p1 = outlinePage(
  [item("Chapter", 40, 780, 20), item("Section", 40, 740, 15), item("Sub", 40, 710, 11.5), item("Just text here", 40, 680, 10)] as never,
  10
);
check("h1 at 2.0x", p1[0]?.kind === "h1" && p1[0].text === "Chapter");
check("h2 at 1.5x", p1[1]?.kind === "h2" && p1[1].text === "Section");
check("h3 at 1.15x", p1[2]?.kind === "h3" && p1[2].text === "Sub");
check("body stays p", p1[3]?.kind === "p");
const p1c = outlinePage([item("Sub", 40, 710, 11.2), item("Just text here", 40, 680, 10)] as never, 10);
check("1.12x below h3 stays p", p1c[0]?.kind === "p");
const p1b = outlinePage([item("Sub", 40, 710, 11.5), item("Just text here", 40, 680, 10)] as never, 10);
check("h3 at 1.15x exact edge", p1b[0]?.kind === "h3" && p1b[0].text === "Sub");

// Long line never a heading.
const long = "x".repeat(130);
const p2 = outlinePage([item(long, 40, 780, 24), ...body] as never, 10);
check("130-char line stays p", p2.every((b) => b.kind !== "h1"));

// Comma-ended line below h2 ratio stays p (wrapped body text).
const p3 = outlinePage([item("wrapped body text,", 40, 780, 12), ...body] as never, 10);
check("comma line stays p", p3.every((b) => b.kind === "p"));

// --- lists ---
const p4 = outlinePage(
  [
    item("• alpha", 40, 780, 10),
    item("• beta", 40, 760, 10),
    item("1. first", 40, 730, 10),
    item("2) second", 40, 710, 10),
    item("(a) third", 40, 690, 10),
    item("IV. roman", 40, 670, 10),
    item("- dash bullet", 40, 650, 10),
  ] as never,
  10
);
check("bullet li", p4[0]?.kind === "li" && p4[0].text === "alpha" && p4[0].ordered === false);
check("dash bullet li", p4[6]?.kind === "li" && p4[6].text === "dash bullet" && p4[6].ordered === false);
check("1. ordered", p4[2]?.ordered === true && p4[2].text === "first");
check("2) ordered", p4[3]?.ordered === true && p4[3].text === "second");
check("(a) ordered", p4[4]?.ordered === true && p4[4].text === "third");
check("IV. ordered", p4[5]?.ordered === true && p4[5].text === "roman");

// --- paragraph flow: big gap splits, hyphen heals ---
const p5 = outlinePage(
  [
    item("exam-", 40, 700, 10),
    item("ple continues", 40, 690, 10),
    item("second para", 40, 640, 10), // gap 50 > 1.7*10
  ] as never,
  10
);
check("dehyphenation", p5[0]?.text === "example continues");
check("gap splits paragraphs", p5.length === 2 && p5[1].text === "second para");

// --- escapeHtml / markdown lead ---
check("escapeHtml", escapeHtml(`<a href="x">&</a>`) === "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
check("escapeMd #", escapeMarkdownLead("# not a heading") === "\\# not a heading");
check("escapeMd 1.", escapeMarkdownLead("1. not a list") === "1\\. not a list");
check("escapeMd rule", escapeMarkdownLead("---") === "\\---");
check("no escape mid", escapeMarkdownLead("x # 1. y") === "x # 1. y");

// --- Hindi detection ---
const hiPage: PageBlocks = {
  pageNumber: 1,
  blocks: [{ kind: "p", text: "करें ".repeat(50), ordered: false }],
};
const enPage: PageBlocks = {
  pageNumber: 1,
  blocks: [{ kind: "p", text: "regular english text ".repeat(20), ordered: false }],
};
check("detectHindi true", detectHindi([hiPage]) === true);
check("detectHindi false", detectHindi([enPage]) === false);

// --- renderHtml: single page no section, lists grouped ---
const single: PageBlocks = {
  pageNumber: 1,
  blocks: [
    { kind: "h1", text: "Title <1>", ordered: false },
    { kind: "p", text: "Para", ordered: false },
    { kind: "li", text: "b1", ordered: false },
    { kind: "li", text: "b2", ordered: false },
    { kind: "li", text: "n1", ordered: true },
  ],
};
const html = renderHtml([single], "Title <1>", "en");
check("html has doctype+lang", html.startsWith("<!doctype html>\n<html lang=\"en\">"));
check("h1 escaped", html.includes("<h1>Title &lt;1&gt;</h1>"));
check("ul group", html.includes("<ul>\n      <li>b1</li>\n      <li>b2</li>\n    </ul>"));
check("ol after ul", html.indexOf("<ol>") > html.indexOf("</ul>"));
check("no page section for single", !html.includes("class=\"page\""));
check("viewport meta", html.includes('name="viewport"'));

const multi = renderHtml(
  [single, { pageNumber: 7, blocks: [{ kind: "p", text: "later", ordered: false }] }],
  "T",
  "hi"
);
check("multi wraps sections", multi.includes('<section class="page" aria-label="Page 1">') && multi.includes('aria-label="Page 7">'));
check("lang hi", multi.includes('<html lang="hi">'));
check("page number label", multi.includes('<p class="pagenum">Page 7</p>'));

// --- renderMarkdown ---
const mdPages: PageBlocks[] = [
  {
    pageNumber: 1,
    blocks: [
      { kind: "h1", text: "Doc", ordered: false },
      { kind: "h3", text: "Small", ordered: false },
      { kind: "p", text: "# not heading", ordered: false },
      { kind: "li", text: "a", ordered: false },
      { kind: "li", text: "b", ordered: false },
      { kind: "li", text: "one", ordered: true },
      { kind: "li", text: "two", ordered: true },
    ],
  },
  { pageNumber: 2, blocks: [{ kind: "p", text: "next page", ordered: false }] },
];
const md = renderMarkdown(mdPages, true);
check("md h1", md.includes("# Doc"));
check("md h3", md.includes("### Small"));
check("md escaped lead", md.includes("\\# not heading"));
check("md bullets", md.includes("- a") && md.includes("- b"));
check("md renumbered", md.includes("1. one") && md.includes("2. two"));
check("md page break", md.includes("---\n\nnext page"));
const mdNoBreaks = renderMarkdown(mdPages, false);
check("md no page break", !mdNoBreaks.includes("---\n\nnext page") && mdNoBreaks.includes("next page"));

/* ============================ summary ============================ */
console.log(`\n${pass} passed, ${fail} failed (of ${pass + fail})`);
if (fail > 0) process.exit(1);
