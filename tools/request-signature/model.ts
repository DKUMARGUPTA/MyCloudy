/**
 * Request signature — model (RB6-b). Pure, bun-testable logic for the
 * prepare-and-send-yourself signing pack:
 *
 *  - the WinAnsi-vs-Noto split-run font rule (xml-invoice-to-pdf recipe):
 *    Latin-only requests render with the base-14 Helvetica family and
 *    embed NOTHING; any Devanagari (or ₹) run switches to the embedded
 *    Noto Sans Devanagari for exactly those runs;
 *  - display-space geometry: the user places spots on the RENDERED page
 *    (pdf.js orientation, y down). displayRectToUser is the exact inverse
 *    of fill-out-pdf's userRectToDisplay for /Rotate 0/90/180/270 (both
 *    directions are round-trip-locked in the smoke) plus the MediaBox
 *    origin offset pdf.js viewports apply;
 *  - parseRequestRun: full defensive coercion at the worker boundary
 *    (parseFormDoc precedent — tampered payloads never crash the run);
 *  - buildRequestText + mailtoHref: the on-device note and the mail
 *    draft. The mailto opens the USER'S OWN mail client; browsers cannot
 *    attach files to a mail program, so the note says plainly that the
 *    pack must be attached by hand.
 *
 * No pdf-lib here (except types) — geometry, parsing and text building are
 * pure so the smoke drives them directly. Nothing in this file touches the
 * network; nothing is ever uploaded (mode D).
 */

import type {
  RequestDetails,
  RequestPackRun,
  SignatureSpot,
} from "./types";

/* ------------------------------------------------------------------ */
/* Constants                                                            */
/* ------------------------------------------------------------------ */

/** Default sign-here box size in DISPLAY points. */
export const SPOT_W_PT = 170;
export const SPOT_H_PT = 46;
/** Keep the box this far inside the displayed page edges. */
export const SPOT_PAD_PT = 4;
/** Honest cap — more than 12 signature spots on one document is a workflow
 *  problem, not a PDF problem. */
export const MAX_SPOTS = 12;

/** Field-length caps (chars) for every request detail. */
export const MAX_NAME_CHARS = 80;
export const MAX_EMAIL_CHARS = 120;
export const MAX_SUBJECT_CHARS = 120;
export const MAX_MESSAGE_CHARS = 1200;
export const MAX_DATE_CHARS = 10;

/* ------------------------------------------------------------------ */
/* The WinAnsi-vs-Noto rule (xml-invoice-to-pdf recipe)                */
/* ------------------------------------------------------------------ */

/** CP1252's 0x80-0x9F punctuation block (typed literally). */
const WINANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

export function isWinAnsiChar(code: number): boolean {
  if (code >= 0x20 && code <= 0x7e) return true;
  if (code >= 0xa0 && code <= 0xff) return true;
  return WINANSI_EXTRA.has(code);
}

/**
 * True when a code point is covered by the Noto Sans Devanagari face but
 * NOT by WinAnsi: the Devanagari block, the U+20B9 rupee sign and the
 * ZWJ/ZWNJ joiners (zero-width, but they must ride the Noto run).
 */
export function needsNotoChar(code: number): boolean {
  return (
    (code >= 0x0900 && code <= 0x097f) ||
    code === 0x20b9 ||
    code === 0x200c ||
    code === 0x200d
  );
}

/** Does this string contain a run that must be drawn with Noto? */
export function needsNoto(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (!isWinAnsiChar(c) && needsNotoChar(c)) return true;
  }
  return false;
}

/**
 * Keeps what the chosen font set can actually encode. WinAnsi always
 * survives; Devanagari survives only when the Noto face is embedded
 * (`allowNoto` — the worker decides from the whole run's content); every
 * other script honestly becomes "?" (we embed no CJK/Arabic face, and a
 * silent drop would be a lie).
 */
export function sanitizeText(s: string, allowNoto: boolean): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\n" || ch === "\t" || ch === " ") {
      out += ch;
    } else if (isWinAnsiChar(code)) {
      out += ch;
    } else if (allowNoto && needsNotoChar(code)) {
      out += ch;
    } else {
      out += "?";
    }
  }
  return out;
}

export interface TextRun {
  text: string;
  /** true → must be drawn with the Devanagari face. */
  deva: boolean;
}

/** Splits a string into WinAnsi / Devanagari runs (mixed EN+हिंदी in one
 *  line renders with both faces — the create-invoice precedent). */
