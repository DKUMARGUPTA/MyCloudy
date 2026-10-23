/**
 * Smoke: request-signature (RB6-FIN-b — the 92nd tool, security) — the honest
 * on-device "prepare & send for signature" pack maker.
 *
 * House conventions (smoke-xml-invoice-to-pdf / smoke-create-fillable-pdf-form
 * / smoke-annotate-pdf): relative imports WITHOUT .ts, regenerator-runtime
 * first (pdf.js), plain check() helper, process.exit(0) at the end.
 *
 *  1. Model vectors — the WinAnsi-vs-Noto rule (isWinAnsiChar /
 *     needsNotoChar / needsNoto / sanitizeText / splitTextRuns), display
 *     geometry (displaySize + displayRectToUser hand vectors for /Rotate
 *     0/90/180/270 with MediaBox origins + the forward-map round-trip lock),
 *     spotDisplayRect clamping, isValidEmail, formatDueDate, fill(),
 *     parseRequestRun defensive coercion + tamper vectors, wrapChars,
 *     buildRequestText, mailtoHref, safeBaseName, sigFieldNames.
 *  2. REAL E2E through the worker's exact render path (self-shimmed
 *     globalThis + fetch serving the self-hosted Noto TTF — the
 *     xml-invoice-to-pdf recipe): a real 2-page pdf-lib input (page 2
 *     rotated 90°) + a request with 2 spots on different pages → the
 *     prepared PDF is reloaded and the OBJECT TABLE is parsed raw
 *     (enumerateIndirectObjects): real AcroForm /FT /Sig field dicts with
 *     the right /T names, widget kids with /Subtype /Widget + exact
 *     hand-computed /Rects on the RIGHT pages (rotation math included),
 *     /Parent + /P links + the Print flag; the VISIBLE dashed-box ink is
 *     verified inside the node:zlib-inflated content streams ([4 3] 0 d
 *     dash, amber stroke, hex-token needles for "1. Sign here" /
 *     "For: <recipient>" / "Due: <date>"), recipient + due date + reason
 *     needles, body text survives, no NaN coords anywhere; the request
 *     note PDF + plain-text note content; progress pcts + honest stages.
 *  3. Hindi request (Devanagari details + labels) → Noto FontFile2 +
 *     Identity-H Type0 font present in BOTH produced PDFs
 *     (enumerateIndirectObjects route) + pdf.js-extracted Devanagari with
 *     stable-substring honesty (visual order, the probe-deva precedent).
 *  4. sigFields OFF → no /Sig anywhere, no widgets, boxes still drawn.
 *  5. Flatten-first ON with a FILLED form-field input → the field value is
 *     burned into the page content stream (hex needle in the inflated
 *     stream), the original widget + AcroForm field are GONE, the sig
 *     field is added on top (house flatten semantics: what the model
 *     actually does — scope "forms-only", FlattenNothingError tolerated).
 *  6. Pack assembly — fflate zipSync output verified via a node:zlib
 *     CENTRAL-DIRECTORY walk (EOCD → CD entries → local headers →
 *     inflateRawSync): both entries (prepared PDF + request note) inflate
 *     correctly, entry names right, both are %PDF.
 *  7. Rejection vectors — garbage bytes → tool.errorCorrupt, no file →
 *     tool.errorGeneric, zero spots → the model's actual honest behavior
 *     (reqsig.errNoSpots), encrypted (@cantoo AES-256) →
 *     tool.errorEncrypted.
 *  8. i18n + wiring — tool catalog en/hi parity, NOTE_KEYS all present in
 *     both catalogs, every reqsig.* referenced from surface/config/model
 *     resolves, worker error codes have leaves, config/registry/surfaces
 *     wiring strings (enabled, mode D, accepts pdf).
 *
 * Run: bun scripts/smoke-request-signature.ts
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";
import { inflateSync, inflateRawSync } from "node:zlib";

import {
  PDFArray,
  PDFDocument,
  PDFDict,
  PDFName,
  PDFRawStream,
  StandardFonts,
} from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { hasExistingSignature } from "../tools/digital-signature/model";
import {
  MAX_SPOTS,
  NOTE_KEYS,
  NOTE_LABELS_EN,
  buildRequestText,
  clamp01,
  displayRectToUser,
  displaySize,
  fill,
  formatDueDate,
  isWinAnsiChar,
  isValidEmail,
  labelOf,
  mailtoHref,
  needsNoto,
  needsNotoChar,
  parseRequestRun,
  safeBaseName,
  sanitizeText,
  sigFieldNames,
  splitTextRuns,
  spotDisplayRect,
  wrapChars,
} from "../tools/request-signature/model";
import type { RequestPackRun, SignatureSpot } from "../tools/request-signature/types";
import type {
  WorkerRunRequest,
  WorkerResponse,
} from "../src/lib/workers/protocol";
import toolI18n from "../tools/request-signature/i18n.json";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.error(
      `  ✗ FAIL ${label}`,
      actual !== undefined ? JSON.stringify(actual).slice(0, 300) : ""
    );
  }
}

const near = (a: number, b: number, eps = 0.01): boolean =>
  Math.abs(a - b) <= eps;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** The house 3-way text needle (RB1 lesson: pdf-lib emits text as HEX
 *  TOKENS <...> Tj — match literal, exact token, or bare hex substring). */
function hasText(latin1: string, needle: string): boolean {
  if (latin1.includes(needle)) return true;
  const hex = Buffer.from(needle, "latin1").toString("hex").toUpperCase();
  if (hex.length < 8) return latin1.includes(needle);
  if (latin1.includes(`<${hex}>`)) return true;
  return latin1.toUpperCase().includes(hex);
}

/** All content streams of a reloaded page, inflated via node:zlib. */
function pageContentLatin1(doc: PDFDocument, pageIndex: number): string {
  const page = doc.getPage(pageIndex);
  const contents = page.node.Contents();
  const streams: PDFRawStream[] = [];
  const push = (s: unknown): void => {
    if (s instanceof PDFRawStream) streams.push(s);
  };
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i += 1) push(contents.lookup(i));
  } else push(contents);
  let out = "";
  for (const s of streams) {
    const filter = s.dict.get(PDFName.of("Filter"));
    const bytes = s.getContents();
    const inflated =
      filter !== undefined && filter.toString() === "/FlateDecode"
        ? inflateSync(bytes)
        : bytes;
    out += Buffer.from(inflated).toString("latin1");
  }
  return out;
}

function objDump(doc: PDFDocument): string {
  return [...doc.context.enumerateIndirectObjects()]
    .map(([, o]) => o.toString())
    .join("\n");
}

interface ItemLike {
  str: string;
}

async function pdfjsFlatText(bytes: Uint8Array): Promise<string> {
  // pdf.js rejects Buffer instances — always hand it a plain Uint8Array copy
  // (the typed-array constructor copies element-wise, Buffer included).
  const data = new Uint8Array(bytes);
  const task = getDocument({ data, useSystemFonts: true });
  const pdf = await task.promise;
  const parts: string[] = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    try {
      const content = await page.getTextContent();
      parts.push(
        (content.items as ItemLike[]).map((i) => i.str).join(" ")
      );
    } finally {
      page.cleanup();
    }
  }
  await pdf.cleanup();
  await task.destroy();
  return parts.join("\n");
}

/** A minimal request run payload (surface serialization shape). */
function makeRequest(overrides: {
  locale?: "en" | "hi";
  details?: Record<string, string>;
  spots?: SignatureSpot[];
  labels?: Record<string, string>;
}): string {
  return JSON.stringify({
    locale: overrides.locale ?? "en",
    details: {
      recipientName: "",
      senderName: "",
      recipientEmail: "",
      subject: "",
      message: "",
      dueDate: "",
      ...overrides.details,
    },
    spots: overrides.spots ?? [],
    labels: overrides.labels ?? {},
  });
}

