/**
 * Smoke: publisher-to-pdf (RB4-e / RB4-SMOKE-c) — .pub → PDF text salvage.
 *
 * House conventions (smoke-webpage-to-pdf / smoke-pdf-to-odt base):
 * relative imports WITHOUT .ts, regenerator-runtime first (pdf.js),
 * plain check() helper, process.exit at the end.
 *
 *  1. Pure helpers — isOle2File, isWinAnsiText, hindiNorm,
 *     classifyHeading, outputPdfName (incl. the path-unsafe-char fix),
 *     extractStreamText encoding/splitting tamper vectors, constants.
 *  2. REAL CFB fixture — built by the smoke's own OLE2/CFB writer
 *     (512-byte sectors, header + DIFAT→FAT with INTERLEAVED stream
 *     chains so the reader must follow FAT jumps, 128-byte directory
 *     entries with UTF-16LE names + a type-1 storage entry, mini-FAT +
 *     the root's mini stream for streams < 4096, streams ≥ 4096 in the
 *     normal FAT): parseCfb structure oracle (entry order, names, sizes,
 *     both chain paths, byte-exact data), extractStories verdicts
 *     (utf16/ascii per stream, EN + Devanagari + XML-hostile ASCII),
 *     parsePub reflow + heading heuristic + hindiNorm.
 *  3. v4 CFB (4096-byte sectors) — the MS-CFB (N+1)×sectorSize rule.
 *  4. Caps + honesty — MAX_PARAGRAPHS / MAX_TOTAL_CHARS / MAX_PARA_TEXT,
 *     consecutive-duplicate story-thumbnail collapse.
 *  5. REAL renders through the worker's exact pipeline (parsePub →
 *     needsNoto → base-14 Helvetica OR the self-hosted Noto Devanagari
 *     subset → drawPubPdf): EN-only (no embed, /Helvetica-Bold for
 *     headings) + the full mixed fixture (Noto FontFile2 + Identity-H),
 *     pdf.js getTextContent round-trip EN + Devanagari, Letter/narrow
 *     geometry, the bold-wrap vector (right-margin overflow guard),
 *     multi-page pagination + estimatePages honesty.
 *  6. Worker E2E — the real worker.ts driven through a self-shimmed
 *     globalThis (postMessage/location/self + fetch serving the local
 *     Noto TTF, the smoke-pdf-to-odt lines ~555-565 recipe): EN + full
 *     Hindi runs, progress pcts, output naming (sanitized), detail
 *     fields, rejection codes.
 *  7. Rejection vectors — garbage/ZIP/plain-text → the honest taxonomy;
 *     OLE-magic-but-no-sectors, truncated-mid-FAT, byte-order and
 *     sector-shift tamper → errCorrupt; valid container with no text
 *     streams (incl. an EncryptedPackage stand-in) → the documented
 *     honest errNoText; broken-chain container → errStreamRead; a
 *     partially-broken chain → honest partial salvage + streamFailure
 *     counted.
 *  8. Wiring + i18n — registry (enabled/mode D/honest description),
 *     configs.ts + surfaces.tsx routing, config.ts options/accepts,
 *     tool i18n en/hi parity (47 leaves), every referenced pub.* key
 *     resolves in BOTH src/i18n catalogs.
 *
 * Run: bun scripts/smoke-publisher-to-pdf.ts
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  classifyHeading,
  estimatePages,
  extractStories,
  extractStreamText,
  hindiNorm,
  HEADING_SCALE,
  isOle2File,
  isWinAnsiText,
  MARGIN_PT,
  MAX_PARA_TEXT,
  MAX_TOTAL_CHARS,
  MAX_PARAGRAPHS,
  needsNoto,
  outputPdfName,
  PAGE_SIZES,
  parseCfb,
  parsePub,
  PubError,
  type ParsedPub,
} from "../tools/publisher-to-pdf/model";
import { drawPubPdf } from "../tools/publisher-to-pdf/render";
import type {
  WorkerRunRequest,
  WorkerResponse,
} from "../src/lib/workers/protocol";

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
      actual !== undefined ? JSON.stringify(actual).slice(0, 300) : ""
    );
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** UTF-16LE encoder (BMP chars — everything .pub stories use). */
function u16le(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    out[i * 2] = c & 0xff;
    out[i * 2 + 1] = c >> 8;
  }
  return out;
}

/**
 * A .pub-style story stream: a small binary record header before every
 * paragraph (so text runs are genuinely separated by non-text gaps), the
 * paragraph text, and the paragraph terminator inside the run.
 */
function storyBytes(
  paras: string[],
  utf16: boolean,
  joiner = "\r\n"
): Uint8Array {
  const chunks: number[] = [];
  const noise = [0x01, 0x02, 0x03, 0x04];
  for (const p of paras) {
    for (const b of noise) chunks.push(b);
    const s = `${p}${joiner}`;
    if (utf16) {
      for (let i = 0; i < s.length; i += 1) {
        const c = s.charCodeAt(i);
        chunks.push(c & 0xff, c >> 8);
      }
    } else {
      for (let i = 0; i < s.length; i += 1) chunks.push(s.charCodeAt(i) & 0xff);
    }
  }
  return new Uint8Array(chunks);
}

/**
 * Binary noise with NO byte ≥ 0x20 and no 0x09/0x0a/0x0d — guaranteed to
 * form no text run in either the UTF-16 or the ASCII scan (a "09" pair
 * high byte would fake Devanagari, so 0x09 stays out of the pattern).
 */
function noiseBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const pattern = [
    0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x0b, 0x0e, 0x11, 0x14, 0x17, 0x1a,
    0x1d, 0x1f,
  ];
  for (let i = 0; i < n; i += 1) out[i] = pattern[i % pattern.length]!;
  return out;
}

/** Tops a paragraph list up past a byte threshold with distinct fillers. */
function padParas(
  paras: string[],
  minBytes: number,
  utf16: boolean,
  line: (n: number) => string
): string[] {
  const out = [...paras];
  const bytesOf = (s: string): number => (utf16 ? s.length * 2 : s.length);
  let total = 0;
  for (const p of out) total += bytesOf(p) + 2;
  let n = 1;
  while (total < minBytes) {
    const l = line(n);
    out.push(l);
    total += bytesOf(l) + 2;
    n += 1;
  }
  return out;
}

/** node:zlib inflate oracle over the PDF content streams (webpage smoke). */
function inflatedText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  let out = "";
  let idx = 0;
  for (;;) {
    const s = raw.indexOf("stream", idx);
    if (s < 0) break;
    let start = s + 6;
    if (raw[start] === "\r") start += 1;
    if (raw[start] === "\n") start += 1;
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

const notoBytes = new Uint8Array(
  readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf")
);

/** pdf.js in-process extraction (smoke-pdf-to-odt recipe). */
interface ItemLike {
  str: string;
  width: number;
  transform: number[];
}

async function pdfjsPages(bytes: Uint8Array): Promise<ItemLike[][]> {
  const task = getDocument({ data: bytes.slice(), useSystemFonts: true });
  const pdf = await task.promise;
  const pages: ItemLike[][] = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    try {
      const content = await page.getTextContent();
      pages.push(content.items as unknown as ItemLike[]);
    } finally {
      page.cleanup();
    }
  }
  await pdf.cleanup();
  await task.destroy();
  return pages;
}

function objDump(doc: PDFDocument): string {
  return [...doc.context.enumerateIndirectObjects()]
    .map(([, o]) => o.toString())
    .join("\n");
}

/** Every non-empty drawn item stays inside the text column. */
function checkMargins(
  pages: ItemLike[][],
  pageW: number,
  margin: number,
  label: string
): void {
  const right = pageW - margin;
  for (const page of pages) {
    for (const it of page) {
      if (!it.str || !it.str.trim()) continue;
      const x = it.transform[4] ?? 0;
      check(
        `${label}: right margin kept ("${it.str.slice(0, 16)}")`,
        x + it.width <= right + 3,
        `${(x + it.width).toFixed(1)} > ${right.toFixed(1)}`
      );
      check(
        `${label}: left margin kept ("${it.str.slice(0, 16)}")`,
        x >= margin - 3,
        x
      );
    }
  }
}

