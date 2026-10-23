import type { RunDetail } from "@/lib/workers/protocol";

/**
 * PDF to PDF/A (RB7-a — the 96th tool, optimize family) — types only.
 *
 * The honest conversion pipeline (what a REAL converter does at the -b
 * levels, on-device):
 *
 *  1. fonts — every font actually used must be embedded. The standard 14
 *     may stay unembedded in PDF/A-1b (the spec's only font exception);
 *     PDF/A-2b/-3b practice embeds even those, so the converter embeds a
 *     metric-compatible program from the self-hosted pdf.js standard-font
 *     assets (Liberation Sans for the sans family, the Foxit Type1C
 *     programs for serif/mono/symbol) — in place, keeping every resource
 *     ref, so text strings keep rendering byte-identically. A font that
 *     is neither embedded nor standard-14 cannot be re-typeset honestly:
 *     the run is REJECTED with the page list.
 *  2. colors — content streams (page + form XObjects) are scanned for
 *     g/G/k/K, cs/CS + sc/scn/SC/SCN under DeviceGray/DeviceCMYK (and
 *     named spaces resolved to their component count) and normalized to
 *     DeviceRGB rg/RG equivalents (the naive, documented gray/CMYK → RGB
 *     formulas — no ICC source profiles are invented).
 *  3. XMP — a fresh packet with dc:title (from /Info Title, UTF-8) +
 *     pdfaid:part + pdfaid:conformance B, written as the catalog
 *     /Metadata stream.
 *  4. OutputIntent — a REAL hand-rolled sRGB ICC v2.1 profile (matrix/TRC
 *     monitor profile: D50-adapted sRGB primaries + the true piecewise
 *     sRGB tone curve sampled at 1024 points — probe-verified against
 *     lcms2) embedded as /DestOutputProfile with /N 3.
 *  5. -b levels need NO tagging (no /MarkInfo, no struct tree) — that is
 *     PDF/A-a. Documented, not faked.
 *  6. transparency — soft masks + constant alpha are forbidden in PDF/A-1b:
 *     detected honestly (per page) and the run is REJECTED for -1b (a
 *     naive flatten would silently alter rendering). PDF/A-2b+ allows them.
 *  7. forbidden content — the /Names/JavaScript tree, /OpenAction and
 *     /AA JavaScript/Launch/Sound/Movie/GoToR/GoToE/Rendition actions and
 *     multimedia annotations are REMOVED (each removal counted + reported);
 *     embedded files are dropped for -1b/-2b and kept for -3b (with
 *     missing /AFRelationship patched to /Unspecified).
 *  8. encryption — PDF/A forbids it; encrypted inputs are rejected.
 *  9. header — %PDF-1.4 for -1b (PDF/A-1 is PDF 1.4-based; object streams
 *     are also off for -1b), 1.7 for -2b/-3b. A trailer /ID is ensured.
 *
 * The output carries a plain-text conformance report (validate-e-invoice
 * pattern): what changed, what could not be, per-page notes.
 */

/* ------------------------------------------------------------------ */
/* Conformance targets                                                  */
/* ------------------------------------------------------------------ */

export type PdfaTarget = "1b" | "2b" | "3b";

export const PDFA_TARGETS: readonly PdfaTarget[] = ["1b", "2b", "3b"] as const;

/** Per-target facts (ISO 19005 level → PDF version + object streams). */
export const PDFA_TARGET_INFO: Record<
  PdfaTarget,
  { part: 1 | 2 | 3; pdfVersion: "1.4" | "1.7"; objectStreams: boolean }
> = {
  "1b": { part: 1, pdfVersion: "1.4", objectStreams: false },
  "2b": { part: 2, pdfVersion: "1.7", objectStreams: false },
  "3b": { part: 3, pdfVersion: "1.7", objectStreams: false },
};

export const DEFAULT_PDFA_TARGET: PdfaTarget = "2b";

/* ------------------------------------------------------------------ */
/* Change report (the conformance report's data model)                  */
/* ------------------------------------------------------------------ */