export function splitTextRuns(s: string): TextRun[] {
  const runs: TextRun[] = [];
  let cur = "";
  let curDeva = false;
  let started = false;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    const deva = !isWinAnsiChar(code) && needsNotoChar(code);
    if (!started) {
      cur = ch;
      curDeva = deva;
      started = true;
    } else if (deva === curDeva) {
      cur += ch;
    } else {
      runs.push({ text: cur, deva: curDeva });
      cur = ch;
      curDeva = deva;
    }
  }
  if (started) runs.push({ text: cur, deva: curDeva });
  return runs;
}

/* ------------------------------------------------------------------ */
/* Display-space geometry                                               */
/* ------------------------------------------------------------------ */

export function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/** Display-space page size (rotation applied) — fill-out-pdf precedent. */
export function displaySize(
  rotation: number,
  userW: number,
  userH: number
): { w: number; h: number } {
  return rotation === 90 || rotation === 270
    ? { w: userH, h: userW }
    : { w: userW, h: userH };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The EXACT inverse of fill-out-pdf's userRectToDisplay (pdf.js viewport
 * math for /Rotate 0/90/180/270): maps a box the user SAW on the rendered
 * page (display points, y down, top-left origin) back to PDF user space
 * (points, y up) on the un-rotated page. `ox`/`oy` shift by the MediaBox
 * origin — pdf.js viewports anchor display (0,0) at the box origin, so a
 * [10 10 400 800] MediaBox needs +10/+10 here.
 */
export function displayRectToUser(
  rect: { left: number; top: number; w: number; h: number },
  rotation: number,
  userW: number,
  userH: number,
  ox = 0,
  oy = 0
): Rect {
  const { left, top } = rect;
  const w = rect.w;
  const h = rect.h;
  let out: Rect;
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      out = { x: top, y: left, w: h, h: w };
      break;
    case 180:
      out = { x: userW - left - w, y: top, w, h };
      break;
    case 270:
      out = { x: userW - top - h, y: userH - left - w, w: h, h: w };
      break;
    default:
      out = { x: left, y: userH - top - h, w, h };
  }
  return { x: out.x + ox, y: out.y + oy, w: out.w, h: out.h };
}

/**
 * The display-space rect for a spot: the default box size (clamped to the
 * page) centred at the spot's percents, then nudged inside the page edges.
 */
export function spotDisplayRect(
  spot: SignatureSpot,
  dispW: number,
  dispH: number
): { left: number; top: number; w: number; h: number } {
  const w = Math.min(SPOT_W_PT, Math.max(24, dispW - 2 * SPOT_PAD_PT));
  const h = Math.min(SPOT_H_PT, Math.max(14, dispH - 2 * SPOT_PAD_PT));
  const left = clamp(spot.x * dispW - w / 2, SPOT_PAD_PT, dispW - w - SPOT_PAD_PT);
  const top = clamp(spot.y * dispH - h / 2, SPOT_PAD_PT, dispH - h - SPOT_PAD_PT);
  return { left, top, w, h };
}

/* ------------------------------------------------------------------ */
/* Details helpers                                                      */
/* ------------------------------------------------------------------ */

/** Light RFC-ish email sniff — enough to decide a mailto: is worth opening. */
export function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());
}

/** yyyy-mm-dd → dd/mm/yyyy (the fill-out-pdf date norm); other input passes
 *  through untouched so users can type their own format in the note. */
export function formatDueDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return iso.trim();
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** {name} placeholder fill for label templates. */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : whole
  );
}

/* ------------------------------------------------------------------ */
/* Run payload parsing (worker boundary)                                */
/* ------------------------------------------------------------------ */

export type ParsedRun =
  | { ok: true; run: RequestPackRun }
  | { ok: false; code: string };

function coerceStr(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  // Collapse CRLF + control chars (keep \n and \t), cap the length.
  const cleaned = v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  return cleaned.slice(0, max);
}

function coerceSpot(v: unknown, pageCount: number): SignatureSpot | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const page = Math.round(Number(o.page));
  if (!Number.isFinite(page)) return null;
  const x = Number(o.x);
  const y = Number(o.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const last = Math.max(0, pageCount - 1);
  return {
    page: clamp(Math.trunc(page), 0, last),
    x: clamp01(x),
    y: clamp01(y),
  };
}