/** The worker's exact render recipe (needsNoto → font pick → drawPubPdf). */
async function renderDoc(
  doc: ParsedPub,
  opts: { pageSize: "a4" | "letter"; margin: "normal" | "narrow"; baseSize: number }
): Promise<{
  bytes: Uint8Array;
  pages: number;
  reportPages: number;
  reloaded: PDFDocument;
}> {
  const pdfDoc = await PDFDocument.create();
  let font: PDFFont;
  let boldFont: PDFFont | null = null;
  if (needsNoto(doc)) {
    pdfDoc.registerFontkit(fontkit);
    font = await pdfDoc.embedFont(notoBytes, { subset: true });
  } else {
    font = pdfDoc.embedStandardFont(StandardFonts.Helvetica);
    boldFont = pdfDoc.embedStandardFont(StandardFonts.HelveticaBold);
  }
  const report = drawPubPdf(pdfDoc, font, boldFont, doc, opts);
  const bytes = await pdfDoc.save();
  const reloaded = await PDFDocument.load(bytes);
  return {
    bytes,
    pages: reloaded.getPageCount(),
    reportPages: report.pages,
    reloaded,
  };
}

function pubCode(bytes: Uint8Array): string {
  try {
    parsePub(bytes);
    return "ok";
  } catch (error) {
    return error instanceof PubError ? error.code : `throw:${String(error)}`;
  }
}

/* ------------------------------------------------------------------ */
/* The smoke's own OLE2/CFB writer                                      */
/* ------------------------------------------------------------------ */

const CFB_FREE = 0xffffffff;
const CFB_END = 0xfffffffe;
const CFB_FATSECT = 0xfffffffd;

interface CfbStreamSpec {
  name: string;
  data: Uint8Array;
}

interface CfbBuildOpts {
  streams: CfbStreamSpec[];
  /** extra type-1 (storage) directory entry, like real .pub files */
  storageName?: string;
  rootName?: string;
  /** v4 (4096-byte sectors, sector 0 after 3584 bytes of header pad) */
  v4?: boolean;
  /** tamper: this stream's start sector points out of range */
  breakStart?: string;
  /** tamper: this stream's FAT chain is cut after its first sector */
  breakChain?: string;
}