/** Color normalization stats for one content stream. */
export interface ColorStreamStats {
  /** g/G gray fills/strokes rewritten to rg/RG. */
  grayOps: number;
  /** k/K CMYK fills/strokes rewritten to rg/RG (naive formula). */
  cmykOps: number;
  /** cs/CS colorspace names rewritten to /DeviceRGB (gray/CMYK → RGB). */
  csSwitches: number;
  /** sc/scn/SC/SCN operand sets expanded to 3 components. */
  scOps: number;
  /** Shading fills (sh) left as-is (counted, honestly reported). */
  shadings: number;
  /** Inline images skipped by the tokenizer (byte-preserved). */
  inlineImages: number;
  /** Honest notes for un-convertible constructs (patterns, special spaces). */
  notes: string[];
}

export interface ColorReport {
  /** Content streams scanned (page + form XObjects). */
  streamsScanned: number;
  /** Streams whose bytes changed. */
  streamsRewritten: number;
  /** Streams skipped honestly (non-Flate filter / inflate failure). */
  streamsSkipped: number;
  /** Per-page color notes (page index → human sentence). */
  pageNotes: string[];
  totals: Omit<ColorStreamStats, "notes">;
}

export interface FontReport {
  /** Source fonts already embedded (pass through untouched). */
  embeddedPassed: number;
  /** Standard-14 fonts kept unembedded (PDF/A-1b only). */
  standardKept: number;
  /** Standard-14 fonts embedded with substitute programs (2b/3b). */
  standardEmbedded: number;
  /** Font substitution notes (honest, per font). */
  notes: string[];
}

export interface ActionReport {
  /** /Names/JavaScript tree removed. */
  jsTreeStripped: boolean;
  /** /OpenAction actions removed (with their types). */
  openActionStripped: string[];
  /** /AA additional-action dicts removed (catalog + pages). */
  aaStripped: number;
  /** Annotation actions stripped (JS/Launch/Sound/Movie/GoToR/GoToE/Rendition). */
  annotActionsStripped: number;
  /** Multimedia annotations removed (Screen/Movie/Sound/RichMedia/3D). */
  annotsRemoved: number;
  /** Widget annotations without an /AP stream (reported, left in place). */
  annotsNoAp: number;
  /** Embedded files dropped (-1b/-2b). */
  embeddedFilesDropped: number;
  /** Embedded files kept + AFRelationship-patched (-3b). */
  embeddedFilesKept: number;
}

export interface TransparencyReport {
  /** Soft masks in use (ExtGState /SMask or image /SMask), by page. */
  softMaskPages: number[];
  /** Constant alpha < 1 in use (ExtGState ca/CA), by page. */
  alphaPages: number[];
}

/** The whole change record the .txt report renders. */
export interface PdfaChangeReport {
  target: PdfaTarget;
  pageCount: number;
  colors: ColorReport;
  fonts: FontReport;
  actions: ActionReport;
  transparency: TransparencyReport;
  /** The /Info Title copied into dc:title ("" when absent). */
  docTitle: string;
  /** XMP packet written to the catalog /Metadata. */
  xmpWritten: boolean;
  /** OutputIntent with the hand-rolled sRGB ICC embedded. */
  outputIntentWritten: boolean;
  /** ICC profile size in bytes. */
  iccBytes: number;
  /** Trailer /ID ensured. */
  idWritten: boolean;
  /** Final %PDF- header version. */
  headerVersion: string;
  /** Global honesty notes (things the converter could not do). */
  notes: string[];
}

/* ------------------------------------------------------------------ */
/* Run detail (worker → result view; extends the shared RunDetail)      */
/* ------------------------------------------------------------------ */

export interface PdfaDetail extends RunDetail {
  /** The chosen conformance level ("1b" | "2b" | "3b"). */
  target?: PdfaTarget;
  /** Total gray+CMYK color operators rewritten to DeviceRGB. */
  colorsConverted?: number;
  /** Standard-14 fonts embedded with substitute programs. */
  fontsEmbedded?: number;
  /** JavaScript/action/annotation items stripped. */
  itemsStripped?: number;
}