/* ================================================================== */
console.log("── 1. model vectors ────────────────────────────────────");
/* ================================================================== */
{
  // ---- the WinAnsi-vs-Noto rule -------------------------------------
  check("isWinAnsiChar: ASCII range", isWinAnsiChar(0x41) && isWinAnsiChar(0x20) && isWinAnsiChar(0x7e));
  check("isWinAnsiChar: latin-1 range + CP1252 punct", isWinAnsiChar(0xe9) && isWinAnsiChar(0x20ac) && isWinAnsiChar(0x2014));
  check("isWinAnsiChar: rejects DEL + Devanagari + CJK", !isWinAnsiChar(0x7f) && !isWinAnsiChar(0x0915) && !isWinAnsiChar(0x4e2d));
  check("needsNotoChar: Devanagari block + rupee + joiners", needsNotoChar(0x0915) && needsNotoChar(0x20b9) && needsNotoChar(0x200c) && needsNotoChar(0x200d));
  check("needsNotoChar: rejects Latin", !needsNotoChar(0x41) && !needsNotoChar(0xe9));
  check("needsNoto: mixed string flips", needsNoto("To: प्रिया") && !needsNoto("To: Priya"));
  check("needsNoto: rupee sign flips", needsNoto("Total ₹ 500") && !needsNoto("Total Rs. 500"));

  check(
    "sanitizeText: WinAnsi survives, Devanagari only with allowNoto",
    // "प्रिया" is SIX code points (प ् र ि य ा) → six "?" on the
    // WinAnsi-only path; "日本語" is three → three "?".
    sanitizeText("Priya é — ok", false) === "Priya é — ok" &&
      sanitizeText("प्रिया", true) === "प्रिया" &&
      sanitizeText("प्रिया", false) === "??????" &&
      sanitizeText("日本語", true) === "???"
  );
  check("sanitizeText: whitespace family survives both paths", sanitizeText("a\nb\tc  d", false) === "a\nb\tc  d");

  const runs = splitTextRuns("To: प्रिया Sharma कृपया");
  check(
    "splitTextRuns: 4 runs alternating faces",
    runs.length === 4 &&
      runs[0]!.text === "To: " && runs[0]!.deva === false &&
      runs[1]!.text === "प्रिया" && runs[1]!.deva === true &&
      runs[2]!.text === " Sharma " && runs[2]!.deva === false &&
      runs[3]!.text === "कृपया" && runs[3]!.deva === true,
    runs
  );
  check("splitTextRuns: empty string → no runs", splitTextRuns("").length === 0);

  // ---- display geometry -----------------------------------------------
  check(
    "displaySize: rotation swaps axes on 90/270 only",
    displaySize(0, 612, 792).w === 612 &&
      displaySize(180, 612, 792).w === 612 &&
      displaySize(90, 612, 792).w === 792 &&
      displaySize(270, 612, 792).h === 612
  );
  // 360-wrap + negatives normalize to 0
  check(
    "displayRectToUser: angle normalization (360 → 0)",
    JSON.stringify(displayRectToUser({ left: 10, top: 20, w: 30, h: 40 }, 360, 500, 700)) ===
      JSON.stringify(displayRectToUser({ left: 10, top: 20, w: 30, h: 40 }, 0, 500, 700))
  );

  // hand vectors (no origin): A4, box left=100 top=200 w=170 h=46
  const r0 = displayRectToUser({ left: 100, top: 200, w: 170, h: 46 }, 0, 595.28, 841.89);
  check(
    "displayRectToUser: /Rotate 0 → y flips, x keeps",
    near(r0.x, 100) && near(r0.y, 841.89 - 200 - 46) && r0.w === 170 && r0.h === 46,
    r0
  );
  const r90 = displayRectToUser({ left: 100, top: 200, w: 170, h: 46 }, 90, 595.28, 841.89);
  check(
    "displayRectToUser: /Rotate 90 → x from top, y from left, axes swap",
    near(r90.x, 200) && near(r90.y, 100) && r90.w === 46 && r90.h === 170,
    r90
  );
  const r180 = displayRectToUser({ left: 100, top: 200, w: 170, h: 46 }, 180, 595.28, 841.89);
  check(
    "displayRectToUser: /Rotate 180 → x mirrors, y keeps",
    near(r180.x, 595.28 - 100 - 170) && near(r180.y, 200) && r180.w === 170 && r180.h === 46,
    r180
  );
  const r270 = displayRectToUser({ left: 100, top: 200, w: 170, h: 46 }, 270, 595.28, 841.89);
  check(
    "displayRectToUser: /Rotate 270 → both mirror + axes swap",
    near(r270.x, 595.28 - 200 - 46) && near(r270.y, 841.89 - 100 - 170) && r270.w === 46 && r270.h === 170,
    r270
  );
  // origin offsets (pdf.js anchors display (0,0) at the MediaBox origin)
  const ro = displayRectToUser({ left: 100, top: 200, w: 170, h: 46 }, 0, 400, 700, 10, 20);
  check(
    "displayRectToUser: MediaBox origin shifts applied",
    near(ro.x, 110) && near(ro.y, 20 + 700 - 200 - 46),
    ro
  );
  const ro90 = displayRectToUser({ left: 100, top: 200, w: 170, h: 46 }, 90, 400, 700, 10, 20);
  check(
    "displayRectToUser: /Rotate 90 with origin",
    near(ro90.x, 210) && near(ro90.y, 120),
    ro90
  );

  // round-trip lock: forward pdf.js viewport maps (per rotation + origin,
  // straight from the pdf.js PageViewport switch: rotate 0 → (1,0,0,-1),
  // 90 → (0,1,1,0), 180 → (-1,0,0,1), 270 → (0,-1,-1,0), offsets included),
  // then displayRectToUser must be the exact inverse.
  const forward = (
    u: { x: number; y: number; w: number; h: number },
    rotation: number,
    userW: number,
    userH: number,
    ox: number,
    oy: number
  ): { left: number; top: number; w: number; h: number } => {
    switch (rotation) {
      case 90:
        return { left: u.y - oy, top: u.x - ox, w: u.h, h: u.w };
      case 180:
        return { left: ox + userW - u.x - u.w, top: u.y - oy, w: u.w, h: u.h };
      case 270:
        return { left: oy + userH - u.y - u.h, top: ox + userW - u.x - u.w, w: u.h, h: u.w };
      default:
        return { left: u.x - ox, top: oy + userH - u.y - u.h, w: u.w, h: u.h };
    }
  };
  let roundTripOk = true;
  for (const rotation of [0, 90, 180, 270]) {
    for (const [ox, oy] of [[0, 0], [10, 20]]) {
      const user = { x: 123.4, y: 456.7, w: 170, h: 46 };
      const disp = forward(user, rotation, 595.28, 841.89, ox, oy);
      const back = displayRectToUser(disp, rotation, 595.28, 841.89, ox, oy);
      if (
        !near(back.x, user.x) || !near(back.y, user.y) ||
        back.w !== user.w || back.h !== user.h
      ) {
        roundTripOk = false;
      }
    }
  }
  check("displayRectToUser: forward-map round-trip locked for all rotations + origins", roundTripOk);

  // ---- spotDisplayRect --------------------------------------------------
  const mid = spotDisplayRect({ page: 0, x: 0.5, y: 0.5 }, 595.28, 841.89);
  check(
    "spotDisplayRect: centred box, default size",
    near(mid.w, 170) && near(mid.h, 46) &&
      near(mid.left, 595.28 / 2 - 85) && near(mid.top, 841.89 / 2 - 23),
    mid
  );
  const corner = spotDisplayRect({ page: 0, x: 0.001, y: 0.001 }, 595.28, 841.89);
  check(
    "spotDisplayRect: near-corner spot nudged inside the pad",
    near(corner.left, 4) && near(corner.top, 4),
    corner
  );
  const far = spotDisplayRect({ page: 0, x: 0.999, y: 0.999 }, 595.28, 841.89);
  check(
    "spotDisplayRect: far-corner spot nudged inside the pad",
    near(far.left, 595.28 - 170 - 4) && near(far.top, 841.89 - 46 - 4),
    far
  );
  const tiny = spotDisplayRect({ page: 0, x: 0.5, y: 0.5 }, 30, 40);
  check(
    "spotDisplayRect: tiny page shrinks the box, stays finite",
    tiny.w <= 30 && tiny.h <= 40 &&
      Number.isFinite(tiny.left) && Number.isFinite(tiny.top) &&
      tiny.left + tiny.w <= 30 && tiny.top + tiny.h <= 40,
    tiny
  );

  // ---- detail helpers -----------------------------------------------------
  check(
    "isValidEmail: vectors",
    isValidEmail("priya@example.com") && isValidEmail("  a.b@co.in ") &&
      !isValidEmail("no-at-sign") && !isValidEmail("a@b") && !isValidEmail("a b@c.com") && !isValidEmail("")
  );
  check(
    "formatDueDate: ISO → dd/mm/yyyy; other input passes through",
    formatDueDate("2026-03-14") === "14/03/2026" &&
      formatDueDate("March 14") === "March 14" &&
      formatDueDate("") === "" &&
      formatDueDate(" 2026-01-31 ") === "31/01/2026"
  );
  check(
    "fill: known keys replaced, unknown kept, multiple hits",
    fill("Spot {n}: page {p} ({x})", { n: "1", p: "2" }) === "Spot 1: page 2 ({x})" &&
      fill("no vars", {}) === "no vars"
  );

  // ---- parseRequestRun -----------------------------------------------------
  const raw = {
    locale: "hi",
    details: {
      recipientName: "  प्रिया शर्मा  ",
      senderName: 42,
      recipientEmail: "priya@example.com",
      subject: "Hi\r\nThere",
      message: "line1\r\nline2",
      dueDate: "2026-03-14",
    },
    spots: [
      { page: 0, x: 0.2, y: 0.3 },
      { page: 0, x: 0.2, y: 0.3 }, // duplicate → deduped
      { page: 99, x: 0.5, y: 0.5 }, // out of range → clamped to last page
      { page: "0.7", x: 0.1, y: 0.1 }, // numeric-string page rounds
      { page: 1, x: Number.NaN, y: 0.5 }, // NaN → dropped
      "junk", // non-object → dropped
      null,
    ],
    labels: {
      "reqsig.title": "हस्ताक्षर अनुरोध",
      "bad.key": "dropped (bad prefix)",
      "reqsig.nope": 99,
      [`reqsig.${"x".repeat(300)}`]: "dropped (regex cap)",
    },
  };
  const parsed = parseRequestRun(raw, 2);
  check("parseRequestRun: ok", parsed.ok === true);
  if (parsed.ok) {
    const run = parsed.run;
    check(
      "parseRequestRun: details coerced + trimmed + CRLF collapsed",
      run.details.recipientName === "प्रिया शर्मा" &&
        run.details.senderName === "" &&
        run.details.subject === "Hi\nThere" &&
        run.details.message === "line1\nline2",
      run.details
    );
    check("parseRequestRun: locale kept when hi", run.locale === "hi");
    check(
      "parseRequestRun: spots deduped/clamped/dropped honestly",
      run.spots.length === 3 &&
        JSON.stringify(run.spots[0]) === JSON.stringify({ page: 0, x: 0.2, y: 0.3 }) &&
        run.spots[1]!.page === 1 && // 99 → last page
        run.spots[2]!.page === 1, // "0.7" rounds to 1
      run.spots
    );
    check(
      "parseRequestRun: labels filtered to reqsig.* strings",
      Object.keys(run.labels).length === 1 && run.labels["reqsig.title"] === "हस्ताक्षर अनुरोध",
      run.labels
    );
  }
  const enParsed = parseRequestRun({ locale: "fr", spots: [{ page: 0, x: 0.5, y: 0.5 }] }, 1);
  check(
    "parseRequestRun: unknown locale → en, missing details → defaults",
    enParsed.ok === true && enParsed.run.locale === "en" && enParsed.run.details.recipientName === "",
    enParsed
  );
  const jsonParsed = parseRequestRun(
    JSON.stringify({ spots: [{ page: 0, x: 0.5, y: 0.5 }] }),
    1
  );
  check("parseRequestRun: JSON string payload parsed", jsonParsed.ok === true && jsonParsed.run.spots.length === 1);
  const badJson = parseRequestRun("{oops", 1);
  check(
    "parseRequestRun: garbage JSON string → honest errNoSpots",
    badJson.ok === false && badJson.code === "reqsig.errNoSpots",
    badJson
  );
  const zero = parseRequestRun({ spots: [] }, 1);
  check("parseRequestRun: zero spots → errNoSpots", zero.ok === false && zero.code === "reqsig.errNoSpots");

  const capSpots = parseRequestRun(
    {
      spots: Array.from({ length: 40 }, (_, i) => ({ page: 0, x: (i % 90) / 100, y: 0.5 })),
    },
    1
  );
  check(
    "parseRequestRun: MAX_SPOTS cap (40 → 12)",
    capSpots.ok === true && capSpots.run.spots.length === MAX_SPOTS && MAX_SPOTS === 12,
    capSpots.ok ? capSpots.run.spots.length : capSpots
  );
  const xyClamp = parseRequestRun({ spots: [{ page: 0, x: 7, y: -3 }] }, 1);
  check(
    "parseRequestRun: x/y clamped into 0..1",
    xyClamp.ok === true && xyClamp.run.spots[0]!.x === 1 && xyClamp.run.spots[0]!.y === 0
  );

  // ---- wrapChars ---------------------------------------------------------
  // 30 × "word" at 78 cols: 15 words = 74 chars fit (16 words = 79 > 78),
  // so the greedy wrap yields exactly 2 lines of 15 words each.
  check(
    "wrapChars: greedy 78-col wrap",
    JSON.stringify(wrapChars("word ".repeat(30).trim(), 78)) ===
      JSON.stringify(["word ".repeat(15).trim(), "word ".repeat(15).trim()]),
    wrapChars("word ".repeat(30).trim(), 78)
  );
  check("wrapChars: paragraphs + empties", JSON.stringify(wrapChars("a\n\nb", 78)) === JSON.stringify(["a", "", "b"]));
  check(
    "wrapChars: monster word hard-broken",
    JSON.stringify(wrapChars("x".repeat(160), 78)) ===
      JSON.stringify(["x".repeat(78), "x".repeat(78), "x".repeat(4)]),
    wrapChars("x".repeat(160), 78)
  );
  check(
    "wrapChars: exact multiple of the column",
    JSON.stringify(wrapChars("y".repeat(156), 78)) ===
      JSON.stringify(["y".repeat(78), "y".repeat(78)])
  );

  // ---- buildRequestText / mailtoHref -------------------------------------
  const sampleRun: RequestPackRun = {
    locale: "en",
    details: {
      recipientName: "Priya Sharma",
      senderName: "Acme Ltd",
      recipientEmail: "priya@example.com",
      subject: "Agreement - please sign",
      message: "Please sign where marked.",
      dueDate: "2026-03-14",
    },
    spots: [
      { page: 0, x: 0.3, y: 0.25 },
      { page: 1, x: 0.7, y: 0.6 },
    ],
    labels: {},
  };
  const note = buildRequestText(sampleRun, "contract v2.pdf");
  check("request text: subject headline first", note.startsWith("Agreement - please sign\n"));
  check("request text: To/From/Sign by rows", note.includes("To: Priya Sharma") && note.includes("From: Acme Ltd") && note.includes("Sign by: 14/03/2026"));
  check("request text: document row with the original file name", note.includes("Document: contract v2.pdf"));
  check("request text: message body", note.includes("Please sign where marked."));
  check(
    "request text: numbered spot list with page + percents",
    note.includes("1. Spot 1: page 1 - 30% from left, 25% from top") &&
      note.includes("2. Spot 2: page 2 - 70% from left, 60% from top")
  );
  check("request text: how-to steps + privacy footer", note.includes("How to sign:") && note.includes("no file was uploaded"));
  check("request text: deterministic (same input → same bytes)", note === buildRequestText(sampleRun, "contract v2.pdf"));
  const localRun: RequestPackRun = {
    ...sampleRun,
    // No subject → the localized title label becomes the headline (the
    // subject always leads when set — see the EN check above).
    details: { ...sampleRun.details, subject: "" },
    labels: { "reqsig.title": "हस्ताक्षर अनुरोध", "reqsig.for": "प्राप्तकर्ता" },
  };
  const localNote = buildRequestText(localRun, "doc.pdf");
  check(
    "request text: localized labels used with EN fallback",
    localNote.startsWith("हस्ताक्षर अनुरोध\n") && localNote.includes("प्राप्तकर्ता: Priya Sharma") && localNote.includes("From: Acme Ltd")
  );

  const href = mailtoHref(sampleRun, "contract v2.pdf");
  check(
    "mailtoHref: address + encoded subject + body",
    href.startsWith("mailto:priya@example.com?subject=") &&
      decodeURIComponent(href).includes("Agreement - please sign") &&
      decodeURIComponent(href).includes("Hello Priya Sharma,") &&
      decodeURIComponent(href).includes("I have attached the PDF (contract v2.pdf).") &&
      decodeURIComponent(href).includes("By 14/03/2026 please."),
    href.slice(0, 80)
  );
  check(
    "mailtoHref: no usable address → empty (honest)",
    mailtoHref({ ...sampleRun, details: { ...sampleRun.details, recipientEmail: "not-an-email" } }, "d.pdf") === "" &&
      mailtoHref({ ...sampleRun, details: { ...sampleRun.details, recipientEmail: "" } }, "d.pdf") === ""
  );

  // ---- safeBaseName / sigFieldNames --------------------------------------
  check("safeBaseName: .pdf extension stripped (case-insensitive)", safeBaseName("Contract.PDF") === "Contract" && safeBaseName("a.pdf") === "a");
  check(
    "safeBaseName: spaces preserved (safeStampBaseName house helper behavior)",
    safeBaseName("contract v2.pdf") === "contract v2"
  );
  check(
    "safeBaseName: path-unsafe chars → underscore",
    safeBaseName('a/b\\c:d*e?f"g<h>i|.pdf') === "a_b_c_d_e_f_g_h_i_"
  );
  check("safeBaseName: Devanagari kept (no ASCII fallback mangling)", safeBaseName("अनुबंध.pdf") === "अनुबंध");
  check(
    "safeBaseName: blank → document fallback",
    safeBaseName(".pdf") === "document" && safeBaseName("   ") === "document"
  );
  check("safeBaseName: 120-char cap", safeBaseName(`${"a".repeat(500)}.pdf`).length === 120);

  check(
    "sigFieldNames: fresh doc → SignHere_1..N",
    JSON.stringify(sigFieldNames(3, new Set())) === JSON.stringify(["SignHere_1", "SignHere_2", "SignHere_3"])
  );
  check(
    "sigFieldNames: collisions suffixed, output stays unique",
    (() => {
      const names = sigFieldNames(2, new Set(["SignHere_1", "SignHere_2"]));
      return names[0] === "SignHere_1_2" && names[1] === "SignHere_2_2" &&
        new Set(names).size === 2;
    })()
  );

  // ---- label fallback ------------------------------------------------------
  check(
    "labelOf: localized hit, EN fallback otherwise",
    labelOf(localRun, "title") === "हस्ताक्षर अनुरोध" &&
      labelOf(localRun, "from") === "From" &&
      labelOf(sampleRun, "privacy") === NOTE_LABELS_EN.privacy
  );
  check(
    "NOTE_KEYS: exactly the 22 keys the note builders + box painter use",
    NOTE_KEYS.length === 22 && NOTE_KEYS.includes("boxLabel") && NOTE_KEYS.includes("mailSubject")
  );
}