function buildCfb(opts: CfbBuildOpts): Uint8Array {
  const sectorSize = opts.v4 ? 4096 : 512;
  const miniSectorSize = 64;
  const miniCutoff = 4096;
  const small = opts.streams.filter((s) => s.data.length < miniCutoff);
  const big = opts.streams.filter((s) => s.data.length >= miniCutoff);

  /* ---- mini stream: small streams concatenated at 64-byte alignment */
  const miniBytes: number[] = [];
  const miniStart = new Map<string, number>();
  for (const s of small) {
    const startSector = Math.ceil(miniBytes.length / miniSectorSize);
    while (miniBytes.length < startSector * miniSectorSize) miniBytes.push(0);
    miniStart.set(s.name, startSector);
    for (const b of s.data) miniBytes.push(b);
  }
  const miniStreamLen = miniBytes.length;
  const miniSectorCount = Math.ceil(miniStreamLen / miniSectorSize);

  /* ---- directory sizing */
  const perDirSector = Math.floor(sectorSize / 128);
  const entryCount = 1 + (opts.storageName ? 1 : 0) + opts.streams.length;
  const dirSectors = Math.max(1, Math.ceil(entryCount / perDirSector));

  /* ---- big-stream sector numbers, INTERLEAVED so chains must jump */
  const counts = big.map((s) => Math.ceil(s.data.length / sectorSize));
  const totalBig = counts.reduce((a, b) => a + b, 0);
  const bigSectors = new Map<string, number[]>();
  let nextSector = dirSectors;
  const maxCount = counts.reduce((a, b) => Math.max(a, b), 0);
  for (let k = 0; k < maxCount; k += 1) {
    for (let j = 0; j < big.length; j += 1) {
      if (k < counts[j]!) {
        const list = bigSectors.get(big[j]!.name) ?? [];
        list.push(nextSector);
        bigSectors.set(big[j]!.name, list);
        nextSector += 1;
      }
    }
  }

  const miniStreamSectors = Math.ceil(miniStreamLen / sectorSize);
  const miniFatSectors =
    miniSectorCount > 0
      ? Math.ceil(miniSectorCount / Math.floor(sectorSize / 4))
      : 0;

  /* ---- FAT sector count fixpoint (a FAT sector covers sectorSize/4) */
  const perFatSector = Math.floor(sectorSize / 4);
  let fatSectors = 1;
  for (;;) {
    const total =
      dirSectors + totalBig + miniStreamSectors + miniFatSectors + fatSectors;
    const need = Math.ceil(total / perFatSector);
    if (need <= fatSectors) break;
    fatSectors = need;
  }
  const totalSectors =
    dirSectors + totalBig + miniStreamSectors + miniFatSectors + fatSectors;
  const fatStartSec = totalSectors - fatSectors;
  const miniStreamStartSec = miniStreamSectors > 0 ? dirSectors + totalBig : -1;
  const miniFatStartSec =
    miniFatSectors > 0 ? dirSectors + totalBig + miniStreamSectors : -1;

  /* ---- FAT (flat next-sector table) */
  const fat = new Array<number>(fatSectors * perFatSector).fill(CFB_FREE);
  for (let i = 0; i < dirSectors; i += 1) {
    fat[i] = i + 1 < dirSectors ? i + 1 : CFB_END;
  }
  for (const [name, secs] of bigSectors) {
    for (let i = 0; i < secs.length; i += 1) {
      const s = secs[i]!;
      let next: number;
      if (opts.breakChain === name && i === 0) next = CFB_FREE;
      else next = i + 1 < secs.length ? secs[i + 1]! : CFB_END;
      fat[s] = next;
    }
  }
  for (let i = 0; i < miniStreamSectors; i += 1) {
    const s = miniStreamStartSec + i;
    fat[s] = i + 1 < miniStreamSectors ? s + 1 : CFB_END;
  }
  for (let i = 0; i < miniFatSectors; i += 1) {
    const s = miniFatStartSec + i;
    fat[s] = i + 1 < miniFatSectors ? s + 1 : CFB_END;
  }
  for (let i = 0; i < fatSectors; i += 1) fat[fatStartSec + i] = CFB_FATSECT;

  /* ---- mini FAT */
  const miniFat = new Array<number>(miniFatSectors * perFatSector).fill(
    CFB_FREE
  );
  for (const s of small) {
    const start = miniStart.get(s.name)!;
    const count = Math.ceil(s.data.length / miniSectorSize);
    for (let i = 0; i < count; i += 1) {
      miniFat[start + i] = i + 1 < count ? start + i + 1 : CFB_END;
    }
  }

  /* ---- file assembly (MS-CFB: sector N lives at (N+1) × sectorSize) */
  const headerLen = 512;
  const fileLen = (opts.v4 ? sectorSize : headerLen) + totalSectors * sectorSize;
  const out = new Uint8Array(fileLen);
  const dv = new DataView(out.buffer);

  out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  dv.setUint16(0x18, 0x003e, true); // minor version
  dv.setUint16(0x1a, opts.v4 ? 4 : 3, true);
  dv.setUint16(0x1c, 0xfffe, true); // little endian
  dv.setUint16(0x1e, opts.v4 ? 12 : 9, true);
  dv.setUint16(0x20, 6, true); // 64-byte mini sectors
  dv.setUint32(0x2c, opts.v4 ? dirSectors : 0, true);
  dv.setUint32(0x30, 0, true); // first directory sector
  dv.setUint32(0x38, miniCutoff, true);
  dv.setUint32(
    0x3c,
    miniFatSectors > 0 ? miniFatStartSec : CFB_END,
    true
  );
  dv.setUint32(0x40, miniFatSectors, true);
  dv.setUint32(0x44, CFB_END, true); // no DIFAT sectors
  dv.setUint32(0x48, 0, true);
  for (let i = 0; i < 109; i += 1) {
    dv.setUint32(
      0x4c + i * 4,
      i < fatSectors ? fatStartSec + i : CFB_FREE,
      true
    );
  }

  const putSector = (s: number, data: Uint8Array): void => {
    out.set(data.subarray(0, sectorSize), (s + 1) * sectorSize);
  };
  const padInto = (len: number): Uint8Array => {
    const buf = new Uint8Array(len);
    for (let i = 0; i < len && i < miniStreamLen; i += 1) buf[i] = miniBytes[i]!;
    return buf;
  };

  // directory
  const dir = new Uint8Array(dirSectors * sectorSize);
  const dirDv = new DataView(dir.buffer);
  const writeEntry = (
    slot: number,
    name: string,
    type: number,
    start: number,
    size: number
  ): void => {
    const off = slot * 128;
    const chars = Math.min(name.length, 31);
    for (let i = 0; i < chars; i += 1) {
      const c = name.charCodeAt(i);
      dir[off + i * 2] = c & 0xff;
      dir[off + i * 2 + 1] = c >> 8;
    }
    const nameLen = (chars + 1) * 2;
    dir[off + 0x40] = nameLen & 0xff;
    dir[off + 0x41] = nameLen >> 8;
    dir[off + 0x42] = type;
    dir[off + 0x43] = 1; // black
    dirDv.setUint32(off + 0x44, CFB_FREE, true); // left sibling
    dirDv.setUint32(off + 0x48, CFB_FREE, true); // right sibling
    dirDv.setUint32(off + 0x4c, CFB_FREE, true); // child
    dirDv.setUint32(off + 0x74, start, true);
    dirDv.setUint32(off + 0x78, size, true);
    dirDv.setUint32(off + 0x7c, 0, true);
  };
  let slot = 0;
  writeEntry(
    slot,
    opts.rootName ?? "Root Entry",
    5,
    miniStreamSectors > 0 ? miniStreamStartSec : CFB_END,
    miniStreamLen
  );
  slot += 1;
  if (opts.storageName) {
    writeEntry(slot, opts.storageName, 1, CFB_END, 0);
    slot += 1;
  }
  for (const s of opts.streams) {
    let start: number;
    if (opts.breakStart === s.name) start = totalSectors + 7;
    else if (s.data.length < miniCutoff) start = miniStart.get(s.name)!;
    else start = bigSectors.get(s.name)![0]!;
    writeEntry(slot, s.name, 2, start, s.data.length);
    slot += 1;
  }
  for (let i = 0; i < dirSectors; i += 1) {
    putSector(
      i,
      dir.subarray(i * sectorSize, (i + 1) * sectorSize)
    );
  }

  // big stream sectors (interleaved physical order)
  for (const [name, secs] of bigSectors) {
    const data = opts.streams.find((s) => s.name === name)!.data;
    for (let i = 0; i < secs.length; i += 1) {
      putSector(
        secs[i]!,
        data.subarray(i * sectorSize, (i + 1) * sectorSize)
      );
    }
  }

  // mini stream (the root's chain)
  for (let i = 0; i < miniStreamSectors; i += 1) {
    putSector(miniStreamStartSec + i, padInto((i + 1) * sectorSize));
  }

  // mini FAT sectors
  for (let i = 0; i < miniFatSectors; i += 1) {
    const buf = new Uint8Array(sectorSize);
    const bufDv = new DataView(buf.buffer);
    for (let k = 0; k < perFatSector; k += 1) {
      const idx = i * perFatSector + k;
      if (idx < miniFat.length) bufDv.setUint32(k * 4, miniFat[idx]!, true);
    }
    putSector(miniFatStartSec + i, buf);
  }

  // FAT sectors
  for (let i = 0; i < fatSectors; i += 1) {
    const buf = new Uint8Array(sectorSize);
    const bufDv = new DataView(buf.buffer);
    for (let k = 0; k < perFatSector; k += 1) {
      const idx = i * perFatSector + k;
      if (idx < fat.length) bufDv.setUint32(k * 4, fat[idx]!, true);
    }
    putSector(fatStartSec + i, buf);
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Fixture A — the realistic publication                               */
/* ------------------------------------------------------------------ */

const EN_PARAS = padParas(
  [
    "WINTER OPEN DAY AT THE LIBRARY",
    "Saturday, 14 February 2026, from 10 am to 4 pm.",
    "Free Entry And Guided Tours",
    "The city library opens its doors for a full day of reading corners, guided tours, and family activities. Volunteers will be present in every hall to answer questions about membership, digital lending, and the winter programme.",
    "Children can join the storytelling hour at eleven in the morning, followed by a drawing workshop in the afternoon. Both sessions are free of charge and require no prior registration; seats are limited to the room capacity of forty.",
    "Tea, coffee and light snacks are served in the reading room throughout the day. Visitors with specific accessibility needs are asked to write to the front desk so that ramps, lifts and quiet corners can be arranged in advance.",
    "The used-book sale returns this year: hardcovers for a modest donation, paperbacks by the kilo, and a rare first-edition table curated by the volunteers. Proceeds go to the winter repair fund for the children's section.",
    "A short exhibition about the library's hundred-year history will be displayed along the main corridor, with original photographs, ledger books and newspaper clippings from the opening decade of the previous century.",
    "Registration desk: members may renew cards, update addresses, and collect reserved items. New members are welcome on the spot; bring one photo identification and a proof of address for instant enrollment in the lending scheme.",
    "Parking around the building is limited; the tram lines four and nine stop directly at the front gate, and the bicycle shed behind the annex is open and supervised during opening hours of the winter open day.",
    "Weather notice: in case of heavy snow the event moves one week later, and every registered visitor receives a message. The decision is published on the notice board and the local radio at seven in the morning.",
    "We look forward to welcoming you, your family, your friends and your neighbours to the warmest room in town on the fourteenth of February.",
  ],
  4200,
  true,
  (n) =>
    `Winter open day notice ${n}: additional announcements, signage and volunteer shifts are confirmed in the programme.`
);

const HI_PARAS = [
  "पुस्तकालय में शीतकालीन खुला दिवस",
  "यह रिपोर्ट आपके डिवाइस पर बनती है।",
  "प्रवेश निःशुल्क है और सभी उम्र के पाठक आ सकते हैं।",
  'मेहमानों का "स्वागत" पढ़ने के कोने में होगा।',
  "बच्चों के लिए कहानी सुनाने का कार्यक्रम ग्यारह बजे है।",
];

const AS_PARAS = padParas(
  [
    "QUARTERLY BULLETIN 2026",
    "Finance: revenue & costs, margins and the full-year outlook in one honest table.",
    "Units: Q1 < Q2 in shipments, while Q3 > Q4 was the plan agreed at the last review.",
    "Quotes stay: \"straight\" and single ' marks are preserved in the PDF text layer.",
    "Attendance: 150+ visitors on the open day, a 25% increase over last year, measured at the door.",
    "The warehouse audit found 12 pallets, 3 forklifts and 0 missing safety vests; the report is filed.",
    "Regional splits: North 41%, South 27%, East 19%, West 13%; rounding keeps the totals honest.",
    "Customer notes arrive by post (38%), email (44%) and the web form (18%); all are logged the same day.",
    "Tabs\tinside an ascii story do not flip the encoding sniff, and collapse to single spaces.",
    "Headcount: 22 in engineering, 15 in support, 9 in operations and 4 in the finance office.",
    "The print run for the bulletin is 500 copies; the archive copy stays in the library basement.",
    "Corrections from the previous quarter: page 4 totals, the spelling of two supplier names.",
    "Back issues are available on request; allow one week for the office to find and post them.",
  ],
  4200,
  false,
  (n) =>
    `Supplement line ${n}: archive, delivery and corrections desks report steady demand throughout the quarter.`
);

const HI_PARAS_NORM = HI_PARAS.map((p) => hindiNorm(p));

const enStoryBytes = storyBytes(EN_PARAS, true);
const hiStoryBytes = new Uint8Array([0x01, ...storyBytes(HI_PARAS, true, "\n")]); // odd offset → the align-1 UTF-16 scan
const asStoryBytes = storyBytes(AS_PARAS, false);

check("fixture A: EN story ≥ 4096 bytes (normal FAT path)", enStoryBytes.length >= 4096, enStoryBytes.length);
check("fixture A: Hindi story < 4096 bytes (mini-FAT path)", hiStoryBytes.length > 40 && hiStoryBytes.length < 4096, hiStoryBytes.length);
check("fixture A: ASCII story ≥ 4096 bytes (normal FAT path)", asStoryBytes.length >= 4096, asStoryBytes.length);

const fixtureA = buildCfb({
  streams: [
    { name: "Contents", data: noiseBytes(96) },
    { name: "EnglishStory", data: enStoryBytes },
    { name: "HindiStory", data: hiStoryBytes },
    { name: "AsciiStory", data: asStoryBytes },
  ],
  storageName: "Quill",
});

/* ------------------------------------------------------------------ */
console.log("── 1. Pure helper vectors ──────────────────────────────");
{
  check("isOle2File: exact magic", isOle2File(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])));
  check("isOle2File: last byte wrong", !isOle2File(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe2])));
  check("isOle2File: empty", !isOle2File(new Uint8Array(0)));
  check("isOle2File: 7 bytes too short", !isOle2File(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a])));
  check("isOle2File: magic + trailing", isOle2File(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0, 0, 0, 0, 0])));

  check("isWinAnsiText: plain ASCII", isWinAnsiText("Plain ASCII 123 (x)!"));
  check("isWinAnsiText: Latin-1 + WinAnsi punctuation", isWinAnsiText("café — “naïve” … €"));
  check("isWinAnsiText: Devanagari rejected", !isWinAnsiText("यह हिंदी है"));
  check("isWinAnsiText: rupee sign rejected (not WinAnsi)", !isWinAnsiText("₹500"));
  check("isWinAnsiText: control chars rejected", !isWinAnsiText("a\nb"));

  check("hindiNorm: quotes stripped from Devanagari", hindiNorm('हिंदी "उद्धरण" पाठ') === "हिंदी उद्धरण पाठ");
  check("hindiNorm: English quotes preserved", hindiNorm('English "quoted" text') === 'English "quoted" text');
  check("hindiNorm: empty", hindiNorm("") === "");

  check("classifyHeading: ALL CAPS → 1", classifyHeading("WINTER OPEN DAY AT THE LIBRARY") === 1);
  check("classifyHeading: Title Case → 2", classifyHeading("Free Entry And Guided Tours") === 2);
  check("classifyHeading: sentence with period → body", classifyHeading("This is a full sentence.") === undefined);
  check("classifyHeading: lowercase start → body", classifyHeading("the lowercase line starts small") === undefined);
  check("classifyHeading: > 64 chars → body", classifyHeading("A".repeat(65)) === undefined);
  check("classifyHeading: digits only → body", classifyHeading("1234 5678") === undefined);
  check("classifyHeading: single ALL-CAPS word → 1", classifyHeading("HELLO") === 1);
  check("classifyHeading: short Devanagari without danda → 2", classifyHeading("पुस्तकालय में खुला दिवस") === 2);
  check("classifyHeading: Devanagari with danda → body", classifyHeading("यह एक वाक्य है।") === undefined);
  check("classifyHeading: empty → body", classifyHeading("") === undefined);

  check("outputPdfName: Newsletter.pub", outputPdfName("Newsletter.pub", "document") === "Newsletter.pdf");
  check("outputPdfName: uppercase .PUB", outputPdfName("Archive.PUB", "document") === "Archive.pdf");
  check("outputPdfName: .publisher suffix", outputPdfName("file.publisher", "document") === "file.pdf");
  check("outputPdfName: no extension", outputPdfName("plainname", "document") === "plainname.pdf");
  check(
    "outputPdfName: path separators sanitized (documented contract)",
    outputPdfName("a/b:c.pub", "document") === "a_b_c.pdf",
    outputPdfName("a/b:c.pub", "document")
  );
  check(
    "outputPdfName: windows-reserved chars sanitized",
    outputPdfName('What? "No" <2026>*.pub', "document") === "What_ _No_ _2026__.pdf",
    outputPdfName('What? "No" <2026>*.pub', "document")
  );
  check("outputPdfName: & survives (legal filename char)", outputPdfName("Q1 & Q2.pub", "document") === "Q1 & Q2.pdf");
  check("outputPdfName: localized fallback", outputPdfName(".pub", "दस्तावेज़") === "दस्तावेज़.pdf");
  check("outputPdfName: empty name falls back to English word", outputPdfName("", "document") === "document.pdf");
  check("outputPdfName: controls replaced", outputPdfName("bad\x01name.pub", "document") === "bad_name.pdf");

  // extractStreamText encoding vectors
  const t1 = extractStreamText(u16le("Hello library world, we welcome you inside today."));
  check("extractStreamText: utf16 above threshold", t1.encoding === "utf16" && t1.paragraphs.length === 1, t1);
  const t2 = extractStreamText(
    u16le("First paragraph line.\r\nSecond paragraph line.\r\n\r\nThird one here now.")
  );
  check(
    "extractStreamText: CRLF splits + empties dropped",
    t2.encoding === "utf16" &&
      JSON.stringify(t2.paragraphs) ===
        JSON.stringify(["First paragraph line.", "Second paragraph line.", "Third one here now."]),
    t2.paragraphs
  );
  const t3 = extractStreamText(u16le("Aaaa line one\nBbbb line two\rCccc line three"));
  check(
    "extractStreamText: LF and CR both split",
    JSON.stringify(t3.paragraphs) === JSON.stringify(["Aaaa line one", "Bbbb line two", "Cccc line three"]),
    t3.paragraphs
  );
  const t4 = extractStreamText(
    new Uint8Array([...noiseBytes(8), ...storyBytes(["Tabs\tand   spaces\t\tcollapse  neatly here in this story."], false, "")])
  );
  check(
    "extractStreamText: tabs/spaces collapse, tabs do not flip the sniff",
    t4.encoding === "ascii" && t4.paragraphs[0] === "Tabs and spaces collapse neatly here in this story.",
    t4
  );
  const t5 = extractStreamText(u16le("Tiny text"));
  check("extractStreamText: below MIN_STREAM_CHARS → none", t5.encoding === "none" && t5.paragraphs.length === 0, t5);
  const t6 = extractStreamText(new Uint8Array([...noiseBytes(6), ...u16le("Part one of the story\x00\x00Part two of the story")]));
  check(
    "extractStreamText: NUL gap splits runs into paragraphs",
    t6.encoding === "utf16" &&
      JSON.stringify(t6.paragraphs) === JSON.stringify(["Part one of the story", "Part two of the story"]),
    t6.paragraphs
  );
  const t7 = extractStreamText(
    new Uint8Array([
      ...Array.from("Cafe chars: caf", (c) => c.charCodeAt(0)),
      0xe9, // é — above the 7-bit ASCII scan
      ...Array.from(" main street number twelve with more words here", (c) => c.charCodeAt(0)),
    ])
  );
  check(
    "extractStreamText: 7-bit honesty — a high byte splits the ASCII run",
    t7.encoding === "ascii" &&
      JSON.stringify(t7.paragraphs) ===
        JSON.stringify(["Cafe chars: caf", " main street number twelve with more words here"]),
    t7.paragraphs
  );

  check("constants: MAX_PARAGRAPHS 800", MAX_PARAGRAPHS === 800);
  check("constants: MAX_TOTAL_CHARS 300000", MAX_TOTAL_CHARS === 300_000);
  check("constants: MAX_PARA_TEXT 10000", MAX_PARA_TEXT === 10_000);
  check(
    "constants: page sizes + margins + heading scale mirror render.ts",
    PAGE_SIZES.a4[0] === 595.28 &&
      PAGE_SIZES.a4[1] === 841.89 &&
      PAGE_SIZES.letter[0] === 612 &&
      PAGE_SIZES.letter[1] === 792 &&
      MARGIN_PT.normal === 56 &&
      MARGIN_PT.narrow === 28 &&
      HEADING_SCALE[0] === 1.9 &&
      HEADING_SCALE[1] === 1.5 &&
      HEADING_SCALE[2] === 1.22
  );
}

