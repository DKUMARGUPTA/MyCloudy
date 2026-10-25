/**
 * Translate PDF (R9-c) — pure, deterministic model shared by the translate
 * worker and scripts/smoke-translate-pdf.ts. No DOM, no network: the
 * language catalog, the batching math and the WinAnsi sanitizer are all
 * plain data functions the smoke can pin.
 *
 * Privacy shape (the honest contract, repeated in the tool's FAQ): the PDF
 * itself NEVER leaves the device. The browser extracts per-page text in a
 * Web Worker, packs it into bounded line batches, and ONLY those batch
 * strings — never file bytes — POST to /api/translate. No storage, no
 * logging; each batch exists in the route's memory for one call and is gone.
 */

export const TRANSLATE_LIMITS = {
  /** Max pages accepted in one run (honest refusal beyond). */
  maxPages: 200,
  /** Max total source characters accepted in one run. */
  maxTotalChars: 100_000,
  /** Max source characters per /api/translate call. */
  batchChars: 2_800,
  /** Hard per-page cap before a page is truncated with an honest marker. */
  pageCharCap: 20_000,
  /** Below this many extracted characters the doc counts as "no text". */
  scannedThresholdChars: 40,
} as const;

/** Target languages v1 — exactly what our embedded fonts can honestly render. */
export const TARGET_LANGUAGES = [
  { code: "hi", english: "Hindi", native: "हिन्दी", script: "devanagari" },
  { code: "en", english: "English", native: "English", script: "latin" },
  { code: "es", english: "Spanish", native: "Español", script: "latin" },
  { code: "fr", english: "French", native: "Français", script: "latin" },
  { code: "de", english: "German", native: "Deutsch", script: "latin" },
  { code: "mr", english: "Marathi", native: "मराठी", script: "devanagari" },
  { code: "it", english: "Italian", native: "Italiano", script: "latin" },
  { code: "pt", english: "Portuguese", native: "Português", script: "latin" },
  { code: "nl", english: "Dutch", native: "Nederlands", script: "latin" },
] as const;

export type TargetLangCode = (typeof TARGET_LANGUAGES)[number]["code"];
export type TargetScript = "latin" | "devanagari";

export function isTargetLang(value: unknown): value is TargetLangCode {
  return (
    typeof value === "string" &&
    TARGET_LANGUAGES.some((l) => l.code === value)
  );
}

export function targetLang(
  code: TargetLangCode,
): (typeof TARGET_LANGUAGES)[number] {
  return TARGET_LANGUAGES.find((l) => l.code === code) ?? TARGET_LANGUAGES[0];
}

/** True when text carries Devanagari codepoints (U+0900–U+097F). */
export function hasDevanagari(text: string): boolean {
  return /[\u0900-\u097F]/.test(text);
}

/* ----------------------- page text + batching ----------------------- */

export interface ExtractedPage {
  page: number;
  text: string;
}

/** Same normalization contract as chat-with-pdf (shared shape, own copy). */
export function normalizePageText(
  text: string,
  cap: number = TRANSLATE_LIMITS.pageCharCap,
): string {
  const flat = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  if (flat.length <= cap) return flat;
  return `${flat.slice(0, cap)}\n…[page truncated]…`;
}

/**
 * One translation unit: the non-empty lines of one page (or a slice of a
 * monster line). `page` rides along so the output PDF can mirror pages.
 */
export interface TranslateBatch {
  page: number;
  lines: string[];
}

/**
 * Packs consecutive non-empty page lines into batches of at most
 * `batchChars` characters (joined with "\n"). A single over-limit line is
 * hard-split at word boundaries when possible — never mid-word unless the
 * word alone exceeds the batch.
 */
export function buildBatches(
  pages: ExtractedPage[],
  batchChars: number = TRANSLATE_LIMITS.batchChars,
): TranslateBatch[] {
  const limit = Math.max(64, Math.floor(batchChars) || 64);
  const batches: TranslateBatch[] = [];
  let current: TranslateBatch | null = null;
  let currentLen = 0;

  const push = (page: number, line: string): void => {
    if (current === null || current.page !== page || currentLen + line.length + 1 > limit) {
      current = { page, lines: [] };
      currentLen = 0;
      batches.push(current);
    }
    current.lines.push(line);
    currentLen += line.length + 1;
  };

  for (const p of Array.isArray(pages) ? pages : []) {
    if (!p || typeof p.text !== "string") continue;
    const pageNo = Math.max(1, Math.round(p.page) || 1);
    for (const raw of p.text.split("\n")) {
      let line = raw.trim();
      if (line.length === 0) continue;
      while (line.length > limit) {
        // Split at the last space inside the limit; else hard cut.
        let cut = line.lastIndexOf(" ", limit);
        if (cut < limit * 0.5) cut = limit;
        push(pageNo, line.slice(0, cut));
        line = line.slice(cut).trim();
      }
      push(pageNo, line);
    }
  }
  return batches;
}

/** Batch → the exact request text (lines joined with "\n"). */
export function batchText(batch: TranslateBatch): string {
  return batch.lines.join("\n");
}

/** Total source characters across batches (the billing-relevant number). */
export function batchesChars(batches: TranslateBatch[]): number {
  return batches.reduce((n, b) => n + batchText(b).length, 0);
}

/** A scanned PDF has (almost) no extractable text — honest OCR hand-off. */
export function isLikelyScanned(pages: ExtractedPage[]): boolean {
  if (!Array.isArray(pages) || pages.length === 0) return true;
  const total = pages.reduce(
    (n, p) => n + (typeof p?.text === "string" ? p.text.trim().length : 0),
    0,
  );
  return total < TRANSLATE_LIMITS.scannedThresholdChars;
}

/* --------------------- WinAnsi-safe text (latin) --------------------- */

/**
 * Characters Helvetica (WinAnsiEncoding) can carry: Latin-1 + the WinAnsi
 * specials. Everything else becomes "?" so pdf-lib drawText can never
 * throw on a latin-script target. Devanagari targets use the embedded Noto
 * font and skip this entirely.
 */
const WINANSI_EXTRA = new Set(
  [
    0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6,
    0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c,
    0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
    0x0153, 0x017e, 0x0178,
  ],
);

export function winAnsiSafe(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    if (ch === "\n" || ch === "\t") {
      out += ch;
    } else if (code >= 0x20 && code <= 0xff) {
      out += ch;
    } else if (WINANSI_EXTRA.has(code)) {
      out += ch;
    } else {
      out += "?";
    }
  }
  return out;
}

/* ------------------------ output assembly ------------------------ */

/** Download-safe output base name: "report" → "report-hi.pdf". */
export function translateOutputName(
  inputName: string,
  target: TargetLangCode,
): string {
  const base = String(inputName ?? "")
    .replace(/\.(pdf)$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  const clean = base.length > 0 ? base.slice(0, 100) : "document";
  return `${clean}-${target}.pdf`;
}

/** Run modes the surface offers. */
export type TranslateMode = "translated" | "bilingual";

export function isTranslateMode(value: unknown): value is TranslateMode {
  return value === "translated" || value === "bilingual";
}
