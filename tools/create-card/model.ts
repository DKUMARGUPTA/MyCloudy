/**
 * Card maker shared model (PRD §"Card" — the 63rd tool) — PURE data +
 * math used by the surface (live preview), the worker (PDF/JPG/PNG
 * export) and the smoke script, so what you preview is exactly what
 * prints. No platform API is touched here; every text-layout routine
 * takes an injected `measure` function so the battery can verify the
 * math with a fake measurer.
 *
 * ── FOLD MODEL (fold-a4) ────────────────────────────────────────────
 * One A4 LANDSCAPE sheet (297×210 mm) per printed side, folded once at
 * the vertical centre → the folded card is A5-portrait-sized. The PDF
 * has TWO pages per card:
 *   Page 1 OUTSIDE — LEFT half = back cover, RIGHT half = front cover.
 *   Page 2 INSIDE  — LEFT half = inside-left (date/venue panel),
 *                    RIGHT half = inside-right (the main message panel,
 *                    i.e. the back of the front cover).
 * Printing advice given in the FAQ (honest): print page 1, re-insert
 * the sheet to print page 2 on the blank side in the same orientation,
 * then fold at the middle line — and do a TEST PRINT first. Which
 * duplex flip mode a printer needs (long-edge vs short-edge) varies by
 * model, so this tool deliberately does NOT assume one.
 * The fold line is exactly W/2 and both halves cover the full sheet
 * (smoke asserts this).
 *
 * ── TEXT-RESET RULES (standard card-maker behaviour) ─────────────────
 * Switching TEMPLATE resets every text field to the new template's
 * defaults for the CURRENT text locale (tracked when the texts were
 * last set — Canva-like). Switching the UI LANGUAGE never touches
 * typed texts; it only re-serializes the option (the output file name
 * is localized). Both rules live in the surface; documented here so
 * the model and the UI agree.
 */

import type { L10n } from "@/lib/tools/registry";

/* --------------------------- exact geometry --------------------------- */

/** mm → PDF points, exact factor. */
export const PT_PER_MM = 72 / 25.4;

/** Worker/export canvases render at 2 px per PDF point (collage policy). */
export const PX_PER_PT = 2;

export type CardFormat = "flat-a6" | "flat-a5" | "flat-4x6" | "fold-a4";
export type CardOrientation = "portrait" | "landscape";
export type ExportFormat = "pdf" | "jpg" | "png";

/** Trim sizes in mm. fold-a4 is the A4 LANDSCAPE sheet, folded once. */
export const FORMAT_MM: Record<CardFormat, [w: number, h: number]> = {
  "flat-a6": [105, 148],
  "flat-a5": [148, 210],
  "flat-4x6": [101.6, 152.4],
  "fold-a4": [297, 210],
};

export const CARD_FORMATS = ["flat-a6", "flat-a5", "flat-4x6", "fold-a4"] as const;
export const CARD_ORIENTATIONS = ["portrait", "landscape"] as const;
export const EXPORT_FORMATS = ["pdf", "jpg", "png"] as const;

export interface SizePt {
  w: number;
  h: number;
}

/**
 * Page size in PDF points. fold-a4 is ALWAYS the landscape sheet
 * (297×210 mm) — orientation only matters for the flat formats.
 */
export function pagePtSize(
  format: CardFormat,
  orientation: CardOrientation
): SizePt {
  const [mmW, mmH] = FORMAT_MM[format];
  const ptW = mmW * PT_PER_MM;
  const ptH = mmH * PT_PER_MM;
  const swap = format !== "fold-a4" && orientation === "landscape";
  return swap ? { w: ptH, h: ptW } : { w: ptW, h: ptH };
}

/** Worker/export canvas size in pixels (pt × PX_PER_PT, rounded). */
export function pagePixelSize(
  format: CardFormat,
  orientation: CardOrientation
): { w: number; h: number } {
  const pt = pagePtSize(format, orientation);
  return {
    w: Math.round(pt.w * PX_PER_PT),
    h: Math.round(pt.h * PX_PER_PT),
  };
}

/* ------------------------------ sheets ------------------------------ */

export type SheetKind = "flat" | "fold-outside" | "fold-inside";