/* ------------------------------------------------------------------ */
console.log("── 2. REAL CFB fixture → parseCfb / extractStories / parsePub ──");
{
  const cfb = parseCfb(fixtureA);
  check("parseCfb: sectorSize 512 (v3)", cfb.sectorSize === 512, cfb.sectorSize);
  check("parseCfb: miniSectorSize 64", cfb.miniSectorSize === 64, cfb.miniSectorSize);
  check("parseCfb: root name", cfb.rootName === "Root Entry", cfb.rootName);
  check("parseCfb: 4 streams (storage entry excluded)", cfb.streams.length === 4, cfb.streams.length);
  check(
    "parseCfb: entry order + names",
    JSON.stringify(cfb.streams.map((s) => s.name)) ===
      JSON.stringify(["Contents", "EnglishStory", "HindiStory", "AsciiStory"]),
    cfb.streams.map((s) => s.name)
  );
  check(
    "parseCfb: directory ids in order (root 0, storage 1)",
    JSON.stringify(cfb.streams.map((s) => s.id)) === JSON.stringify([2, 3, 4, 5]),
    cfb.streams.map((s) => s.id)
  );
  check(
    "parseCfb: declared sizes match the payload lengths",
    cfb.streams.every((s, i) => s.size === [96, enStoryBytes.length, hiStoryBytes.length, asStoryBytes.length][i]),
    cfb.streams.map((s) => s.size)
  );
  check("parseCfb: all chains complete", cfb.streams.every((s) => s.complete) && cfb.streamFailures === 0, cfb.streamFailures);
  check(
    "parseCfb: both storage paths served (mini + normal)",
    JSON.stringify(cfb.streams.map((s) => s.path)) ===
      JSON.stringify(["mini", "normal", "mini", "normal"]),
    cfb.streams.map((s) => s.path)
  );
  check(
    "parseCfb: EnglishStory bytes exact through INTERLEAVED FAT chain",
    bytesEq(cfb.streams[1]!.data, enStoryBytes)
  );
  check("parseCfb: Contents bytes exact through the mini-FAT", bytesEq(cfb.streams[0]!.data, noiseBytes(96)));
  check(
    "parseCfb: HindiStory bytes exact (odd offset inside the mini stream)",
    bytesEq(cfb.streams[2]!.data, hiStoryBytes)
  );
  check("parseCfb: AsciiStory bytes exact", bytesEq(cfb.streams[3]!.data, asStoryBytes));

  const stories = extractStories(cfb);
  check("extractStories: scanned 4, used 3 (Contents is binary)", stories.streamsScanned === 4 && stories.streams.length === 3, {
    scanned: stories.streamsScanned,
    used: stories.streams.length,
  });
  check("extractStories: streamsFailed 0", stories.streamsFailed === 0);
  const en = stories.streams[0]!;
  const hi = stories.streams[1]!;
  const as = stories.streams[2]!;
  check("extractStories: encodings utf16/utf16/ascii", en.encoding === "utf16" && hi.encoding === "utf16" && as.encoding === "ascii", [en.encoding, hi.encoding, as.encoding]);
  check("extractStories: chain paths normal/mini/normal", en.path === "normal" && hi.path === "mini" && as.path === "normal", [en.path, hi.path, as.path]);
  check("extractStories: English paragraphs exact + ordered", JSON.stringify(en.paragraphs) === JSON.stringify(EN_PARAS), en.paragraphs.slice(0, 3));
  check("extractStories: Hindi paragraphs survive (hindiNorm NOT applied here)", JSON.stringify(hi.paragraphs) === JSON.stringify(HI_PARAS), hi.paragraphs);
  check(
    "extractStories: ASCII paragraphs — XML-hostile chars + tab collapse",
    JSON.stringify(as.paragraphs) ===
      JSON.stringify(AS_PARAS.map((p) => p.replace(/[\t ]+/g, " ").trim())),
    as.paragraphs.slice(0, 3)
  );

  const doc = parsePub(fixtureA);
  const expectedCount = EN_PARAS.length + HI_PARAS.length + AS_PARAS.length;
  check("parsePub: paragraph count across stories", doc.paraCount === expectedCount, { got: doc.paraCount, want: expectedCount });
  check("parsePub: streamsScanned/used mirror extractStories", doc.streamsScanned === 4 && doc.streamsUsed === 3 && doc.streamsFailed === 0);
  check("parsePub: first ALL-CAPS para upgraded to title (heading 0)", doc.paras[0]!.text === EN_PARAS[0] && doc.paras[0]!.heading === 0, doc.paras[0]);
  const freeEntry = doc.paras.find((p) => p.text === "Free Entry And Guided Tours")!;
  check("parsePub: Title-Case heading detected (heading 2)", freeEntry !== undefined && freeEntry.heading === 2);
  const bulletin = doc.paras.find((p) => p.text === "QUARTERLY BULLETIN 2026")!;
  check("parsePub: mid-document ALL-CAPS heading (heading 1, no title upgrade)", bulletin !== undefined && bulletin.heading === 1);
  const hiTitle = doc.paras.find((p) => p.text === HI_PARAS[0])!;
  check("parsePub: Devanagari heading without danda (heading 2)", hiTitle !== undefined && hiTitle.heading === 2);
  const hiNormed = doc.paras.find((p) => p.text === HI_PARAS_NORM[3])!;
  check("parsePub: hindiNorm strips quotes from Devanagari paragraphs", hiNormed !== undefined, HI_PARAS[3]);
  check(
    "parsePub: XML-hostile ASCII text intact",
    doc.paras.some((p) => p.text.includes("revenue & costs")) &&
      doc.paras.some((p) => p.text.includes("Q1 < Q2")) &&
      doc.paras.some((p) => p.text.includes('Quotes stay: "straight"')),
    doc.paras.find((p) => p.text.includes("revenue"))?.text
  );
  check(
    "parsePub: charCount = sum of kept paragraph lengths",
    doc.charCount === doc.paras.reduce((a, p) => a + p.text.length, 0)
  );
  check(
    "parsePub: wordCount = whitespace-split words",
    doc.wordCount === doc.paras.reduce((a, p) => a + p.text.split(/\s+/).filter(Boolean).length, 0)
  );
  check("parsePub: not truncated", doc.truncated === false);
  check("parsePub: needsNoto true (Devanagari present)", needsNoto(doc) === true);
}

