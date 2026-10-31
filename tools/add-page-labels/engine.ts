import type { OptionValues } from "@/lib/tools/config-types";

/**
 * Add page labels (PHASE-1 Batch B): PDF /PageLabels — the numbering
 * viewers show in the page box ( “Cover”, “i, ii, iii”, “A-1, A-2…” )
 * instead of plain 1..N. Pure plan builder: the worker installs the
 * /Nums tree inline into a catalog replacement.
 *
 * Styles: none (prefix only) · decimal · lowercase/uppercase Roman ·
 * lowercase/uppercase letters — with an optional prefix and start number
 * (PDF §12.4.2 /S /St /P).
 */

export const PL_IDS = {
  style: "style",
  prefix: "prefix",
  start: "start",
  coverUnlabeled: "coverUnlabeled",
} as const;

export type PlStyle = "none" | "decimal" | "roman-lower" | "roman-upper" | "letters-lower" | "letters-upper";

export interface PageLabelOptions {
  style: PlStyle;
  prefix: string;
  start: number;
  coverUnlabeled: boolean;
}

export const PAGE_LABEL_DEFAULTS: PageLabelOptions = {
  style: "decimal",
  prefix: "",
  start: 1,
  coverUnlabeled: false,
};

export const PL_STYLE_CHOICES: readonly PlStyle[] = [
  "none",
  "decimal",
  "roman-lower",
  "roman-upper",
  "letters-lower",
  "letters-upper",
];

export function resolvePageLabelOptions(
  values: OptionValues
): PageLabelOptions {
  const styleRaw = values[PL_IDS.style];
  const startRaw = Number(values[PL_IDS.start]);
  return {
    style: PL_STYLE_CHOICES.includes(styleRaw as PlStyle)
      ? (styleRaw as PlStyle)
      : "decimal",
    prefix: typeof values[PL_IDS.prefix] === "string" ? (values[PL_IDS.prefix] as string) : "",
    start:
      Number.isFinite(startRaw) && startRaw >= 1 && startRaw <= 999_999
        ? Math.floor(startRaw)
        : 1,
    coverUnlabeled: values[PL_IDS.coverUnlabeled] === true,
  };
}

/** /S name for a style (undefined for "none"). */
export function styleName(style: PlStyle): string | undefined {
  switch (style) {
    case "decimal": return "D";
    case "roman-lower": return "r";
    case "roman-upper": return "R";
    case "letters-lower": return "a";
    case "letters-upper": return "A";
    default: return undefined;
  }
}

/** Integer → Roman numeral (1..3999, classic pairs). */
export function toRoman(value: number, upper: boolean): string {
  const pairs: Array<[number, string]> = [
    [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"],
    [100, "C"], [90, "XC"], [50, "L"], [40, "XL"],
    [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];
  let n = value;
  let out = "";
  for (const [v, s] of pairs) {
    while (n >= v) {
      out += s;
      n -= v;
    }
  }
  return upper ? out : out.toLowerCase();
}

/** Integer → spreadsheet letters (1=a, 26=z, 27=aa…). */
export function toLetters(value: number, upper: boolean): string {
  let n = value;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(97 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return upper ? out.toUpperCase() : out;
}

/** The label a viewer shows for page index 0..N-1 (preview parity). */
export function labelFor(
  opts: PageLabelOptions,
  pageIndex: number
): string {
  if (opts.coverUnlabeled && pageIndex === 0) return "";
  const offset = opts.coverUnlabeled ? pageIndex : pageIndex + 1;
  const n = opts.start + offset - 1;
  let body: string;
  switch (opts.style) {
    case "none":
      body = "";
      break;
    case "roman-lower":
      body = toRoman(n, false);
      break;
    case "roman-upper":
      body = toRoman(n, true);
      break;
    case "letters-lower":
      body = toLetters(n, false);
      break;
    case "letters-upper":
      body = toLetters(n, true);
      break;
    default:
      body = String(n);
  }
  return `${opts.prefix}${body}`;
}