export interface CardSheet {
  kind: SheetKind;
  /** 0-based mail-merge row this sheet belongs to. */
  rowIndex: number;
}

/**
 * Sheets of one export, in print order. Flat formats make one sheet
 * per merge row; fold-a4 makes TWO per row (outside then inside).
 * N rows → flat: N sheets / fold: 2N sheets.
 */
export function computeSheets(
  format: CardFormat,
  mergeRows: number
): CardSheet[] {
  const rows = Math.max(1, Math.floor(mergeRows));
  const sheets: CardSheet[] = [];
  for (let row = 0; row < rows; row += 1) {
    if (format === "fold-a4") {
      sheets.push({ kind: "fold-outside", rowIndex: row });
      sheets.push({ kind: "fold-inside", rowIndex: row });
    } else {
      sheets.push({ kind: "flat", rowIndex: row });
    }
  }
  return sheets;
}

export interface RectPt {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Panels of one printed sheet in PDF points. Folded sheets are EXACT
 * halves: the fold line sits at W/2 and both halves cover the full
 * sheet height. Panel order matches the fold model above:
 *   fold-outside → [back (left), front (right)]
 *   fold-inside  → [inside-left, inside-right]
 *   flat         → [whole page]
 */
export function sheetPanelsPt(
  format: CardFormat,
  orientation: CardOrientation,
  kind: SheetKind
): RectPt[] {
  const { w, h } = pagePtSize(format, orientation);
  if (kind === "flat") return [{ x: 0, y: 0, w, h }];
  const half = w / 2;
  return [
    { x: 0, y: 0, w: half, h },
    { x: half, y: 0, w: half, h },
  ];
}

/* ----------------------------- templates ----------------------------- */

export interface CardTexts {
  /** "To" line (the recipient). */
  to: string;
  headline: string;
  sub: string;
  message: string;
  /** Date / venue line (invitations, greetings). */
  venue: string;
  from: string;
}

/** Validation order for unknown CSV columns (order-stable). */
export const TEXT_FIELD_ORDER = [
  "to",
  "headline",
  "sub",
  "message",
  "venue",
  "from",
] as const;

/** Per-field character budgets (clamped in the sanitizer). */
export const TEXT_FIELD_LIMITS: Record<keyof CardTexts, number> = {
  to: 80,
  headline: 80,
  sub: 160,
  message: 800,
  venue: 160,
  from: 80,
};

export interface CardTemplate {
  id: string;
  label: L10n;
  /** Same-origin background JPEG ("/card-templates/<id>.jpg"); null = blank. */
  bg: string | null;
  /** Text colour drawn over the background (Devanagari-safe contrast). */
  ink: string;
  /** Accent colour for muted lines and decorative rules. */
  accent: string;
  /** Gradient fallback colours when the background image fails to load. */
  palette: [string, string];
  defaults: { en: CardTexts; hi: CardTexts };
}

/**
 * Eight templates — seven festival/occasion designs (self-hosted JPEG
 * backgrounds, 864×1152, text-safe plain centres) + a blank card where
 * the user picks a background colour. Default texts exist in BOTH
 * locales for EVERY field (smoke asserts).
 */
export const TEMPLATES: CardTemplate[] = [
  {
    id: "diwali",
    label: { en: "Diwali", hi: "दीपावली" },
    bg: "/card-templates/diwali.jpg",
    ink: "#fdeed3",
    accent: "#f5c462",
    palette: ["#7c241c", "#e8a13a"],
    defaults: {
      en: {
        to: "For: Aunty Meera",
        headline: "Happy Diwali",
        sub: "Warm wishes for a bright and beautiful year",
        message:
          "May this Diwali light up your home with joy, health and prosperity. Wishing you and your family a sparkling festival season!",
        venue: "Diwali night · 7 pm",
        from: "With love, the Sharmas",
      },
      hi: {
        to: "मीरा चाची के लिए",
        headline: "शुभ दीपावली",
        sub: "ढेर सारी शुभकामनाएँ",
        message:
          "यह दीपावली आपके घर ख़ुशियों, सेहत और समृद्धि का दीप जलाए। आपके परिवार को दीपों की रोशनी जैसा चमकता उत्सव हो!",
        venue: "दीपावली रात · सात बजे",
        from: "प्रेम सहित, शर्मा परिवार",
      },
    },
  },
  {
    id: "holi",
    label: { en: "Holi", hi: "होली" },
    bg: "/card-templates/holi.jpg",
    ink: "#4a3230",
    accent: "#c2477c",
    palette: ["#f5e9dc", "#d98ca6"],
    defaults: {
      en: {
        to: "For: Riya and Aarav",
        headline: "Happy Holi",
        sub: "A splash of colours and sweet moments",
        message:
          "May your life be as colourful and joyful as this festival. Have a wonderful Holi filled with laughter, gujiya and happy memories!",
        venue: "Holi brunch · 11 am",
        from: "With love, Neha",
      },
      hi: {
        to: "रिया और आरव के लिए",
        headline: "शुभ होली",
        sub: "रंगों और मीठी यादों से भरा त्योहार",
        message:
          "आपका जीवन इस त्योहार की तरह रंगीन और ख़ुशनुमा रहे। हँसी, गुजिया और मीठी यादों भरी होली हो!",
        venue: "होली ब्रंच · सुबह ग्यारह बजे",
        from: "प्रेम सहित, नेहा",
      },
    },
  },
  {
    id: "rakhi",
    label: { en: "Raksha Bandhan", hi: "रक्षा बंधन" },
    bg: "/card-templates/rakhi.jpg",
    ink: "#5b2f14",
    accent: "#a34524",
    palette: ["#ead2a8", "#b8542f"],
    defaults: {
      en: {
        to: "For: my dear brother",
        headline: "Happy Raksha Bandhan",
        sub: "A thread of love and protection",
        message:
          "Thank you for being my first friend and forever protector. Missing you today — see you soon!",
        venue: "Rakhi lunch · 1 pm",
        from: "With love, your sister",
      },
      hi: {
        to: "मेरे प्यारे भैया के लिए",
        headline: "शुभ रक्षा बंधन",
        sub: "प्रेम और वचन की डोर",
        message:
          "मेरे पहले मित्र और हमेशा के रखवाले होने के लिए धन्यवाद। आज तुम्हें बहुत याद कर रही हूँ — जल्दी मिलते हैं!",
        venue: "रक्षा बंधन भोजन · दोपहर एक बजे",
        from: "प्रेम सहित, तुम्हारी बहन",
      },
    },
  },
  {
    id: "newyear",
    label: { en: "New Year", hi: "नया साल" },
    bg: "/card-templates/newyear.jpg",
    ink: "#f2ecdf",
    accent: "#d9b64a",
    palette: ["#2e2a52", "#a08fd9"],
    defaults: {
      en: {
        to: "For: the whole team",
        headline: "Happy New Year",
        sub: "New dreams, new plans, same warm wishes",
        message:
          "Wishing you 12 months of success, 52 weekends of rest and 365 days of joy. Happy New Year!",
        venue: "January 1",
        from: "Best wishes, Aditi",
      },
      hi: {
        to: "पूरी टीम के लिए",
        headline: "शुभ नव वर्ष",
        sub: "नए सपने, नई योजनाएँ, वही दिल से शुभकामनाएँ",
        message:
          "आपके 12 महीने सफलता से, 52 वीकेंड आराम से और 365 दिन ख़ुशियों से भरें। नए साल की शुभकामनाएँ!",
        venue: "1 जनवरी",
        from: "शुभकामनाएँ, अदिति",
      },
    },
  },
  {
    id: "birthday",
    label: { en: "Birthday", hi: "जन्मदिन" },
    bg: "/card-templates/birthday.jpg",
    ink: "#46294f",
    accent: "#d6543f",
    palette: ["#fdf6ec", "#f2b84b"],
    defaults: {
      en: {
        to: "For: Kabir",
        headline: "Happy Birthday",
        sub: "Another trip around the sun",
        message:
          "May your day be full of cake, laughter and everything you love. Here's to your best year yet!",
        venue: "Cake time · 6 pm",
        from: "With love, everyone",
      },
      hi: {
        to: "कबीर के लिए",
        headline: "जन्मदिन मुबारक",
        sub: "सूरज की एक और चक्कर पूरी!",
        message:
          "आपका दिन केक, हँसी और आपकी पसंद की हर चीज़ से भरा रहे। आपके लिए अब तक का सबसे अच्छा साल हो!",
        venue: "केक कटाई · शाम छह बजे",
        from: "प्रेम सहित, सबकी ओर से",
      },
    },
  },
  {
    id: "wedding",
    label: { en: "Wedding", hi: "शादी" },
    bg: "/card-templates/wedding.jpg",
    ink: "#59422c",
    accent: "#96682f",
    palette: ["#f4ead9", "#d9b98a"],
    defaults: {
      en: {
        to: "Together with our families",
        headline: "Wedding Invitation",
        sub: "Anisha weds Rohan",
        message:
          "We joyfully invite you to celebrate our wedding day with your blessings, laughter and dance.",
        venue: "Sunday, 24 November · 7 pm\nRose Garden, Pune",
        from: "With love, Anisha & Rohan",
      },
      hi: {
        to: "हमारे परिवारों सहित",
        headline: "विवाह निमंत्रण",
        sub: "अनीशा का विवाह रोहन से",
        message:
          "हम आपको अपने विवाह के पवित्र अवसर पर आशीर्वाद, हँसी और नाच के साथ शामिल होने का निमंत्रण देते हैं।",
        venue: "रविवार, 24 नवंबर · शाम 7 बजे\nरोज़ गार्डन, पुणे",
        from: "प्रेम सहित, अनीशा और रोहन",
      },
    },
  },
  {
    id: "thankyou",
    label: { en: "Thank you", hi: "धन्यवाद" },
    bg: "/card-templates/thankyou.jpg",
    ink: "#3d3025",
    accent: "#8f5f3c",
    palette: ["#efe4d5", "#cfa97f"],
    defaults: {
      en: {
        to: "For: Meera aunty",
        headline: "Thank You",
        sub: "From our home to yours",
        message:
          "Thank you for your warm help and kindness — it meant the world to us. We hope to see you soon!",
        venue: "12 October · Pune",
        from: "With gratitude, the Vermas",
      },
      hi: {
        to: "मीरा चाची के लिए",
        headline: "धन्यवाद",
        sub: "हमारे घर से आपके घर तक",
        message:
          "आपके स्नेह और मदद के लिए दिल से धन्यवाद — इसका हमें बहुत महत्व है। जल्दी मिलने की उम्मीद है!",
        venue: "12 अक्टूबर · पुणे",
        from: "कृतज्ञता सहित, वर्मा परिवार",
      },
    },
  },
  {
    id: "blank",
    label: { en: "Blank", hi: "ख़ाली" },
    bg: null,
    ink: "#1c1917",
    accent: "#a8a29e",
    palette: ["#ffffff", "#f5f1ea"],
    defaults: {
      en: {
        to: "For: someone special",
        headline: "Hello",
        sub: "Write your own card",
        message:
          "Pick a blank card and write exactly what you feel — in English or Hindi.",
        venue: "Any day, any place",
        from: "— you",
      },
      hi: {
        to: "किसी ख़ास के लिए",
        headline: "नमस्ते",
        sub: "अपना कार्ड ख़ुद लिखें",
        message: "ख़ाली कार्ड चुनें और जो मन में है वही लिखें — अंग्रेज़ी या हिंदी में।",
        venue: "कोई भी दिन, कोई भी जगह",
        from: "— आप",
      },
    },
  },
];

const TEMPLATE_BY_ID = new Map<string, CardTemplate>(
  TEMPLATES.map((template) => [template.id, template])
);

export const DEFAULT_TEMPLATE_ID = "diwali";

/** Safe lookup — unknown ids fall back to the default template. */
export function templateById(id: string): CardTemplate {
  return (
    TEMPLATE_BY_ID.get(id) ??
    (TEMPLATE_BY_ID.get(DEFAULT_TEMPLATE_ID) as CardTemplate)
  );
}

export function isTemplateId(id: string): boolean {
  return TEMPLATE_BY_ID.has(id);
}

/** Default texts of a template for one locale (fresh object every call). */
export function defaultTextsFor(
  templateId: string,
  locale: "en" | "hi"
): CardTexts {
  return { ...templateById(templateId).defaults[locale] };
}

/* ------------------------------ colours ------------------------------ */

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** #rrggbb or the fallback (soft warm paper tone). */
export function sanitizeHexColor(value: unknown, fallback = "#f5f1ea"): string {
  return typeof value === "string" && HEX_RE.test(value.trim())
    ? value.trim().toLowerCase()
    : fallback;
}

/** Perceived luminance 0..1. */
export function hexLuminance(hex: string): number {
  const clean = sanitizeHexColor(hex, "#ffffff").slice(1);
  const r = Number.parseInt(clean.slice(0, 2), 16) / 255;
  const g = Number.parseInt(clean.slice(2, 4), 16) / 255;
  const b = Number.parseInt(clean.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Dark ink on light backgrounds, light ink on dark ones (blank cards). */
export function inkHex(background: string): string {
  return hexLuminance(background) > 0.55 ? "#1c1917" : "#faf9f7";
}

/** Preset swatches for the blank template (warm, no indigo/blue). */
export const BLANK_BACKGROUNDS: { hex: string; label: L10n }[] = [
  { hex: "#ffffff", label: { en: "White", hi: "सफ़ेद" } },
  { hex: "#f5f1ea", label: { en: "Soft paper", hi: "हल्का काग़ज़" } },
  { hex: "#7c241c", label: { en: "Deep red", hi: "गहरा लाल" } },
  { hex: "#3f6212", label: { en: "Leaf green", hi: "पत्ता हरा" } },
  { hex: "#1c1917", label: { en: "Dark", hi: "गहरा" } },
];

/* --------------------------- text wrapping --------------------------- */

/**
 * Word-wraps `text` to `maxWidth` using an injected measure function
 * (PURE — the smoke verifies it with a fake measurer).
 *
 * Rules:
 *  - Splits on "\n" first: an explicit newline is always a hard break.
 *  - Each paragraph wraps by spaces (runs of spaces collapse to one).
 *  - A word wider than the line breaks CHARACTER-WISE (Devanagari text
 *    often contains long unbroken strings); only a single character
 *    wider than the whole line is ever emitted over width.
 *  - Trailing whitespace is trimmed per emitted line.
 *  - Whitespace-only text → zero lines. Blank paragraphs at the very
 *    start/end are dropped; blank paragraphs BETWEEN text are kept as
 *    one empty line (a deliberate blank line).
 */
export function wrapText(
  text: string,
  maxWidth: number,
  measure: (t: string) => number
): string[] {
  if (typeof text !== "string" || text.trim() === "") return [];
  if (!(maxWidth > 0)) return [];
  const paragraphs = text.split("\n");
  let start = 0;
  let end = paragraphs.length - 1;
  while (start <= end && paragraphs[start].trim() === "") start += 1;
  while (end >= start && paragraphs[end].trim() === "") end -= 1;
  const lines: string[] = [];
  for (let i = start; i <= end; i += 1) {
    const paragraph = paragraphs[i];
    if (paragraph.trim() === "") {
      lines.push("");
      continue;
    }
    lines.push(...wrapParagraph(paragraph, maxWidth, measure));
  }
  return lines;
}

function wrapParagraph(
  paragraph: string,
  maxWidth: number,
  measure: (t: string) => number
): string[] {
  const words = paragraph.split(" ").filter((word) => word !== "");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (measure(candidate) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line !== "") {
      lines.push(line);
      line = "";
    }
    if (measure(word) <= maxWidth) {
      line = word;
      continue;
    }
    // Character-break the over-long word; every chunk except the last
    // becomes its own (full) line, the last stays open for more words.
    const chunks = breakWord(word, maxWidth, measure);
    for (let c = 0; c < chunks.length - 1; c += 1) lines.push(chunks[c]);
    line = chunks[chunks.length - 1] ?? "";
  }
  if (line !== "") lines.push(line);
  return lines;
}

function breakWord(
  word: string,
  maxWidth: number,
  measure: (t: string) => number
): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const char of [...word]) {
    const next = chunk + char;
    if (chunk !== "" && measure(next) > maxWidth) {
      chunks.push(chunk);
      chunk = char;
    } else {
      chunk = next;
    }
  }
  if (chunk !== "") chunks.push(chunk);
  return chunks;
}

