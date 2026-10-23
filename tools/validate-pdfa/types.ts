import type { RunDetail } from "@/lib/workers/protocol";

/**
 * Validate PDF/A (RB7-b, the 97th tool, view category) — types only.
 *
 * The honest contract (mirrored in the FAQ + the report footer): a REAL
 * PDF/A conformance checker — a veraPDF-inspired HONEST SUBSET, 100%
 * on-device. It reads the RAW PDF bytes, walks xref/trailer (with the
 * linear object-scan + object-stream recovery for slightly broken files),
 * the catalog, the pages tree, per-page content streams (inflated),
 * resources, fonts, XMP metadata and OutputIntents, then judges:
 *
 *  1. XMP identification — /Metadata on the catalog, parseable XMP,
 *     pdfaid:part + pdfaid:conformance vs the declared level (auto-detect
 *     from XMP with an honest "detected X (declared Y)" line).
 *  2. Fonts — every font USED by page content (/Name Tf scan, Form
 *     XObjects included) must be embedded per level: -1b allows the
 *     standard 14 unembedded, -2b/-3b require embedding. Names + pages.
 *  3. Color & transparency — device CMYK (k/K operators in streams,
 *     /DeviceCMYK in resources) is flagged; /SMask, transparency groups
 *     and ExtGState soft masks are forbidden at -1b and allowed at -2b+;
 *     PostScript calculator functions (/FunctionType 4) are forbidden.
 *  4. Forbidden content — /Encrypt, JavaScript (/Names/JavaScript + /JS
 *     actions), /Launch actions, multimedia, /OpenAction in action (dict)
 *     form, and embedded files (violations at -1b/-2b, ALLOWED at -3b).
 *  5. OutputIntent — present with an ICC profile stream? Warning-level
 *     (many honest producers omit it).
 *  6. MarkInfo/StructTree — required only for -a conformance; -b targets
 *     get an honest "not required for -b" skip.
 *  7. /Info ↔ XMP mirroring (dc:title ↔ /Title …) — warning-level.
 *
 * Plus a LIGHT PDF/UA hints group (advisory, never affects the PDF/A
 * verdict): MarkInfo /Marked, catalog /Lang, an /Alt scan of the
 * structure tree. Full PDF/UA validation is NOT performed.
 *
 * Pipeline split (bun-testable model, worker does I/O only):
 *   worker: read file → sniff %PDF- → size gate → analyzePdfa(bytes, level)
 *   model:  everything else — the raw walk, the checks, the verdict, the
 *           report text. Pure functions, zero DOM, zero pdf.js/pdf-lib.
 */

/* ------------------------------------------------------------------ */
/* Levels + verdicts                                                   */
/* ------------------------------------------------------------------ */

/** The three target levels this tool can judge (user picks or auto). */
export type PdfaLevel = "1b" | "2b" | "3b";

/** What the user asked for ("auto" = detect from the XMP pdfaid:part). */
export type DeclaredLevel = PdfaLevel | "auto";

/** PASS / PASS WITH WARNINGS / FAIL — the aggregate PDF/A verdict. */
export type Verdict = "pass" | "warnings" | "fail";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

/** Card groups the surface renders as sections. */
export type CheckGroup =
  | "identify"
  | "fonts"
  | "color"
  | "forbidden"
  | "structure"
  | "meta"
  | "ua";

/* ------------------------------------------------------------------ */
/* XMP                                                                 */
/* ------------------------------------------------------------------ */

/** What the catalog /Metadata stream revealed (null fields = absent). */
export interface XmpInfo {
  /** Catalog /Metadata present AND decodable to text. */
  present: boolean;
  /** Technical reason when present-but-unreadable (report-only). */
  parseError: string | null;
  /** pdfaid:part (1/2/3), null when absent/junk. */
  part: number | null;
  /** pdfaid:conformance ("A"/"B"/…), null when absent. */
  conformance: string | null;
  /** dc:title (x-default alt), null when absent. */
  dcTitle: string | null;
  /** dc:creator first entry, null when absent. */
  dcCreator: string | null;
  /** pdf:Producer, null when absent. */
  producer: string | null;
  /** pdf:Keywords, null when absent. */
  keywords: string | null;
}

/* ------------------------------------------------------------------ */
/* Fonts                                                               */
/* ------------------------------------------------------------------ */