/* ------------------------------------------------------------------ */
console.log("── 3. v4 CFB (4096-byte sectors, (N+1)×size offsets) ────");
{
  const V4_PARAS = padParas(
    [
      "VERSION FOUR SUPPORT",
      "Forty ninety-six byte sectors place the first sector of the file after the header padding, exactly as the specification orders, and the reader must honour that offset.",
      "Compound files written in version four keep the same directory, FAT and mini-FAT structures; only the sector geometry changes.",
    ],
    4200,
    true,
    (n) => `Version four filler paragraph ${n} keeps the story above the mini cutoff so the normal FAT path serves every byte of it.`
  );
  const v4Bytes = storyBytes(V4_PARAS, true);
  const v4 = buildCfb({ v4: true, streams: [{ name: "VersionFourStory", data: v4Bytes }] });
  const cfb = parseCfb(v4);
  check("v4: sectorSize 4096", cfb.sectorSize === 4096, cfb.sectorSize);
  check("v4: stream bytes exact (header pad honoured)", bytesEq(cfb.streams[0]!.data, v4Bytes));
  check("v4: chain complete", cfb.streams[0]!.complete && cfb.streamFailures === 0);
  const stories = extractStories(cfb);
  check("v4: story found as utf16", stories.streams.length === 1 && stories.streams[0]!.encoding === "utf16");
  check("v4: paragraphs exact", JSON.stringify(stories.streams[0]!.paragraphs) === JSON.stringify(V4_PARAS));
  const doc = parsePub(v4);
  check("v4: title heading", doc.paras[0]!.text === "VERSION FOUR SUPPORT" && doc.paras[0]!.heading === 0);
}

/* ------------------------------------------------------------------ */
console.log("── 4. Caps + honesty (paragraph/char/para-length, dedup) ──");
{
  const markerParas = Array.from(
    { length: 830 },
    (_, i) => `Marker paragraph ${i + 1} with a short numbered tail.`
  );
  const paraCap = parsePub(
    buildCfb({ streams: [{ name: "ManyParas", data: storyBytes(markerParas, true) }] })
  );
  check("cap: MAX_PARAGRAPHS enforced at 800", paraCap.paraCount === MAX_PARAGRAPHS, paraCap.paraCount);
  check("cap: truncated flag set", paraCap.truncated === true);
  check("cap: no duplicate paragraphs numbered below the cap", new Set(paraCap.paras.map((p) => p.text)).size === paraCap.paraCount);

  const charParas = Array.from({ length: 260 }, (_, i) => `w${i} `.repeat(0) + "x".repeat(1200));
  const charCap = parsePub(
    buildCfb({ streams: [{ name: "FatChars", data: storyBytes(charParas, false) }] })
  );
  check(
    "cap: MAX_TOTAL_CHARS stops the reflow",
    charCap.truncated === true && charCap.charCount <= MAX_TOTAL_CHARS + 1200 && charCap.paraCount < 260,
    { paras: charCap.paraCount, chars: charCap.charCount }
  );

  const longPara = parsePub(
    buildCfb({
      streams: [{ name: "OneLongPara", data: storyBytes(["y".repeat(12_000) + " end of the long paragraph."], false, "") }],
    })
  );
  check(
    "cap: MAX_PARA_TEXT slices a single 12,000-char paragraph",
    longPara.paras.length === 1 && longPara.paras[0]!.text.length === MAX_PARA_TEXT,
    longPara.paras[0]?.text.length
  );

  const dup = parsePub(
    buildCfb({
      streams: [
        {
          name: "Thumb",
          data: storyBytes(
            ["Duplicate line appears", "Duplicate line appears", "Duplicate line appears", "Final unique line here"],
            true
          ),
        },
      ],
    })
  );
  check(
    "honesty: consecutive identical story thumbnails collapse",
    dup.paraCount === 2 && dup.paras[0]!.text === "Duplicate line appears" && dup.paras[1]!.text === "Final unique line here",
    dup.paras.map((p) => p.text)
  );
}