/**
 * Parses + fully coerces the `options.request` payload. Tampered payloads
 * degrade to honest defaults; a run with zero usable spots is rejected
 * ("reqsig.errNoSpots") — one signature spot is the honest minimum.
 */
export function parseRequestRun(raw: unknown, pageCount: number): ParsedRun {
  let parsed: unknown;
  if (typeof raw === "string" && raw.length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }
  } else {
    parsed = raw;
  }
  const o =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};

  const d = (typeof o.details === "object" && o.details !== null
    ? o.details
    : {}) as Record<string, unknown>;
  const details: RequestDetails = {
    recipientName: coerceStr(d.recipientName, MAX_NAME_CHARS).trim(),
    senderName: coerceStr(d.senderName, MAX_NAME_CHARS).trim(),
    recipientEmail: coerceStr(d.recipientEmail, MAX_EMAIL_CHARS).trim(),
    subject: coerceStr(d.subject, MAX_SUBJECT_CHARS).trim(),
    message: coerceStr(d.message, MAX_MESSAGE_CHARS).trim(),
    dueDate: coerceStr(d.dueDate, MAX_DATE_CHARS).trim(),
  };

  const labels: Record<string, string> = {};
  if (typeof o.labels === "object" && o.labels !== null) {
    for (const [k, v] of Object.entries(o.labels as Record<string, unknown>)) {
      // Key cap: real note-label keys are short (reqsig.* ≤ 20 chars —
      // NOTE_KEYS); the {1,57} quantifier drops the junk keys a tampered
      // payload may carry (parseRequestRun's defensive-coercion contract).
      if (/^reqsig\.[A-Za-z0-9]{1,57}$/.test(k) && typeof v === "string") {
        labels[k] = v.slice(0, 240);
      }
    }
  }

  const spots: SignatureSpot[] = [];
  if (Array.isArray(o.spots)) {
    const seen = new Set<string>();
    for (const item of o.spots) {
      if (spots.length >= MAX_SPOTS) break;
      const spot = coerceSpot(item, pageCount);
      if (spot === null) continue;
      const key = `${spot.page}:${spot.x.toFixed(4)}:${spot.y.toFixed(4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      spots.push(spot);
    }
  }

  if (spots.length === 0) return { ok: false, code: "reqsig.errNoSpots" };

  return {
    ok: true,
    run: {
      locale: o.locale === "hi" ? "hi" : "en",
      details,
      spots,
      labels,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Note labels (worker-side EN fallback; the surface ships localized)   */
/* ------------------------------------------------------------------ */

/** Every label key the note builders (txt + PDF) and the box painter use.
 *  (Deliberately NOT how1/how2 — those are the landing "How it works"
 *  steps in the shared catalog; the note instructions get their own keys.) */
export const NOTE_KEYS = [
  "title", "for", "from", "due", "subject", "message",
  "document", "spotsTitle", "spotLine", "whereLeft", "whereTop",
  "howTitle", "howStep1", "howStep2", "boxLabel", "forLabel", "dueLabel",
  "mailSubject", "mailGreeting", "mailAttach", "mailBy", "privacy",
] as const;

export const NOTE_LABELS_EN: Record<(typeof NOTE_KEYS)[number], string> = {
  title: "Signature request",
  for: "To",
  from: "From",
  due: "Sign by",
  subject: "Subject",
  message: "Message",
  document: "Document",
  spotsTitle: "Where to sign",
  spotLine: "Spot {n}: page {p}",
  whereLeft: "from left",
  whereTop: "from top",
  howTitle: "How to sign",
  howStep1: "Open the prepared PDF in any PDF signer - Adobe Acrobat Reader, your browser, or macOS Preview.",
  howStep2: "Click a numbered box and draw your signature. The file carries real signature fields; nothing is sent to a server.",
  boxLabel: "Sign here",
  forLabel: "For:",
  dueLabel: "Due:",
  mailSubject: "Please sign: {file}",
  mailGreeting: "Hello {name},",
  mailAttach: "I have attached the PDF ({file}). Please open it and sign in the numbered boxes.",
  mailBy: "By {date} please.",
  privacy: "Prepared on your device - no file was uploaded.",
};

/** Localized label with the EN fallback (validate-e-invoice recipe). */
export function labelOf(run: RequestPackRun, key: (typeof NOTE_KEYS)[number]): string {
  const hit = run.labels[`reqsig.${key}`];
  return typeof hit === "string" && hit.length > 0 ? hit : NOTE_LABELS_EN[key];
}

/* ------------------------------------------------------------------ */
/* Note text builders                                                   */
/* ------------------------------------------------------------------ */

/** Greedy char wrap for the plain-text note (78 cols, the mail norm). */
export function wrapChars(text: string, maxCols: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line === "" ? word : `${line} ${word}`;
      if (candidate.length <= maxCols) {
        line = candidate;
      } else {
        if (line !== "") out.push(line);
        if (word.length <= maxCols) {
          line = word;
        } else {
          // Hard-break monster words.
          for (let i = 0; i < word.length; i += maxCols) {
            const chunk = word.slice(i, i + maxCols);
            if (i + maxCols >= word.length) {
              line = chunk;
            } else {
              out.push(chunk);
            }
          }
        }
      }
    }
    if (line !== "") out.push(line);
  }
  return out;
}

/**
 * buildRequestText — the deterministic plain-text request note (same content
 * as the PDF note; byte-identical for the same input, no timestamps).
 */
export function buildRequestText(run: RequestPackRun, fileName: string): string {
  const d = run.details;
  const lines: string[] = [];
  const subject = d.subject !== "" ? d.subject : labelOf(run, "title");
  lines.push(subject);
  lines.push("");
  if (d.recipientName !== "") lines.push(`${labelOf(run, "for")}: ${d.recipientName}`);
  if (d.senderName !== "") lines.push(`${labelOf(run, "from")}: ${d.senderName}`);
  if (d.dueDate !== "") {
    lines.push(`${labelOf(run, "due")}: ${formatDueDate(d.dueDate)}`);
  }
  lines.push(`${labelOf(run, "document")}: ${fileName}`);
  if (d.message !== "") {
    lines.push("");
    lines.push(...wrapChars(d.message, 78));
  }
  lines.push("");
  lines.push(`${labelOf(run, "spotsTitle")}:`);
  run.spots.forEach((spot, i) => {
    lines.push(
      `${i + 1}. ${fill(labelOf(run, "spotLine"), { n: String(i + 1), p: String(spot.page + 1) })}` +
        ` - ${Math.round(spot.x * 100)}% ${labelOf(run, "whereLeft")}, ${Math.round(spot.y * 100)}% ${labelOf(run, "whereTop")}`
    );
  });
  lines.push("");
  lines.push(`${labelOf(run, "howTitle")}:`);
  lines.push(...wrapChars(labelOf(run, "howStep1"), 78));
  lines.push(...wrapChars(labelOf(run, "howStep2"), 78));
  lines.push("");
  lines.push(labelOf(run, "privacy"));
  return `${lines.join("\n")}\n`;
}

/**
 * mailtoHref — the user's own mail client opens with subject + body
 * pre-filled. Returns "" when no usable address was given (the surface then
 * hides the button honestly). NOTE: browsers cannot attach files to a mail
 * program — the body says the pack must be attached by hand.
 */
export function mailtoHref(run: RequestPackRun, fileName: string): string {
  const email = run.details.recipientEmail.trim();
  if (!isValidEmail(email)) return "";
  const d = run.details;
  const subject =
    d.subject !== "" ? d.subject : fill(labelOf(run, "mailSubject"), { file: fileName });
  const body: string[] = [];
  if (d.recipientName !== "") {
    body.push(fill(labelOf(run, "mailGreeting"), { name: d.recipientName }));
    body.push("");
  }
  if (d.message !== "") body.push(d.message);
  if (d.dueDate !== "") body.push(fill(labelOf(run, "mailBy"), { date: formatDueDate(d.dueDate) }));
  body.push(fill(labelOf(run, "mailAttach"), { file: fileName }));
  body.push(labelOf(run, "privacy"));
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.join("\n\n"))}`;
}

/* ------------------------------------------------------------------ */
/* Names                                                                */
/* ------------------------------------------------------------------ */

/** Strips path separators + unsafe chars from a download display name. */
export function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

/**
 * The /T names for the created signature fields: SignHere_1..N, made
 * unique against the document's EXISTING field names (a collision would
 * break signing in Acrobat, which addresses fields by name).
 */
export function sigFieldNames(count: number, existing: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const base = `SignHere_${i}`;
    if (!existing.has(base)) {
      out.push(base);
      continue;
    }
    for (let n = 2; n < 1000; n += 1) {
      const candidate = `${base}_${n}`;
      if (!existing.has(candidate)) {
        out.push(candidate);
        break;
      }
    }
  }
  return out;
}