/** One font as used by page content (merged across pages). */
export interface FontUse {
  /** /BaseFont (e.g. "Helvetica"; "(unnamed)" when absent). */
  name: string;
  /** /Subtype ("Type1", "TrueType", "Type0", "Type3", "CIDFontType2"…). */
  subtype: string;
  /** FontFile/FontFile2/FontFile3 present (descendant walk for Type0). */
  embedded: boolean;
  /** One of the standard 14 base font names. */
  standard14: boolean;
  /** 1-based pages whose content references this font (/Name … Tf). */
  pages: number[];
}

/* ------------------------------------------------------------------ */
/* Checks                                                              */
/* ------------------------------------------------------------------ */

/**
 * One checklist row. `label` and (when a sentence) `note` are FULL i18n
 * keys ("vpa.kXmp", "vpa.nFontsFail"…); technical fragments (font names,
 * counts, part numbers) live in `detail` and are shown raw.
 */
export interface PdfaCheck {
  /** Stable check id ("xmp", "fonts", "cmyk"… — smoke vectors). */
  id: string;
  group: CheckGroup;
  /** i18n key for the human label. */
  label: string;
  status: CheckStatus;
  /** 1-based pages the finding references (empty when n/a). */
  pages: number[];
  /** i18n key for the explanatory sentence (never free prose). */
  note?: string;
  /** Technical raw detail (font names, part numbers, stream ids). */
  detail?: string;
  /** Advisory rows never affect the PDF/A verdict (the UA hints group). */
  advisory?: boolean;
}

/** The whole validation result the surface renders + the report encodes. */
export interface PdfaReport {
  /** What the user selected. */
  declaredLevel: DeclaredLevel;
  /** The level the checks actually ran against. */
  effectiveLevel: PdfaLevel;
  /** Level came from the XMP pdfaid:part (auto mode). */
  autoDetected: boolean;
  /** Raw XMP claim ("2B"…), null when XMP has no identification. */
  xmpClaim: string | null;
  /** "1b/2b/3b" derived from the XMP claim, null when undetectable. */
  detectedLevel: PdfaLevel | null;
  /** True when XMP conformance letter is "A" (level-a rules activate). */
  conformanceA: boolean;
  xmp: XmpInfo;
  /** Page count from the pages tree (null when unreadable). */
  pageCount: number | null;
  checks: PdfaCheck[];
  /** Every font used by page content (the fonts check's evidence). */
  fonts: FontUse[];
  /** The linear object-scan / object-stream recovery was used. */
  recoveryUsed: boolean;
  /** Technical reason for the recovery (raw, report-only). */
  recoveryReason: string | null;
  verdict: Verdict;
}

/* ------------------------------------------------------------------ */
/* Worker boundary                                                     */
/* ------------------------------------------------------------------ */

/**
 * Pre-resolved display strings for the .txt report (validate-e-invoice
 * precedent: the surface passes its t() output through options.run so the
 * report matches the UI language; the model keeps an English fallback).
 */
export type ReportLabels = Record<string, string>;

/** Options payload the surface syncs (JSON in options.run). */
export interface RunOptions {
  level: DeclaredLevel;
  locale: "en" | "hi";
  /** Localized fallback word for a nameless file. */
  fileWord: string;
  /** Resolved report strings (vpa.* keys → text). */
  labels: ReportLabels;
}

/** Report header meta (file identity for the .txt). */
export interface ReportMeta {
  fileName: string;
  bytes: number;
}

/**
 * RunDetail extension for validate-pdfa (the RB1/RB3-b additive precedent,
 * local like the siblings): what the worker posts and the surface reads.
 */
export interface ValidatePdfaDetail extends RunDetail {
  verdict?: Verdict;
  checksPassed?: number;
  checksWarned?: number;
  checksFailed?: number;
  /** The level the checks ran against ("2b"). */
  level?: string;
  /** What the user selected ("auto"/"1b"/"2b"/"3b"). */
  declaredLevel?: string;
  /** "1b/2b/3b" from the XMP claim, null when undetectable. */
  detectedLevel?: string | null;
  /** Linear object-scan / object-stream recovery was used. */
  recovered?: boolean;
  /** The full report the surface renders. */
  report?: PdfaReport;
}