/* ------------------------------------------------------------------ */
console.log("── 5. REAL renders (the worker's exact engine path) ─────");
{
  // EN-only fixture → pure WinAnsi → base-14 Helvetica, nothing embedded
  const enOnlyFixture = buildCfb({
    streams: [{ name: "EnglishStory", data: enStoryBytes }],
  });
  const enDoc = parsePub(enOnlyFixture);
  check("render EN: needsNoto false for pure-WinAnsi doc", needsNoto(enDoc) === false);
  const enOut = await renderDoc(enDoc, { pageSize: "a4", margin: "normal", baseSize: 10.5 });
  check("render EN: %PDF header + size", enOut.bytes[0] === 0x25 && enOut.bytes.length > 4000, enOut.bytes.length);
  check("render EN: report.pages matches pdf-lib reload", enOut.pages === enOut.reportPages, [enOut.pages, enOut.reportPages]);
  const enDump = objDump(enOut.reloaded);
  check("render EN: NO FontFile2 (base-14, tiny file)", !enDump.includes("FontFile2"));
  check("render EN: /Helvetica + /Helvetica-Bold present", enDump.includes("/Helvetica") && enDump.includes("/Helvetica-Bold"));
  check("render EN: no NaN/Infinity geometry", !inflatedText(enOut.bytes).includes("NaN") && !inflatedText(enOut.bytes).includes("Infinity"));
  const enSize = enOut.reloaded.getPage(0).getSize();
  check("render EN: A4 dims", Math.abs(enSize.width - 595.28) < 1 && Math.abs(enSize.height - 841.89) < 1, `${enSize.width}x${enSize.height}`);
  const enPages = await pdfjsPages(enOut.bytes);
  const enFlat = enPages.map((p) => p.map((i) => i.str).join("")).join("\n");
  for (const needle of [
    "WINTER OPEN DAY AT THE LIBRARY",
    "Free Entry And Guided Tours",
    "storytelling hour at eleven",
    "fourteenth of February",
  ]) {
    check(`render EN: pdf.js round-trip "${needle.slice(0, 24)}"`, enFlat.includes(needle));
  }
  checkMargins(enPages, 595.28, 56, "render EN");

  // Full mixed fixture → any Devanagari switches the whole PDF to Noto
  const fullDoc = parsePub(fixtureA);
  const fullOut = await renderDoc(fullDoc, { pageSize: "a4", margin: "normal", baseSize: 10.5 });
  check("render full: %PDF header + size", fullOut.bytes[0] === 0x25 && fullOut.bytes.length > 8000, fullOut.bytes.length);
  check("render full: report.pages matches reload", fullOut.pages === fullOut.reportPages);
  const fullDump = objDump(fullOut.reloaded);
  check("render full: Noto FontFile2 embedded", fullDump.includes("FontFile2"));
  check("render full: Type0 composite (Identity-H)", fullDump.includes("Identity-H"));
  check("render full: no Helvetica in the Noto doc", !fullDump.includes("/Helvetica"));
  check("render full: no NaN/Infinity geometry", !inflatedText(fullOut.bytes).includes("NaN") && !inflatedText(fullOut.bytes).includes("Infinity"));
  const fullPages = await pdfjsPages(fullOut.bytes);
  const fullFlat = fullPages.map((p) => p.map((i) => i.str).join("")).join("\n");
  const fullFlatNoSp = fullFlat.replace(/\s+/g, "");
  for (const needle of [
    "WINTER OPEN DAY AT THE LIBRARY",
    "Free Entry And Guided Tours",
    "revenue & costs",
    "Q1 < Q2",
    "QUARTERLY BULLETIN 2026",
    "यह रिपोर्ट आपके डिवाइस पर बनती है",
    "पुस्तकालय में शीतकालीन खुला दिवस",
  ]) {
    check(
      `render full: pdf.js round-trip "${needle.slice(0, 24)}"`,
      fullFlat.includes(needle) || fullFlatNoSp.includes(needle.replace(/\s+/g, ""))
    );
  }
  checkMargins(fullPages, 595.28, 56, "render full");

  // Letter + narrow variants
  const letterOut = await renderDoc(fullDoc, { pageSize: "letter", margin: "normal", baseSize: 10.5 });
  const ls = letterOut.reloaded.getPage(0).getSize();
  check("render letter: 612×792 dims", Math.abs(ls.width - 612) < 1 && Math.abs(ls.height - 792) < 1, `${ls.width}x${ls.height}`);
  const narrowOut = await renderDoc(fullDoc, { pageSize: "a4", margin: "narrow", baseSize: 12 });
  check("render narrow: renders clean", narrowOut.pages >= 1 && !inflatedText(narrowOut.bytes).includes("NaN"));

  // The bold-wrap vector: a heading that FITS in the regular face but
  // overflows in Helvetica-Bold must wrap — pre-fix it measured with the
  // regular face and drew one ~507pt line 23pt past the right margin.
  {
    const probe = await PDFDocument.create();
    const helv = probe.embedStandardFont(StandardFonts.Helvetica);
    const helvBold = probe.embedStandardFont(StandardFonts.HelveticaBold);
    const contentW = PAGE_SIZES.a4[0] - MARGIN_PT.normal * 2;
    let n = 1;
    while (helv.widthOfTextAtSize("A".repeat(n + 1), 27) <= contentW) n += 1;
    check("wrap vector: n fits the regular face at 27pt (heading 1 of base 18)", helv.widthOfTextAtSize("A".repeat(n), 27) <= contentW, n);
    check("wrap vector: n overflows the BOLD face (why the measuring face matters)", helvBold.widthOfTextAtSize("A".repeat(n), 27) > contentW, n);
    check("wrap vector: classifyHeading sees the caps line as a heading", classifyHeading("A".repeat(n)) === 1);
    const wdoc = await parsePub(
      buildCfb({
        streams: [
          { name: "S", data: storyBytes(["Intro line for the wrap vector.", "A".repeat(n)], true, "\n") },
        ],
      })
    );
    const wOut = await renderDoc(wdoc, { pageSize: "a4", margin: "normal", baseSize: 18 });
    const wPages = await pdfjsPages(wOut.bytes);
    const aLines = wPages.flat().filter((i) => /^A+$/.test(i.str)).map((i) => i.str);
    check("wrap vector: bold heading wrapped instead of overflowing", aLines.length >= 2, aLines);
    checkMargins(wPages, 595.28, 56, "wrap vector");
  }

  // Multi-page long publication + the honest ± page estimate
  const filler =
    "plenty of body text keeps flowing across the re-flowed page width and pushes the pagination logic through several page breaks. ";
  const longParas = Array.from(
    { length: 110 },
    (_, i) => `Long story paragraph ${i + 1} of the synthetic publication. ${filler}${filler}`
  );
  const longDoc = parsePub(
    buildCfb({ streams: [{ name: "LongStory", data: storyBytes(longParas, true) }] })
  );
  const est = estimatePages(longDoc, { pageSize: "a4", margin: "normal", baseSize: 10.5 });
  const longOut = await renderDoc(longDoc, { pageSize: "a4", margin: "normal", baseSize: 10.5 });
  check("render long: paginates to many pages", longOut.pages >= 5, longOut.pages);
  check("render long: report.pages matches reload", longOut.pages === longOut.reportPages);
  check(
    "render long: estimatePages is the honest ± estimate (within 2)",
    Math.abs(est - longOut.pages) <= 2,
    { estimate: est, actual: longOut.pages }
  );
  const longPages = await pdfjsPages(longOut.bytes);
  check(
    "render long: first + last paragraph survive the round-trip",
    longPages.map((p) => p.map((i) => i.str).join("")).join("\n").includes("Long story paragraph 1 of the synthetic publication.") &&
      longPages.map((p) => p.map((i) => i.str).join("")).join(" ").includes("Long story paragraph 110 of the synthetic publication")
  );
  checkMargins(longPages, 595.28, 56, "render long");
}