/* ================================================================== */
console.log("── 2. REAL E2E through the worker (self-shimmed) ────────");
/* ================================================================== */
{
  const notoBytes = new Uint8Array(
    readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf")
  );

  const workerGlobal = globalThis as unknown as {
    postMessage: (msg: unknown) => void;
    onmessage: ((event: { data: WorkerRunRequest }) => void) | null;
    location: { href: string };
  };
  const messages: WorkerResponse[] = [];
  workerGlobal.postMessage = (msg: unknown): void => {
    messages.push(msg as WorkerResponse);
  };
  workerGlobal.location = { href: "http://localhost/" };
  (globalThis as unknown as Record<string, unknown>).self = workerGlobal;
  globalThis.fetch = (async (): Promise<Response> =>
    new Response(notoBytes)) as typeof fetch;
  await import("../tools/request-signature/worker");
  check("worker: module loaded, onmessage registered", typeof workerGlobal.onmessage === "function");

  const drive = async (
    runId: number,
    options: Record<string, unknown>,
    files: File[]
  ): Promise<WorkerResponse> => {
    const before = messages.length;
    workerGlobal.onmessage!({
      data: {
        type: "run",
        runId,
        toolId: "request-signature",
        options,
        files,
      } as WorkerRunRequest,
    });
    const done = await (async (): Promise<boolean> => {
      const deadline = Date.now() + 30_000;
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

  /* --- the real 2-page input (page 2 rotated 90°) --------------------- */
  const srcDoc = await PDFDocument.create();
  const srcFont = await srcDoc.embedFont(StandardFonts.Helvetica);
  const pageA = srcDoc.addPage([595.28, 841.89]);
  pageA.drawText("First page body text", { x: 50, y: 400, size: 12, font: srcFont });
  const pageB = srcDoc.addPage([595.28, 841.89]);
  pageB.drawText("Second page body text", { x: 50, y: 400, size: 12, font: srcFont });
  pageB.setRotation({ type: "degrees", angle: 90 } as never);
  const inputBytes = await srcDoc.save();

  const enRequest = makeRequest({
    details: {
      recipientName: "Priya Sharma",
      senderName: "Acme Ltd",
      recipientEmail: "priya@example.com",
      subject: "Agreement - please sign",
      message: "Please sign where marked.",
      dueDate: "2026-03-14",
    },
    spots: [
      { page: 0, x: 0.3, y: 0.25 },
      { page: 1, x: 0.7, y: 0.6 },
    ],
  });

  const res = await drive(
    101,
    { sigFields: true, flattenFirst: false, request: enRequest },
    [new File([inputBytes as BlobPart], "contract v2.pdf")]
  );
  check("worker EN: result", res.type === "result", res);
  if (res.type !== "result") {
    throw new Error("E2E run failed — aborting smoke");
  }
  check(
    "worker EN: three outputs with the -to-sign/-signing-pack/-request names",
    res.outputs.length === 3 &&
      res.outputs[0]!.name === "contract v2-to-sign.pdf" &&
      res.outputs[1]!.name === "contract v2-signing-pack.zip" &&
      res.outputs[2]!.name === "contract v2-request.txt",
    res.outputs.map((o) => o.name)
  );
  check(
    "worker EN: output mimes",
    res.outputs[0]!.mime === "application/pdf" &&
      res.outputs[1]!.mime === "application/zip" &&
      res.outputs[2]!.mime === "text/plain;charset=utf-8"
  );
  const detail = res.detail as { files?: number; pages?: number; fields?: number } | undefined;
  check(
    "worker EN: detail files/pages/fields",
    detail?.files === 1 && detail?.pages === 2 && detail?.fields === 2,
    detail
  );

  const prepared = new Uint8Array(await res.outputs[0]!.blob.arrayBuffer());
  const zipBytes = new Uint8Array(await res.outputs[1]!.blob.arrayBuffer());
  const txtBytes = new Uint8Array(await res.outputs[2]!.blob.arrayBuffer());

  /* --- the plain-text note ------------------------------------------------ */
  const txt = Buffer.from(txtBytes).toString("utf8");
  check("worker EN: request.txt carries the spot list + due date", txt.includes("1. Spot 1: page 1") && txt.includes("Sign by: 14/03/2026"));

  /* --- reload + RAW object table parse ----------------------------------- */
  const doc = await PDFDocument.load(prepared, { updateMetadata: false });
  check("worker EN: prepared PDF still has 2 pages", doc.getPageCount() === 2);

  const objects = [...doc.context.enumerateIndirectObjects()];
  const sigFieldsFound: { name: string; kidCount: number; dict: PDFDict }[] = [];
  const widgetDicts: PDFDict[] = [];
  for (const [, obj] of objects) {
    if (!(obj instanceof PDFDict)) continue;
    if (obj.get(PDFName.of("FT")) === PDFName.of("Sig")) {
      const t = obj.get(PDFName.of("T"));
      const kids = obj.get(PDFName.of("Kids"));
      const kidsArray = doc.context.lookup(kids);
      sigFieldsFound.push({
        name: t === undefined ? "" : t.toString(),
        kidCount: kidsArray instanceof PDFArray ? kidsArray.size() : 0,
        dict: obj,
      });
    }
    if (obj.get(PDFName.of("Subtype")) === PDFName.of("Widget")) {
      widgetDicts.push(obj);
    }
  }
  check(
    "prepared: exactly 2 real /FT /Sig field dicts, right /T names",
    sigFieldsFound.length === 2 &&
      sigFieldsFound.map((f) => f.name).join(",") === "(SignHere_1),(SignHere_2)",
    sigFieldsFound.map((f) => f.name)
  );
  check(
    "prepared: every field has exactly one widget kid",
    sigFieldsFound.every((f) => f.kidCount === 1),
    sigFieldsFound.map((f) => f.kidCount)
  );
  check(
    "prepared: pdf-lib's own form reader agrees on the names",
    (() => {
      try {
        return doc.getForm().getFields().map((f) => f.getName()).join(",") === "SignHere_1,SignHere_2";
      } catch {
        return false;
      }
    })()
  );
  check(
    "prepared: AcroForm /Fields lists both field refs",
    (() => {
      const fields = doc.getForm().acroForm.dict.get(PDFName.of("Fields"));
      return fields instanceof PDFArray && fields.size() === 2;
    })()
  );
  check(
    "prepared: exactly 2 widget annotation dicts",
    widgetDicts.length === 2,
    widgetDicts.length
  );

  /* widget /Rects — hand-computed geometry (rotation included) */
  const rectOf = (d: PDFDict): number[] => {
    const r = d.get(PDFName.of("Rect"));
    if (!(r instanceof PDFArray)) return [];
    return [0, 1, 2, 3].map((i) => Number(r.lookup(i)?.toString?.() ?? NaN));
  };
  // page 1 (Rotate 0): spot (0.3, 0.25) on A4 → display box
  // left=93.584 top=187.4725 → user rect [93.584, 608.4175, 263.584, 654.4175]
  const p0Annots = doc.getPage(0).node.Annots();
  check("prepared: page 1 /Annots carries the first widget", p0Annots instanceof PDFArray && p0Annots.size() === 1);
  let p0Rect: number[] = [];
  let p0Widget: PDFDict | undefined;
  if (p0Annots instanceof PDFArray) {
    const w = p0Annots.lookup(0);
    if (w instanceof PDFDict) {
      p0Widget = w;
      p0Rect = rectOf(w);
    }
  }
  check(
    "prepared: page-1 widget /Rect exact (y-flip, no border inflation)",
    p0Rect.length === 4 &&
      near(p0Rect[0]!, 93.584) && near(p0Rect[1]!, 608.4175) &&
      near(p0Rect[2]!, 263.584) && near(p0Rect[3]!, 654.4175),
    p0Rect
  );
  // page 2 (Rotate 90): spot (0.7, 0.6), display 841.89×595.28 →
  // left=504.323 top=334.168 → user [334.168, 504.323, 380.168, 674.323]
  const p1Annots = doc.getPage(1).node.Annots();
  check("prepared: page 2 /Annots carries the second widget", p1Annots instanceof PDFArray && p1Annots.size() === 1);
  let p1Rect: number[] = [];
  if (p1Annots instanceof PDFArray) {
    const w = p1Annots.lookup(0);
    if (w instanceof PDFDict) p1Rect = rectOf(w);
  }
  check(
    "prepared: page-2 widget /Rect exact under /Rotate 90 (axes swap)",
    p1Rect.length === 4 &&
      near(p1Rect[0]!, 334.168) && near(p1Rect[1]!, 504.323) &&
      near(p1Rect[2]!, 380.168) && near(p1Rect[3]!, 674.323),
    p1Rect
  );
  check(
    "prepared: widgets carry Type/Annot + Subtype/Widget + Print flag + /P page link + /Parent field link",
    widgetDicts.every(
      (w) =>
        w.get(PDFName.of("Type")) === PDFName.of("Annot") &&
        w.get(PDFName.of("Subtype")) === PDFName.of("Widget") &&
        w.get(PDFName.of("F")) !== undefined &&
        w.get(PDFName.of("F"))!.toString() === "4" &&
        w.get(PDFName.of("P")) !== undefined &&
        w.get(PDFName.of("Parent")) !== undefined
    )
  );
  if (p0Widget !== undefined) {
    const parent = p0Widget.get(PDFName.of("Parent"));
    const parentDict =
      parent !== undefined ? doc.context.lookup(parent) : undefined;
    check(
      "prepared: page-1 widget /Parent resolves to the SignHere_1 field dict",
      parentDict instanceof PDFDict &&
        parentDict.get(PDFName.of("FT")) === PDFName.of("Sig") &&
        parentDict.get(PDFName.of("T"))!.toString() === "(SignHere_1)"
    );
  } else {
    check("prepared: page-1 widget present for /Parent check", false);
  }
  check(
    "prepared: no NaN coords anywhere (all widget rect numbers finite)",
    [...p0Rect, ...p1Rect].every((v) => Number.isFinite(v))
  );

  /* --- the VISIBLE ink: dashed boxes + text needles in inflated streams -- */
  const c0 = pageContentLatin1(doc, 0);
  const c1 = pageContentLatin1(doc, 1);
  check(
    "prepared: streams are FlateDecode (node:zlib inflated)",
    (() => {
      const contents = doc.getPage(0).node.Contents();
      return (
        contents !== undefined &&
        (contents instanceof PDFArray
          ? contents.lookup(0)
          : contents
        ) instanceof PDFRawStream
      );
    })()
  );
  check("prepared page 1: dashed amber box stroke pattern [4 3] 0 d", c0.includes("[4 3] 0 d"));
  check("prepared page 1: amber stroke colour 0.78 0.47 0.04 RG + 1.25 width", c0.includes("0.78 0.47 0.04 RG") && c0.includes("1.25 w"));
  check("prepared page 1: '1. Sign here' box label (hex token)", hasText(c0, "1. Sign here"));
  check("prepared page 1: 'For: Priya Sharma' (recipient needle)", hasText(c0, "For: Priya Sharma"));
  check("prepared page 1: 'Due: 14/03/2026' (due-date needle)", hasText(c0, "Due: 14/03/2026"));
  check("prepared page 1: original body text survives the stamp", hasText(c0, "First page body text"));
  check("prepared page 2: '2. Sign here' numbered independently", hasText(c1, "2. Sign here"));
  check("prepared page 2: original body text survives", hasText(c1, "Second page body text"));
  check(
    "prepared: no NaN anywhere in the inflated streams",
    !c0.toUpperCase().includes("NAN") && !c1.toUpperCase().includes("NAN")
  );
  check(
    "prepared: the amber box path sits inside the page MediaBox (path ops, not re)",
    (() => {
      // pdf-lib drawRectangle emits a closed PATH (m/l/h + S — the RB2-d
      // lesson), translated by a cm. Parse the cm + leg extents.
      const m =
        /1 0 0 1 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?) cm\n(?:1 0 0 1 0 0 cm\n){2}0 0 m\n0 (\d+(?:\.\d+)?) l\n(\d+(?:\.\d+)?) (\d+(?:\.\d+)?) l\n(\d+(?:\.\d+)?) 0 l\nh\nS/.exec(
          c0
        );
      if (m === null) return false;
      const x = Number(m[1]);
      const y = Number(m[2]);
      const h = Number(m[3]);
      const w = Number(m[4]);
      return (
        w === 170 && h === 46 &&
        x >= 0 && y >= 0 && x + w <= 595.29 && y + h <= 841.9
      );
    })()
  );
  check(
    "prepared page 2: the rotated box path is 46×170 (axes swapped by /Rotate 90)",
    (() => {
      const m =
        /1 0 0 1 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?) cm\n(?:1 0 0 1 0 0 cm\n){2}0 0 m\n0 (\d+(?:\.\d+)?) l\n(\d+(?:\.\d+)?) (\d+(?:\.\d+)?) l\n(\d+(?:\.\d+)?) 0 l\nh\nS/.exec(
          c1
        );
      if (m === null) return false;
      const h = Number(m[3]);
      const w = Number(m[4]);
      return w === 46 && h === 170;
    })()
  );
  check(
    "prepared page 2: the label text matrix is pre-rotated by the page /Rotate 90 (reads horizontally in the viewer)",
    // pdf-lib writes the cos(90°) entries in full IEEE-754 precision
    // ("0.00000000000000006123233995736767"), so match on the exact
    // sin components instead: [~0 1 -1 ~0 x y] Tm.
    /\S+ 1 -1 \S+ \d+(?:\.\d+)? \d+(?:\.\d+)? Tm/.test(c1)
  );
  check(
    "prepared page 2: the label anchor is the display top-left of the box",
    (() => {
      // display box: left=504.323 top=334.168; anchor = (left+7, top+13.5)
      // mapped back to user space → user (347.668, 511.323).
      const m = /\S+ 1 -1 \S+ (\d+(?:\.\d+)?) (\d+(?:\.\d+)?) Tm/.exec(c1);
      if (m === null) return false;
      return near(Number(m[1]), 347.668, 0.05) && near(Number(m[2]), 511.323, 0.05);
    })()
  );

  /* --- pdf.js extraction (the visual truth) ------------------------------- */
  const flat = await pdfjsFlatText(prepared);
  check("prepared (pdf.js): '1. Sign here' + '2. Sign here' visible", flat.includes("1. Sign here") && flat.includes("2. Sign here"));
  check("prepared (pdf.js): recipient + due date on page 1", flat.includes("For: Priya Sharma") && flat.includes("Due: 14/03/2026"));

  /* --- progress honesty ------------------------------------------------------ */
  const pcts = messages
    .filter((m) => m.type === "progress" && m.runId === 101)
    .map((m) => (m as { pct: number }).pct);
  check(
    "worker EN: progress pcts 3/12/26/42/60/72/92 posted in order",
    [3, 12, 26, 42, 60, 72, 92].every((p) => pcts.includes(p)) &&
      JSON.stringify(pcts) === JSON.stringify([3, 12, 26, 42, 60, 72, 92]),
    pcts
  );
  const stages = new Set(
    messages
      .filter((m) => m.type === "progress" && m.runId === 101)
      .map((m) => (m as { stage: string }).stage)
  );
  check(
    "worker EN: progress stages from the honest trio",
    [...stages].every((s) => s === "reading" || s === "processing" || s === "saving"),
    [...stages]
  );

  /* ================================================================== */
  console.log("── 3. Hindi request (Devanagari) ───────────────────────");
  /* ================================================================== */
  const hiLabels = Object.fromEntries(
    NOTE_KEYS.map((key) => [
      `reqsig.${key}`,
      (toolI18n.hi.reqsig as Record<string, string>)[key] ?? "",
    ])
  );
  const hiRes = await drive(
    102,
    {
      sigFields: true,
      flattenFirst: false,
      request: makeRequest({
        locale: "hi",
        details: {
          recipientName: "प्रिया शर्मा",
          senderName: "एक्मे लिमिटेड",
          recipientEmail: "",
          subject: "अनुबंध - कृपया हस्ताक्षर करें",
          message: "कृपया चिह्नित स्थान पर हस्ताक्षर करें।",
          dueDate: "2026-03-14",
        },
        spots: [{ page: 0, x: 0.5, y: 0.5 }],
        labels: hiLabels,
      }),
    },
    [new File([inputBytes as BlobPart], "अनुबंध.pdf")]
  );
  check("worker HI: result", hiRes.type === "result", hiRes);
  if (hiRes.type === "result") {
    const hiPrepared = new Uint8Array(await hiRes.outputs[0]!.blob.arrayBuffer());
    const hiDoc = await PDFDocument.load(hiPrepared, { updateMetadata: false });
    const hiDump = objDump(hiDoc);
    check("worker HI: prepared PDF embeds the Noto FontFile2", hiDump.includes("FontFile2"));
    check("worker HI: prepared PDF carries the Identity-H Type0 encoding", hiDump.includes("/Identity-H"));
    check("worker HI: prepared PDF has exactly 1 real /Sig field", (() => {
      let n = 0;
      for (const [, obj] of hiDoc.context.enumerateIndirectObjects()) {
        if (obj instanceof PDFDict && obj.get(PDFName.of("FT")) === PDFName.of("Sig")) n += 1;
      }
      return n === 1;
    })());
    const hiC0 = pageContentLatin1(hiDoc, 0);
    check("worker HI: dashed box stroke present", hiC0.includes("[4 3] 0 d"));
    check(
      "worker HI: Devanagari glyph ids really drawn (CID hex tokens in the stream)",
      /<[0-9A-F]{4,}> Tj/.test(hiC0) && hiC0.includes("Tf")
    );
    // visual-order honesty (probe-deva precedent): stable substrings only
    const hiFlat = await pdfjsFlatText(hiPrepared);
    check("worker HI: box label 'यहाँ हस्ताक्षर करें' extracted (stable substrings)", hiFlat.includes("यहाँ") && hiFlat.includes("हस्ताक्षर") && hiFlat.includes("करें"));
    check("worker HI: Devanagari extracted at all", /[\u0900-\u097F]/.test(hiFlat));
    check("worker HI: due date digits extracted", hiFlat.includes("14/03/2026"));

    /* the Hindi NOTE PDF (from the zip) also embeds Noto */
    const hiZip = new Uint8Array(await hiRes.outputs[1]!.blob.arrayBuffer());
    const hiEntries = walkZip(hiZip);
    const hiNoteEntry = hiEntries.find((e) => e.name.includes("request-note"));
    check("worker HI: zip carries the Hindi request-note entry", hiNoteEntry !== undefined, hiEntries.map((e) => e.name));
    if (hiNoteEntry !== undefined) {
      const hiNoteDoc = await PDFDocument.load(hiNoteEntry.data, { updateMetadata: false });
      const hiNoteDump = objDump(hiNoteDoc);
      check("worker HI: note PDF embeds the Noto FontFile2 too", hiNoteDump.includes("FontFile2"));
      check("worker HI: note PDF carries Identity-H", hiNoteDump.includes("/Identity-H"));
      const hiNoteFlat = await pdfjsFlatText(hiNoteEntry.data);
      check(
        "worker HI: note PDF title + recipient extracted (stable substrings)",
        hiNoteFlat.includes("हस्ताक्षर") && hiNoteFlat.includes("अनुरोध")
      );
    }
    const hiTxt = Buffer.from(
      new Uint8Array(await hiRes.outputs[2]!.blob.arrayBuffer())
    ).toString("utf8");
    check(
      "worker HI: request.txt is UTF-8 Devanagari with the localized labels",
      hiTxt.startsWith("अनुबंध - कृपया हस्ताक्षर करें\n") && hiTxt.includes("प्राप्तकर्ता: प्रिया शर्मा"),
      hiTxt.slice(0, 60)
    );
  }

  /* ================================================================== */
  console.log("── 4. sigFields OFF (boxes only) ────────────────────────");
  /* ================================================================== */
  const offRes = await drive(
    103,
    {
      sigFields: false,
      flattenFirst: false,
      request: makeRequest({
        details: { recipientName: "Ravi Verma" },
        spots: [{ page: 0, x: 0.5, y: 0.5 }],
      }),
    },
    [new File([inputBytes as BlobPart], "contract v2.pdf")]
  );
  check("worker off: result", offRes.type === "result", offRes);
  if (offRes.type === "result") {
    const offPdf = new Uint8Array(await offRes.outputs[0]!.blob.arrayBuffer());
    const offDoc = await PDFDocument.load(offPdf, { updateMetadata: false });
    check(
      "worker off: NO /Sig field anywhere in the object table",
      !objDump(offDoc).includes("/FT /Sig")
    );
    check(
      "worker off: detail.fields honestly 0",
      (offRes.detail as { fields?: number }).fields === 0
    );
    const offC0 = pageContentLatin1(offDoc, 0);
    check("worker off: the visible box is still drawn", offC0.includes("[4 3] 0 d") && hasText(offC0, "1. Sign here"));
    check(
      "worker off: no widget annotation dicts at all",
      (() => {
        let widgets = 0;
        for (const [, obj] of offDoc.context.enumerateIndirectObjects()) {
          if (obj instanceof PDFDict && obj.get(PDFName.of("Subtype")) === PDFName.of("Widget")) widgets += 1;
        }
        return widgets === 0;
      })()
    );
  }

  /* ================================================================== */
  console.log("── 5. flatten-first ON with a filled form ────────────────");
  /* ================================================================== */
  // input with a FILLED text field + body text
  const fDoc = await PDFDocument.create();
  const fFont = await fDoc.embedFont(StandardFonts.Helvetica);
  const fPage = fDoc.addPage([595.28, 841.89]);
  fPage.drawText("Flatten fixture body", { x: 50, y: 700, size: 12, font: fFont });
  const fForm = fDoc.getForm();
  const buyer = fForm.createTextField("buyer_name");
  buyer.setText("Ravi Verma");
  buyer.addToPage(fPage, { x: 50, y: 600, width: 200, height: 24 });
  const flattenInput = await fDoc.save();

  const fRes = await drive(
    104,
    {
      sigFields: true,
      flattenFirst: true,
      request: makeRequest({
        details: { recipientName: "Ravi Verma", dueDate: "2026-01-31" },
        spots: [{ page: 0, x: 0.5, y: 0.3 }],
      }),
    },
    [new File([flattenInput as BlobPart], "filled-form.pdf")]
  );
  check("worker flatten: result", fRes.type === "result", fRes);
  if (fRes.type === "result") {
    const fOut = new Uint8Array(await fRes.outputs[0]!.blob.arrayBuffer());
    const fReload = await PDFDocument.load(fOut, { updateMetadata: false });
    const fFormAfter = fReload.getForm();
    check(
      "worker flatten: original field GONE, only the sig field remains",
      fFormAfter.getFields().map((f) => f.getName()).join(",") === "SignHere_1",
      fFormAfter.getFields().map((f) => f.getName())
    );
    const fc = pageContentLatin1(fReload, 0);
    check(
      "worker flatten: field value burned into the page content stream",
      hasText(fc, "Ravi Verma")
    );
    check("worker flatten: body text still present", hasText(fc, "Flatten fixture body"));
    check("worker flatten: sign-here box drawn on top", hasText(fc, "1. Sign here") && fc.includes("[4 3] 0 d"));
    check(
      "worker flatten: no AcroForm trace of the flattened field name",
      !objDump(fReload).includes("buyer_name")
    );
  }

  // flattenFirst ON with NO form at all → FlattenNothingError tolerated
  const fnRes = await drive(
    105,
    {
      sigFields: true,
      flattenFirst: true,
      request: makeRequest({
        details: { recipientName: "No Form" },
        spots: [{ page: 0, x: 0.4, y: 0.4 }],
      }),
    },
    [new File([inputBytes as BlobPart], "contract v2.pdf")]
  );
  check(
    "worker flatten: no form → proceeds honestly (nothing to flatten)",
    fnRes.type === "result" &&
      (fnRes.detail as { fields?: number }).fields === 1,
    fnRes.type === "result" ? fnRes.detail : fnRes
  );

  /* ================================================================== */
  console.log("── 6. pack assembly (node:zlib central-directory walk) ───");
  /* ================================================================== */
  {
    const entries = walkZip(zipBytes);
    check("pack: exactly 2 entries", entries.length === 2, entries.map((e) => e.name));
    check(
      "pack: entry names are the prepared PDF + the request note",
      entries[0]!.name === "contract v2-to-sign.pdf" &&
        entries[1]!.name === "contract v2-request-note.pdf",
      entries.map((e) => e.name)
    );
    check(
      "pack: both entries inflate to real %PDF files",
      entries.every((e) => e.data[0] === 0x25 && e.data[1] === 0x50 && e.data[2] === 0x44 && e.data[3] === 0x46)
    );
    check(
      "pack: both entries are raw-deflate (method 8, fflate)",
      entries.every((e) => e.method === 8)
    );

    const noteEntry = entries.find((e) => e.name.includes("request-note"))!;
    const noteDoc = await PDFDocument.load(noteEntry.data, { updateMetadata: false });
    check("pack note: reloads as a 1-page A4 request note", noteDoc.getPageCount() === 1);
    check(
      "pack note: page is A4",
      (() => {
        const s = noteDoc.getPage(0).getSize();
        return near(s.width, 595.28, 0.5) && near(s.height, 841.89, 0.5);
      })()
    );
    check("pack note: Title = the request subject", noteDoc.getTitle() === "Agreement - please sign", noteDoc.getTitle());
    check("pack note: Producer DocoPDF", noteDoc.getProducer() === "DocoPDF", noteDoc.getProducer());
    const noteDump = objDump(noteDoc);
    check("pack note (EN): nothing embedded (base-14 Helvetica path)", !noteDump.includes("FontFile2"));
    const noteContent = pageContentLatin1(noteDoc, 0);
    check("pack note: subject headline", hasText(noteContent, "Agreement - please sign"));
    // The note PDF is a two-column form (label column + value column):
    // each row's label ("To") and value ("Priya Sharma") are separate
    // drawText ops. "To" is a 2-char needle — too short for the hasText
    // hex branch (needs ≥ 8 hex chars), so match its exact hex token.
    check(
      "pack note: To/From/Sign by/Document rows (label column + values)",
      noteContent.includes("<546F>") &&
        hasText(noteContent, "Priya Sharma") &&
        hasText(noteContent, "From") &&
        hasText(noteContent, "Acme Ltd") &&
        hasText(noteContent, "Sign by") &&
        hasText(noteContent, "14/03/2026") &&
        hasText(noteContent, "Document") &&
        hasText(noteContent, "contract v2.pdf")
    );
    check("pack note: message body", hasText(noteContent, "Please sign where marked."));
    check("pack note: spot list line", hasText(noteContent, "Spot 1: page 1"));
    check("pack note: how-to instructions", hasText(noteContent, "How to sign"));
    const noteFlat = await pdfjsFlatText(noteEntry.data);
    check(
      "pack note (pdf.js): full request renders — reason + recipient + due date",
      noteFlat.includes("Agreement - please sign") &&
        noteFlat.includes("Priya Sharma") &&
        noteFlat.includes("14/03/2026") &&
        noteFlat.includes("Where to sign")
    );
  }

  /* ================================================================== */
  console.log("── 7. rejection vectors (honest taxonomy) ────────────────");
  /* ================================================================== */
  const noFileRes = await drive(201, { sigFields: true }, []);
  check("worker reject: no file → tool.errorGeneric", noFileRes.type === "error" && noFileRes.code === "tool.errorGeneric", noFileRes);

  const garbageRes = await drive(
    202,
    { sigFields: true, request: makeRequest({ details: { recipientName: "X" }, spots: [{ page: 0, x: 0.5, y: 0.5 }] }) },
    [new File(["hello world not a pdf"], "garbage.pdf")]
  );
  check("worker reject: garbage bytes → tool.errorCorrupt", garbageRes.type === "error" && garbageRes.code === "tool.errorCorrupt", garbageRes);

  const zeroSpotsRes = await drive(
    203,
    { sigFields: true, request: makeRequest({ details: { recipientName: "X" }, spots: [] }) },
    [new File([inputBytes as BlobPart], "contract v2.pdf")]
  );
  check(
    "worker reject: zero spots → reqsig.errNoSpots (the model's honest behavior)",
    zeroSpotsRes.type === "error" && zeroSpotsRes.code === "reqsig.errNoSpots",
    zeroSpotsRes
  );
  const noRequestRes = await drive(
    204,
    { sigFields: true },
    [new File([inputBytes as BlobPart], "contract v2.pdf")]
  );
  check(
    "worker reject: missing request payload → reqsig.errNoSpots",
    noRequestRes.type === "error" && noRequestRes.code === "reqsig.errNoSpots",
    noRequestRes
  );

  const { PDFDocument: CantooDoc } = await import("@cantoo/pdf-lib");
  const enc = await CantooDoc.create();
  enc.addPage([300, 300]);
  enc.encrypt({ userPassword: "secret", algorithm: "AES-256" });
  const encrypted = await enc.save({ useObjectStreams: false });
  const encRes = await drive(
    205,
    {
      sigFields: true,
      request: makeRequest({ details: { recipientName: "X" }, spots: [{ page: 0, x: 0.5, y: 0.5 }] }),
    },
    [new File([encrypted as BlobPart], "locked.pdf")]
  );
  check("worker reject: encrypted → tool.errorEncrypted", encRes.type === "error" && encRes.code === "tool.errorEncrypted", encRes);

  // already-signed input → honest refusal (pdf-lib re-save would silently
  // invalidate the existing signature's /ByteRange — the AUD-C FIX)
  const signedSrc = await PDFDocument.create();
  signedSrc.addPage([300, 300]);
  // A real-looking PPKLite sig dict, saved WITHOUT object streams (real
  // signed PDFs always carry the sig dict as plain bytes, same as the
  // house digital-signature tool's own output).
  signedSrc.context.register(
    signedSrc.context.obj({
      Type: "Sig",
      Filter: "Adobe.PPKLite",
      SubFilter: "adbe.pkcs7.detached",
      ByteRange: [0, 100, 200, 8],
      Contents: "00",
    })
  );
  const signedInput = await signedSrc.save({ useObjectStreams: false });
  check(
    "worker reject: signed fixture really carries a signature",
    hasExistingSignature(signedInput),
    "fixture not detected — object streams hid the sig dict"
  );
  const signedRes = await drive(
    207,
    {
      sigFields: true,
      request: makeRequest({ details: { recipientName: "X" }, spots: [{ page: 0, x: 0.5, y: 0.5 }] }),
    },
    [new File([signedInput as BlobPart], "signed.pdf")]
  );
  check(
    "worker reject: already-signed input → tool.errorAlreadySigned (no silent re-save)",
    signedRes.type === "error" && signedRes.code === "tool.errorAlreadySigned",
    signedRes
  );

  // page-count clamp E2E: spot page 99 on a 2-page doc lands on page 2
  const clampRes = await drive(
    206,
    {
      sigFields: true,
      request: makeRequest({
        details: { recipientName: "Clamped" },
        spots: [{ page: 99, x: 0.5, y: 0.5 }],
      }),
    },
    [new File([inputBytes as BlobPart], "contract v2.pdf")]
  );
  check("worker clamp: result", clampRes.type === "result", clampRes);
  if (clampRes.type === "result") {
    const clampPdf = new Uint8Array(await clampRes.outputs[0]!.blob.arrayBuffer());
    const clampDoc = await PDFDocument.load(clampPdf, { updateMetadata: false });
    const p1 = clampDoc.getPage(1).node.Annots();
    const p0 = clampDoc.getPage(0).node.Annots();
    check(
      "worker clamp: off-page spot clamped onto the LAST page's widget",
      p1 instanceof PDFArray && p1.size() === 1 &&
        (p0 === undefined || p0.size() === 0)
    );
  }
}

/* ================================================================== */
console.log("── 8. i18n + config + wiring ─────────────────────────────");
/* ================================================================== */
{
  const enKeys = Object.keys(toolI18n.en.reqsig).sort();
  const hiKeys = Object.keys(toolI18n.hi.reqsig).sort();
  check(
    "i18n: tool catalog en/hi key parity",
    JSON.stringify(enKeys) === JSON.stringify(hiKeys),
    { en: enKeys.length, hi: hiKeys.length }
  );
  check("i18n: the reqsig namespace is substantial", enKeys.length >= 45, enKeys.length);

  // every NOTE_KEYS label the worker paints resolves in BOTH catalogs
  check(
    "i18n: every NOTE_KEY resolves in both catalogs",
    NOTE_KEYS.every(
      (k) =>
        typeof (toolI18n.en.reqsig as Record<string, string>)[k] === "string" &&
        typeof (toolI18n.hi.reqsig as Record<string, string>)[k] === "string"
    )
  );
  // every reqsig.* referenced in the tool sources resolves
  const sources = [
    "tools/request-signature/surface.tsx",
    "tools/request-signature/config.ts",
    "tools/request-signature/worker.ts",
    "tools/request-signature/model.ts",
  ]
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  const referenced = new Set<string>();
  for (const m of sources.matchAll(/reqsig\.[A-Za-z0-9]+/g)) referenced.add(m[0]);
  const missingRef = [...referenced].filter(
    (key) =>
      !(
        key.slice(7) in (toolI18n.en.reqsig as Record<string, unknown>) &&
        key.slice(7) in (toolI18n.hi.reqsig as Record<string, unknown>)
      )
  );
  check(
    "i18n: every referenced reqsig.* key resolves in both catalogs",
    referenced.size >= 35 && missingRef.length === 0,
    { missingRef, referenced: referenced.size }
  );

  // worker error codes have leaves
  const errorCodes = ["reqsig.errNoSpots", "reqsig.errFlatten"];
  check(
    "i18n: worker error codes have leaves in both catalogs",
    errorCodes.every((c) => c.slice(7) in (toolI18n.en.reqsig as Record<string, unknown>) && c.slice(7) in (toolI18n.hi.reqsig as Record<string, unknown>))
  );
  const catEn = JSON.parse(readFileSync("src/i18n/en.json", "utf8")) as {
    tool: Record<string, string>;
  };
  const catHi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8")) as {
    tool: Record<string, string>;
  };
  check(
    "i18n: shared tool.errorEncrypted/errorCorrupt/errorGeneric exist (worker fallbacks)",
    "errorEncrypted" in catEn.tool && "errorCorrupt" in catEn.tool && "errorGeneric" in catEn.tool &&
      "errorEncrypted" in catHi.tool && "errorCorrupt" in catHi.tool && "errorGeneric" in catHi.tool
  );
  check(
    "i18n: shared tool.errorAlreadySigned exists in both catalogs (signature guard)",
    "errorAlreadySigned" in catEn.tool && "errorAlreadySigned" in catHi.tool
  );

  // ---- config.ts ------------------------------------------------------
  const configSrc = readFileSync("tools/request-signature/config.ts", "utf8");
  check("config: toolId", configSrc.includes('toolId: "request-signature"'));
  check("config: spawns ./worker.ts", configSrc.includes("./worker.ts"));
  check("config: outputKind pdf", configSrc.includes('outputKind: "pdf"'));
  check("config: exactly one file", configSrc.includes("maxFiles: 1") && configSrc.includes("minFiles: 1"));
  check("config: howKeys are reqsig.*", configSrc.includes('"reqsig.how1"') && configSrc.includes('"reqsig.how3"'));
  check(
    "config: both switches declared (sigFields + flattenFirst)",
    configSrc.includes('id: "sigFields"') && configSrc.includes('id: "flattenFirst"')
  );
  check("config: chain tools declared", configSrc.includes('"sign-pdf"') && configSrc.includes('"flatten-pdf"'));

  // ---- surface.tsx ------------------------------------------------------
  const surfaceSrc = readFileSync("tools/request-signature/surface.tsx", "utf8");
  check("surface: ships the serialized request option", surfaceSrc.includes('onChange(\n        "request"'));
  check("surface: localizes every NOTE_KEY label", surfaceSrc.includes("NOTE_KEYS.map"));
  check("surface: CTA gating (no name / no spots)", surfaceSrc.includes('"reqsig.ctaNoName"') && surfaceSrc.includes('"reqsig.ctaNoSpots"'));
  check("surface: setRunBlocked gating used", surfaceSrc.includes("setRunBlocked"));
  check("surface: MAX_SPOTS cap applied in addSpot", surfaceSrc.includes("spots.length >= MAX_SPOTS"));
  check("surface: honest mailto card (browsers cannot attach)", surfaceSrc.includes("mailtoHref"));
  check("surface: spots keyed by file id (no stale placements)", surfaceSrc.includes("fileKey === fileKey".replace("fileKey === fileKey", "spotState.fileKey === fileKey")));

  // ---- worker.ts --------------------------------------------------------
  const workerSrc = readFileSync("tools/request-signature/worker.ts", "utf8");
  check("worker: reads the sigFields option", workerSrc.includes('readBool(options, "sigFields"'));
  check("worker: reads the flattenFirst option", workerSrc.includes('readBool(options, "flattenFirst"'));
  check("worker: parses the request payload defensively", workerSrc.includes("parseRequestRun(options.request"));
  check("worker: flatten runs BEFORE the signature fields", workerSrc.indexOf("flattenDocument") < workerSrc.indexOf("drawSignHereBoxes"));
  check("worker: flatten scope is forms-only", workerSrc.includes('scope: "forms-only"'));
  check("worker: only reacts to type run", workerSrc.includes('data?.type !== "run"'));
  check("worker: on-device zip via zipPack", workerSrc.includes("zipPack"));
  check(
    "worker: refuses already-signed inputs (hasExistingSignature guard)",
    workerSrc.includes("hasExistingSignature(bytes)") &&
      workerSrc.includes('"tool.errorAlreadySigned"')
  );

  // ---- render.ts ----------------------------------------------------------
  const renderSrc = readFileSync("tools/request-signature/render.ts", "utf8");
  check("render: Producer DocoPDF (house brand)", renderSrc.includes('setProducer("DocoPDF")'));
  check("render: no off-brand producer left", !renderSrc.includes("MyCloudy"));

  // ---- wiring ---------------------------------------------------------------
  const configsSrc = readFileSync("src/lib/tools/configs.ts", "utf8");
  check("wiring: configs.ts imports the tool config", configsSrc.includes('import { config as requestSignature } from "../../../tools/request-signature/config"'));
  check("wiring: configs.ts registers it", configsSrc.includes("[requestSignature.toolId]: requestSignature"));
  const surfacesSrc = readFileSync("src/lib/tools/surfaces.tsx", "utf8");
  check("wiring: surfaces.tsx imports the surface", surfacesSrc.includes('import { RequestSignatureSurface } from "../../../tools/request-signature/surface"'));
  check("wiring: surfaces.tsx registers it", surfacesSrc.includes('"request-signature": RequestSignatureSurface'));
  const registrySrc = readFileSync("src/lib/tools/registry.ts", "utf8");
  check("wiring: registry def exists + enabled + mode D + accepts pdf", (() => {
    const at = registrySrc.indexOf('id: "request-signature"');
    const block = registrySrc.slice(at, at + 400);
    return (
      at >= 0 &&
      block.includes("enabled: true") &&
      block.includes('mode: "D"') &&
      block.includes('accepts: "pdf"')
    );
  })());
}

console.log(
  `\nrequest-signature smoke: ${pass} passed, ${fail} failed` +
  (fail ? `\n  ${failures.join("\n  ")}` : "")
);
process.exit(fail === 0 ? 0 : 1);

/* ------------------------------------------------------------------ */
/* the node:zlib zip oracle (hoisted for the Hindi section)            */
/* ------------------------------------------------------------------ */

interface ZippedEntry {
  name: string;
  method: number;
  data: Buffer;
}

/**
 * Walks the CENTRAL DIRECTORY (EOCD → CD entries → local headers) and
 * inflates every entry itself via node:zlib (fflate writes RAW deflate,
 * hence inflateRawSync). Order is preserved.
 */
function walkZip(bytes: Uint8Array): ZippedEntry[] {
  const buf = Buffer.from(bytes);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("no EOCD record found");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out: ZippedEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString("utf8");
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.slice(dataStart, dataStart + compSize);
    if (method === 8) {
      out.push({ name, method, data: inflateRawSync(comp) });
    } else if (method === 0) {
      out.push({ name, method, data: comp });
    } else {
      throw new Error(`unsupported zip method ${method}`);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  if (out.length === 0) throw new Error("no zip entries parsed");
  return out;
}