/**
 * Longest prefix of `text` + "…" that fits `maxWidth` (binary search).
 * "" → ""; nothing fits → the bare ellipsis.
 */
export function truncateWithEllipsis(
  text: string,
  maxWidth: number,
  measure: (t: string) => number
): string {
  if (text === "") return "";
  if (measure(`${text}\u2026`) <= maxWidth) return `${text}\u2026`;
  const chars = [...text];
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(`${chars.slice(0, mid).join("")}\u2026`) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${chars.slice(0, lo).join("")}\u2026`;
}

/* ------------------------- headline shrink-to-fit ------------------------- */

export interface HeadlineFit {
  /** The chosen font size in pt. */
  sizePt: number;
  /** Wrapped lines at that size (ALL of them — never truncated). */
  lines: string[];
  /** True when even the minimum size does not fit. */
  overflowed: boolean;
}

export interface HeadlineOptions {
  baseSizePt: number;
  minSizePt: number;
  /** Deterministic step-down (default 2). */
  stepPt: number;
  maxWidthPt: number;
  maxLines: number;
  lineHeightRatio: number;
  maxHeightPt: number;
}

/**
 * Headline shrink-to-fit: start at the template's base size, step down
 * by `stepPt` (−2pt) until the wrapped headline fits the panel within
 * the allowed line count and height budget. Returns the FIRST size
 * that fits. If nothing fits down to the minimum, keeps the minimum
 * size with its full wrap (never truncates silently) and flags
 * `overflowed`. The loop is bounded by an explicit iteration cap, so
 * it always terminates (smoke verifies with a fake measurer).
 */
export function fitHeadline(
  text: string,
  opts: HeadlineOptions,
  measureAt: (t: string, sizePt: number) => number
): HeadlineFit {
  const step = opts.stepPt > 0 ? opts.stepPt : 2;
  const min = Math.max(1, opts.minSizePt);
  const base = Math.max(min, opts.baseSizePt);
  if (typeof text !== "string" || text.trim() === "") {
    return { sizePt: base, lines: [], overflowed: false };
  }
  const ITERATION_CAP = 512; // (base−min)/step + 1 in practice — hard cap.
  let size = base;
  for (let i = 0; i < ITERATION_CAP; i += 1) {
    const lines = wrapText(text, opts.maxWidthPt, (t) => measureAt(t, size));
    const fits =
      lines.length <= opts.maxLines &&
      lines.length * size * opts.lineHeightRatio <= opts.maxHeightPt;
    if (fits) return { sizePt: size, lines, overflowed: false };
    if (size <= min) return { sizePt: min, lines, overflowed: true };
    size = Math.max(min, size - step);
  }
  const lines = wrapText(text, opts.maxWidthPt, (t) => measureAt(t, min));
  return { sizePt: min, lines, overflowed: true };
}

/* ---------------------------- message body ---------------------------- */

export interface MessageLayout {
  lines: string[];
  overflowed: boolean;
}

export interface MessageOptions {
  fontPt: number;
  lineHeightRatio: number;
  maxWidthPt: number;
  maxHeightPt: number;
}

/**
 * Message body at a FIXED size. Wraps freely; when the measured block
 * overflows the panel bottom, the last fitting line gets an ellipsis
 * "…" and `overflowed` flags it (the surface shows an honest badge
 * from the SAME engine's metrics).
 */
export function layoutMessage(
  text: string,
  opts: MessageOptions,
  measureAt: (t: string, sizePt: number) => number
): MessageLayout {
  if (typeof text !== "string" || text.trim() === "") {
    return { lines: [], overflowed: false };
  }
  const measure = (t: string): number => measureAt(t, opts.fontPt);
  const lines = wrapText(text, opts.maxWidthPt, measure);
  const lineH = opts.fontPt * opts.lineHeightRatio;
  const maxLines = Math.max(1, Math.floor(opts.maxHeightPt / lineH));
  if (lines.length <= maxLines) return { lines, overflowed: false };
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = truncateWithEllipsis(
    kept[maxLines - 1] ?? "",
    opts.maxWidthPt,
    measure
  );
  return { lines: kept, overflowed: true };
}

/* ------------------------------ CSV merge ------------------------------ */

export const MAX_CSV_ROWS = 200;
/**
 * 2 MB CSV file cap, measured in characters (a UTF-8 file never has
 * more chars than bytes, so chars > cap ⇔ file > 2 MB for valid UTF-8).
 */
export const CSV_MAX_CHARS = 2 * 1024 * 1024;

export class CsvError extends Error {
  /** i18n error key: card.errorCsvQuote | card.errorCsvRows | card.errorCsvSize. */
  code: string;
  constructor(code: string) {
    super(code);
    this.name = "CsvError";
    this.code = code;
  }
}

export interface ParsedCsv {
  /** First row, EXACTLY as written — case-sensitive, NOT trimmed. */
  columns: string[];
  rows: string[][];
}

/**
 * RFC-4180 CSV parser (PURE):
 *  - quoted fields with embedded commas and newlines; `""` escapes a
 *    literal quote;
 *  - CRLF, LF and lone CR line endings all work;
 *  - a leading UTF-8 BOM is stripped;
 *  - the first record is the header (column names preserved exactly);
 *  - a SINGLE trailing empty line is skipped (more are kept);
 *  - unterminated quote → CsvError("card.errorCsvQuote");
 *  - more than MAX_CSV_ROWS data rows → CsvError("card.errorCsvRows");
 *  - text larger than the 2 MB cap → CsvError("card.errorCsvSize").
 * Header-only / empty input → zero rows = NO merge (single card).
 */
export function parseCsv(text: string): ParsedCsv {
  if (typeof text !== "string") text = "";
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  if (text.length > CSV_MAX_CHARS) {
    throw new CsvError("card.errorCsvSize");
  }
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field === "") {
      inQuotes = true;
      continue;
    }
    if (char === ",") {
      record.push(field);
      field = "";
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      record.push(field);
      field = "";
      records.push(record);
      record = [];
      continue;
    }
    field += char;
  }
  if (inQuotes) throw new CsvError("card.errorCsvQuote");
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  // Skip a single trailing empty line (an empty record with one field).
  if (
    records.length > 0 &&
    records[records.length - 1].length === 1 &&
    records[records.length - 1][0] === ""
  ) {
    records.pop();
  }
  const columns = records[0] ?? [];
  const rows = records.slice(1);
  if (rows.length > MAX_CSV_ROWS) {
    throw new CsvError("card.errorCsvRows");
  }
  return { columns, rows };
}

/**
 * Replaces `{{column}}` placeholders with row values. Exact column
 * name match (case-sensitive). Unknown placeholders and non-matching
 * forms (`{{}}`, `{{ name}}`) are left untouched — they render
 * literally and never crash. Missing row fields become "".
 */
export function mergeText(text: string, row: string[], columns: string[]): string {
  return text.replace(/\{\{([^{}\s]+)\}\}/g, (whole, name: string) => {
    const index = columns.indexOf(name);
    if (index === -1) return whole;
    return row[index] ?? "";
  });
}

/** The effective texts of one merge row (or the base texts). */
export function mergedTextsFor(
  texts: CardTexts,
  row: string[] | null,
  columns: string[]
): CardTexts {
  if (row === null) return texts;
  const merged = {} as CardTexts;
  for (const field of TEXT_FIELD_ORDER) {
    merged[field] = mergeText(texts[field], row, columns);
  }
  return merged;
}

/**
 * Collects ALL unknown `{{column}}` names across every text field, in
 * first-appearance order (field order is TEXT_FIELD_ORDER — stable).
 * Empty result = everything merges cleanly.
 */
export function validatePlaceholders(
  texts: CardTexts,
  columns: string[]
): string[] {
  const unknown: string[] = [];
  const seen = new Set<string>();
  const re = /\{\{([^{}\s]+)\}\}/g;
  for (const field of TEXT_FIELD_ORDER) {
    const value = texts[field];
    if (typeof value !== "string") continue;
    for (const match of value.matchAll(re)) {
      const name = match[1];
      if (!columns.includes(name) && !seen.has(name)) {
        seen.add(name);
        unknown.push(name);
      }
    }
  }
  return unknown;
}

/* ---------------------------- wire format ---------------------------- */

/** The full card recipe. The CSV text + name ride the option (collage pattern). */
export interface CardOption {
  template: string;
  format: CardFormat;
  orientation: CardOrientation;
  texts: CardTexts;
  /** Index into the workspace files (the photo), or null = no photo. */
  photoIndex: number | null;
  /** Blank-template background colour (#rrggbb). */
  background: string;
  csvText: string;
  csvName: string;
  exportFormat: ExportFormat;
  locale: "en" | "hi";
}

export const DEFAULT_CARD_OPTION: CardOption = {
  template: DEFAULT_TEMPLATE_ID,
  format: "flat-a6",
  orientation: "portrait",
  texts: defaultTextsFor(DEFAULT_TEMPLATE_ID, "en"),
  photoIndex: null,
  background: "#ffffff",
  csvText: "",
  csvName: "",
  exportFormat: "pdf",
  locale: "en",
};

/** Keeps control characters out but PRESERVES \n (explicit line breaks). */
function clampTextField(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u0009\u000b-\u001f]/g, "")
    .slice(0, max)
    .trimEnd();
}

function sanitizeTexts(value: unknown): CardTexts {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const texts = {} as CardTexts;
  for (const field of TEXT_FIELD_ORDER) {
    texts[field] = clampTextField(raw[field], TEXT_FIELD_LIMITS[field]);
  }
  return texts;
}

export function serializeCard(option: CardOption): string {
  return JSON.stringify(option);
}

function pickString<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * Parses the "card" option. Garbage JSON → safe defaults; every number
 * is clamped (photoIndex into the file range), every enum falls back,
 * the locale falls back to "en". Structurally invalid data never kills
 * a run — the card always draws.
 */
export function parseCardOption(value: unknown, fileCount: number): CardOption {
  let parsed: unknown = null;
  if (typeof value === "string" && value !== "") {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = null;
    }
  }
  const raw = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  let photoIndex: number | null = null;
  if (
    typeof raw.photoIndex === "number" &&
    Number.isInteger(raw.photoIndex) &&
    fileCount > 0
  ) {
    // Clamp into [0, fileCount): out-of-range indexes land on the
    // nearest photo, never crash the render.
    photoIndex = Math.min(Math.max(raw.photoIndex, 0), fileCount - 1);
  }
  return {
    template: isTemplateId(String(raw.template))
      ? String(raw.template)
      : DEFAULT_TEMPLATE_ID,
    format: pickString(raw.format, CARD_FORMATS, "flat-a6"),
    orientation: pickString(raw.orientation, CARD_ORIENTATIONS, "portrait"),
    texts: sanitizeTexts(raw.texts),
    photoIndex,
    background: sanitizeHexColor(raw.background, "#ffffff"),
    csvText: typeof raw.csvText === "string" ? raw.csvText.slice(0, CSV_MAX_CHARS) : "",
    csvName:
      typeof raw.csvName === "string"
        ? raw.csvName.replace(/[\u0000-\u001f]/g, "").slice(0, 120)
        : "",
    exportFormat: pickString(raw.exportFormat, EXPORT_FORMATS, "pdf"),
    locale: pickString(raw.locale, ["en", "hi"] as const, "en"),
  };
}

/* ------------------------------ cropping ------------------------------ */

export interface CropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * Cover-crop: the largest centred source rect whose aspect matches the
 * destination (collage's exact math — reused so backgrounds and
 * photos crop identically).
 */
export function coverCrop(sw: number, sh: number, dw: number, dh: number): CropRect {
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return { sx: 0, sy: 0, sw: 0, sh: 0 };
  const scale = Math.max(dw / sw, dh / sh);
  const cropW = dw / scale;
  const cropH = dh / scale;
  return {
    sx: (sw - cropW) / 2,
    sy: (sh - cropH) / 2,
    sw: cropW,
    sh: cropH,
  };
}

/* ------------------------------ file names ------------------------------ */

/**
 * Localized output base name. A mail merge with more than one row
 * exports a plural name (cards).
 */
export function outputBaseName(
  locale: "en" | "hi",
  exportFormat: ExportFormat,
  mergeRows: number
): string {
  const base =
    mergeRows > 1 ? (locale === "hi" ? "कार्ड" : "cards") : locale === "hi" ? "कार्ड" : "card";
  return `${base}.${exportFormat}`;
}