/* ------------------------------------------------------------------ */
console.log("── 6. Worker E2E (self-shimmed globalThis) ──────────────");
{
  const messages: WorkerResponse[] = [];
  const workerGlobal = globalThis as unknown as {
    postMessage: (msg: unknown) => void;
    onmessage: ((event: { data: WorkerRunRequest }) => void) | null;
    location: { href: string };
  };
  workerGlobal.postMessage = (msg: unknown): void => {
    messages.push(msg as WorkerResponse);
  };
  workerGlobal.location = { href: "http://localhost/" };
  (globalThis as unknown as Record<string, unknown>).self = workerGlobal;
  // the worker fetches the self-hosted Noto TTF from this origin — serve
  // the local file so the exact loadStampFonts path runs headless
  globalThis.fetch = (async (): Promise<Response> =>
    new Response(notoBytes)) as typeof fetch;
  await import("../tools/publisher-to-pdf/worker");
  check("worker: module loaded, onmessage registered", typeof workerGlobal.onmessage === "function");

  const drive = async (
    runId: number,
    options: Record<string, unknown>,
    files: File[]
  ): Promise<WorkerResponse> => {
    const before = messages.length;
    workerGlobal.onmessage!({
      data: { type: "run", runId, toolId: "publisher-to-pdf", options, files } as WorkerRunRequest,
    });
    const done = await (async (): Promise<boolean> => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (
          messages
            .slice(before)
            .some((m) => m.runId === runId && (m.type === "result" || m.type === "error"))
        ) {
          return true;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      return false;
    })();
    if (!done) throw new Error(`worker run ${runId} did not finish`);
    return messages
      .slice(before)
      .find((m) => m.runId === runId && (m.type === "result" || m.type === "error"))!;
  };

  // EN-only run — no font fetch at all
  const enFile = new File(
    [buildCfb({ streams: [{ name: "EnglishStory", data: enStoryBytes }] })],
    "Newsletter.pub"
  );
  const enRes = await drive(101, { pageSize: "a4", margin: "normal", fontSize: 10.5, fileWord: "document" }, [enFile]);
  check("worker EN: result", enRes.type === "result", enRes);
  if (enRes.type === "result") {
    const out = enRes.outputs[0]!;
    check("worker EN: output name Newsletter.pdf", out.name === "Newsletter.pdf", out.name);
    check("worker EN: pdf mime", out.mime === "application/pdf");
    const outBytes = new Uint8Array(await out.blob.arrayBuffer());
    check("worker EN: %PDF magic", outBytes[0] === 0x25 && outBytes[1] === 0x50);
    const reloaded = await PDFDocument.load(outBytes);
    check("worker EN: page count matches detail", reloaded.getPageCount() === enRes.detail?.pages, [reloaded.getPageCount(), enRes.detail?.pages]);
    check("worker EN: no FontFile2 (Helvetica path)", !objDump(reloaded).includes("FontFile2"));
    check("worker EN: producer MyCloudy", reloaded.getProducer() === "MyCloudy");
    const parseAgain = parsePub(new Uint8Array(await enFile.arrayBuffer()));
    check(
      "worker EN: detail paragraphs/chars/streams mirror the model",
      enRes.detail?.paragraphs === parseAgain.paraCount &&
        enRes.detail?.chars === parseAgain.charCount &&
        enRes.detail?.streams === parseAgain.streamsUsed &&
        enRes.detail?.streamsFailed === 0,
      { detail: enRes.detail, model: parseAgain }
    );
  }
  const pcts = messages.filter((m) => m.type === "progress").map((m) => (m as { pct: number }).pct);
  check("worker EN: progress pcts 20/45/85 posted", pcts.includes(20) && pcts.includes(45) && pcts.includes(85), pcts);

  // Full mixed run — the fetch-shimmed Noto path
  const fullFile = new File([fixtureA], "Mela Patrika.pub");
  const fullRes = await drive(102, { pageSize: "a4", margin: "narrow", fontSize: 12, fileWord: "दस्तावेज़" }, [fullFile]);
  check("worker full: result", fullRes.type === "result", fullRes);
  if (fullRes.type === "result") {
    const out = fullRes.outputs[0]!;
    check("worker full: output name", out.name === "Mela Patrika.pdf", out.name);
    const outBytes = new Uint8Array(await out.blob.arrayBuffer());
    const reloaded = await PDFDocument.load(outBytes);
    check("worker full: Noto FontFile2 embedded (fetch shim served the TTF)", objDump(reloaded).includes("FontFile2"));
    check("worker full: detail streams = 3", fullRes.detail?.streams === 3, fullRes.detail);
    const pageBytes = await pdfjsPages(outBytes);
    const flat = pageBytes.map((p) => p.map((i) => i.str).join("")).join("\n");
    check("worker full: Hindi text in the output", flat.includes("यह रिपोर्ट आपके डिवाइस पर बनती है") || flat.replace(/\s+/g, "").includes("यहरिपोर्टआपकेडिवाइसपरबनतीहै"));
  }

  // output name sanitization (the cleanName fix, end to end)
  const hostileFile = new File([fixtureA], "Report/2026:Q1.pub");
  const hostileRes = await drive(103, { pageSize: "a4", margin: "normal", fontSize: 10.5, fileWord: "document" }, [hostileFile]);
  check("worker: result for hostile name", hostileRes.type === "result");
  if (hostileRes.type === "result") {
    check(
      "worker: path separators sanitized in the download name",
      hostileRes.outputs[0]!.name === "Report_2026_Q1.pdf",
      hostileRes.outputs[0]!.name
    );
  }

  // rejection runs
  const noFileRes = await drive(201, {}, []);
  check("worker: no file → pub.errNoFile", noFileRes.type === "error" && noFileRes.code === "pub.errNoFile", noFileRes);

  const garbageRes = await drive(202, {}, [new File([noiseBytes(400)], "garbage.pub")]);
  check("worker: garbage bytes → pub.errNotPub", garbageRes.type === "error" && garbageRes.code === "pub.errNotPub", garbageRes);

  const noTextCfb = buildCfb({
    streams: [
      { name: "BinaryA", data: noiseBytes(4200) },
      { name: "BinaryB", data: noiseBytes(200) },
    ],
  });
  const noTextRes = await drive(203, {}, [new File([noTextCfb], "notext.pub")]);
  check("worker: valid container, no text → pub.errNoText", noTextRes.type === "error" && noTextRes.code === "pub.errNoText", noTextRes);

  const brokenStart = buildCfb({
    streams: [{ name: "BrokenStory", data: storyBytes(["This story will never be reached because the directory start sector is out of range and the chain is empty."], true) }],
    breakStart: "BrokenStory",
  });
  const brokenRes = await drive(204, {}, [new File([brokenStart], "broken.pub")]);
  check("worker: broken chain, nothing salvaged → pub.errStreamRead", brokenRes.type === "error" && brokenRes.code === "pub.errStreamRead", brokenRes);
}

/* ------------------------------------------------------------------ */
console.log("── 7. Rejection vectors (honest taxonomy) ───────────────");
{
  check("reject: random garbage → errNotPub", pubCode(noiseBytes(400)) === "errNotPub", pubCode(noiseBytes(400)));
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...noiseBytes(200)]);
  check("reject: ZIP signature → errZipFile", pubCode(zip) === "errZipFile");
  const texty = new Uint8Array(
    Array.from(
      "This is clearly a plain text file that somebody renamed to .pub for no good reason at all.",
      (c) => c.charCodeAt(0)
    )
  );
  check("reject: plain text → errTextFile", pubCode(texty) === "errTextFile");

  const oleGarbage = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...noiseBytes(692)]);
  check("reject: OLE magic but no sectors → errCorrupt", pubCode(oleGarbage) === "errCorrupt", pubCode(oleGarbage));
  const oleShort = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...noiseBytes(292)]);
  check("reject: OLE magic but < 512 bytes → errNotPub", pubCode(oleShort) === "errNotPub");

  const truncated = fixtureA.slice(0, 512 + 512); // header + directory sector 0 only
  check("reject: truncated mid-file (FAT sector gone) → errCorrupt", pubCode(truncated) === "errCorrupt", pubCode(truncated));

  const badOrder = fixtureA.slice();
  badOrder[0x1c] = 0x00;
  badOrder[0x1d] = 0x00; // byte order not 0xFFFE
  check("reject: byte-order tamper → errCorrupt", pubCode(badOrder) === "errCorrupt");

  const badShift = fixtureA.slice();
  badShift[0x1e] = 0x08; // sector shift 8 ≠ 9 for v3
  check("reject: sector-shift tamper → errCorrupt", pubCode(badShift) === "errCorrupt");

  // a container whose streams are all unreadable binary — an encrypted
  // OLE payload stand-in. The documented honest contract: the container
  // opens, no readable story text is found → errNoText (never a guess).
  const encrypted = buildCfb({
    streams: [{ name: "EncryptedPackage", data: noiseBytes(4300) }],
  });
  const encDoc = parsePub(encrypted);
  check(
    "reject: encrypted-looking package → honest errNoText contract (paras 0, chains fine)",
    encDoc.paraCount === 0 && encDoc.streamsFailed === 0 && encDoc.streamsScanned === 1,
    { paras: encDoc.paraCount, failed: encDoc.streamsFailed }
  );

  // partially broken chain: 1 readable sector, then FREE — honest partial
  const partialStory = storyBytes(
    [
      "First paragraph lives in the first sector and survives the broken chain.",
      "Second paragraph is lost with the rest of the chain after the cut.",
      "Third paragraph is lost as well, but the tool reports the failure.",
    ],
    true
  ).subarray(0, 5000); // ≥ 4096 → normal FAT path, 10 sectors
  const partialCfb = buildCfb({
    streams: [{ name: "PartialStory", data: partialStory }],
    breakChain: "PartialStory",
  });
  const partialDoc = parsePub(partialCfb);
  check(
    "honesty: partially-broken chain salvages the readable prefix",
    partialDoc.streamsFailed === 1 && partialDoc.paraCount >= 1 && partialDoc.paras[0]!.text.includes("First paragraph lives"),
    { failed: partialDoc.streamsFailed, paras: partialDoc.paraCount, first: partialDoc.paras[0]?.text }
  );
  const partialStories = extractStories(parseCfb(partialCfb));
  check("honesty: the broken stream still counts as a text story (partial)", partialStories.streams.length === 1);

  // empty input
  check("reject: empty bytes → errNotPub", pubCode(new Uint8Array(0)) === "errNotPub");
}

/* ------------------------------------------------------------------ */
console.log("── 8. Wiring + i18n parity ───────────────────────────────");
{
  const registry = readFileSync("src/lib/tools/registry.ts", "utf8");
  const defStart = registry.indexOf('id: "publisher-to-pdf"');
  const defBlock = defStart >= 0 ? registry.slice(defStart, registry.indexOf("}),", defStart)) : "";
  check("registry: def exists", defStart >= 0);
  check("registry: enabled: true", defBlock.includes("enabled: true"));
  check("registry: mode D (device only)", defBlock.includes('mode: "D"'));
  check("registry: accepts office", defBlock.includes('accepts: "office"'));
  check(
    "registry: honest description (text salvage, layout NOT carried over)",
    defBlock.includes("honest text rescue") || defBlock.includes("not carried over")
  );
  check("registry: Hindi name present", defBlock.includes("पब्लिशर से पीडीएफ़"));

  const configs = readFileSync("src/lib/tools/configs.ts", "utf8");
  check("configs.ts: import present", configs.includes("tools/publisher-to-pdf/config"));
  check("configs.ts: TOOL_CONFIGS entry present", configs.includes("[publisherToPdf.toolId]: publisherToPdf"));

  const surfaces = readFileSync("src/lib/tools/surfaces.tsx", "utf8");
  check("surfaces.tsx: import present", surfaces.includes("tools/publisher-to-pdf/surface"));
  check("surfaces.tsx: TOOL_SURFACES entry present", surfaces.includes('"publisher-to-pdf": PublisherToPdfSurface'));

  const configSrc = readFileSync("tools/publisher-to-pdf/config.ts", "utf8");
  check("config: toolId", configSrc.includes('toolId: "publisher-to-pdf"'));
  check("config: spawns ./worker.ts", configSrc.includes("./worker.ts"));
  check("config: outputKind pdf", configSrc.includes('outputKind: "pdf"'));
  check("config: one file at a time", configSrc.includes("maxFiles: 1") && configSrc.includes("minFiles: 0"));
  check("config: howKeys are pub.*", configSrc.includes('"pub.how1"'));
  check("config: chain view-pdf + compress-pdf", configSrc.includes('"view-pdf"') && configSrc.includes('"compress-pdf"'));
  for (const id of ["pageSize", "margin", "fontSize"]) {
    check(`config: option "${id}" declared`, configSrc.includes(`id: "${id}"`));
  }

  const surfaceSrc = readFileSync("tools/publisher-to-pdf/surface.tsx", "utf8");
  check("surface: spawns ./worker.ts", surfaceSrc.includes('new URL("./worker.ts", import.meta.url)'));
  check("surface: accepts .pub uploads", surfaceSrc.includes('accept=".pub'));
  check("surface: sniffs the OLE2 magic itself", surfaceSrc.includes("isOle2File"));
  check("surface: posts toolId", surfaceSrc.includes('toolId: "publisher-to-pdf"'));
  check(
    "surface: honest verdict mirrors the worker (errStreamRead when chains broke)",
    surfaceSrc.includes('parsedDoc.streamsFailed > 0')
  );

  const workerSrc = readFileSync("tools/publisher-to-pdf/worker.ts", "utf8");
  check("worker: maps PubError codes onto pub.*", workerSrc.includes("instanceof PubError") && workerSrc.includes("`pub.${"));
  check("worker: Producer/Creator MyCloudy", workerSrc.includes('"MyCloudy"'));
  for (const id of ["pageSize", "margin", "fontSize", "fileWord"]) {
    check(`worker: reads option "${id}"`, workerSrc.includes(`options.${id}`));
  }

  // i18n — tool catalog parity + catalog merge fidelity
  const toolI18n = JSON.parse(
    readFileSync("tools/publisher-to-pdf/i18n.json", "utf8")
  ) as { en: { pub: Record<string, string> }; hi: { pub: Record<string, string> } };
  const enKeys = Object.keys(toolI18n.en.pub).sort();
  const hiKeys = Object.keys(toolI18n.hi.pub).sort();
  check("i18n: tool en/hi key parity", JSON.stringify(enKeys) === JSON.stringify(hiKeys), { en: enKeys.length, hi: hiKeys.length });
  check("i18n: pub namespace has the 47 leaves", enKeys.length === 47, enKeys.length);

  const catEn = JSON.parse(readFileSync("src/i18n/en.json", "utf8")) as {
    pub: Record<string, string>;
    conv: Record<string, string>;
    tool: Record<string, string>;
  };
  const catHi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8")) as typeof catEn;
  let merged = 0;
  for (const k of enKeys) {
    if (k in catEn.pub && k in catHi.pub && catEn.pub[k] === toolI18n.en.pub[k]) merged += 1;
  }
  check("i18n: every tool key merged verbatim into src/i18n/en.json + hi.json", merged === enKeys.length, `${merged}/${enKeys.length}`);

  const sources = [
    "tools/publisher-to-pdf/surface.tsx",
    "tools/publisher-to-pdf/config.ts",
    "tools/publisher-to-pdf/worker.ts",
    "tools/publisher-to-pdf/model.ts",
  ]
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  const referenced = new Set<string>();
  for (const m of sources.matchAll(/pub\.[A-Za-z0-9]+/g)) referenced.add(m[0]);
  for (const key of referenced) {
    const short = key.slice("pub.".length);
    check(`i18n: "${key}" present in en + hi`, short in toolI18n.en.pub && short in toolI18n.hi.pub);
  }

  // every error code the model + worker can emit resolves in BOTH catalogs
  for (const code of [
    "errNotPub",
    "errZipFile",
    "errTextFile",
    "errCorrupt",
    "errNoText",
    "errStreamRead",
    "errFont",
    "errNoFile",
  ]) {
    check(
      `i18n: error key pub.${code} resolves in both catalogs`,
      code in catEn.pub && code in catHi.pub
    );
  }
  check("i18n: conv.reading exists (surface uses it)", "reading" in catEn.conv && "reading" in catHi.conv);
  check(
    "i18n: tool.errorTitle/errorGeneric exist (surface fallback)",
    "errorTitle" in catEn.tool && "errorGeneric" in catEn.tool && "errorTitle" in catHi.tool && "errorGeneric" in catHi.tool
  );
}

console.log(
  `\npublisher-to-pdf smoke: ${pass} passed, ${fail} failed` +
  (fail ? `\n  ${failures.join("\n  ")}` : "")
);
process.exit(fail === 0 ? 0 : 1);
