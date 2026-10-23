/**
 * Webpage to PDF (RB4-f) — thin model. The heavy lifting is the
 * html-to-pdf engine (RB2-d): this file RE-EXPORTS its parser + stats +
 * caps so the worker, the surface and the smoke all bind to ONE
 * rendering truth (the same parseHtml that feeds the file-based tool),
 * and adds only what is URL-specific:
 *
 *  - hostnameBaseName / pickBaseName — the download name for a page
 *    that came from a URL (WHATWG hostnames are punycode/ASCII, so the
 *    honest story is "always ASCII, dots become dashes");
 *  - fetchErrorKey — the pass-through pipe's error codes mapped to
 *    wpdf.* i18n keys (the route never invents user-facing text);
 *  - FETCH_PAGE_LIMITS — the one place the fetch pipe's caps live
 *    (5 MB body, 15 s timeout, ≤ 3 redirects) — imported by the API
 *    route AND asserted by the smoke.
 *
 * Rendering delegates 1:1 to ../html-to-pdf: parseHtml → parseHtmlRun
 * (worker-boundary coercion) → needsNoto (WinAnsi → base-14 Helvetica
 * vs the embedded Noto Devanagari subset) → drawHtmlPdf. Nothing here
 * re-implements any of that.
 */

import { outputBaseName } from "../html-to-pdf/model";

export {
  decodeHtmlBytes,
  estimatePages,
  inputTooLarge,
  isWinAnsiText,
  looksLikeHtml,
  MAX_INPUT_BYTES,
  needsNoto,
  outputBaseName,
  parseHtml,
  parseHtmlRun,
  stats,
} from "../html-to-pdf/model";

export type {
  HtmlBlock,
  HtmlDocStats,
  HtmlRun,
  ParsedHtml,
} from "../html-to-pdf/model";

export type { HtmlFontSet, HtmlRenderOpts, HtmlRenderReport } from "../html-to-pdf/render";

/* ------------------------------------------------------------------ */
/* The fetch pipe's limits (route + smoke share these)                  */
/* ------------------------------------------------------------------ */

export const FETCH_PAGE_LIMITS = {
  /** response body cap in bytes (the route stops reading past this) */
  maxBytes: 5 * 1024 * 1024,
  /** overall budget for the WHOLE redirect walk (one AbortController) */
  timeoutMs: 15_000,
  /** manual redirect hops followed after the initial request */
  maxRedirects: 3,
} as const;

/** The JSON body a successful /api/fetch-page call returns. */
export interface FetchPageOk {
  ok: true;
  /** the page's HTML, decoded with the engine's charset-aware reader */
  html: string;
  /** the URL after the redirect walk (relative hrefs resolved against it) */
  finalUrl: string;
  /** the HTTP status the content came with */
  status: number;
}

/** Every error code the pipe can answer with (the smoke asserts parity). */
export const FETCH_ERROR_CODES = [
  "invalid-url",
  "private-address",
  "dns-failed",
  "fetch-failed",
  "timeout",
  "too-large",
  "not-html",
  "too-many-redirects",
  "http-status",
  "rate-limited",
] as const;

export type FetchErrorCode = (typeof FETCH_ERROR_CODES)[number];

export interface FetchPageErr {
  ok: false;
  error: FetchErrorCode | "invalid-body" | "invalid-json";
  /** machine-readable detail (served content-type, upstream status…) */
  detail?: string;
}

export type FetchPageResponse = FetchPageOk | FetchPageErr;

/* ------------------------------------------------------------------ */
/* Error code → i18n key (no user text ever comes from the network)    */
/* ------------------------------------------------------------------ */

/**
 * Maps a /api/fetch-page error code onto the worker's error keys.
 * Unknown codes degrade to the generic tool error — an upstream change
 * can never leak raw strings at the user.
 */
export function fetchErrorKey(code: string): string {
  switch (code) {
    case "invalid-url":
      return "wpdf.errUrl";
    case "private-address":
      return "wpdf.errPrivate";
    case "dns-failed":
    case "fetch-failed":
      return "wpdf.errFetch";
    case "timeout":
      return "wpdf.errTimeout";
    case "too-large":
      return "wpdf.errTooLarge";
    case "not-html":
      return "wpdf.errNotHtml";
    case "too-many-redirects":
      return "wpdf.errRedirects";
    case "http-status":
      return "wpdf.errHttpStatus";
    case "rate-limited":
      return "wpdf.errRate";
    default:
      return "tool.errorGeneric";
  }
}

/* ------------------------------------------------------------------ */
/* Output naming — hostname-safe                                        */
/* ------------------------------------------------------------------ */

/**
 * Download base name derived from a URL's hostname: dots and colons
 * become dashes, anything unsafe is dropped, ASCII-only by construction
 * (the WHATWG URL parser lowercases + punycodes IDN hostnames —
 * उदाहरण.भारत arrives as xn--…, we stay honest and keep that). Falls
 * back to the localized "Webpage / वेबपेज" word for unusable hosts.
 */
export function hostnameBaseName(raw: string, lang: "en" | "hi"): string {
  const fallback = lang === "hi" ? "वेबपेज" : "Webpage";
  let host = "";
  try {
    host = new URL(raw).hostname;
  } catch {
    host = "";
  }
  if (host === "") return fallback;
  const cleaned = host
    .replace(/^\[(.*)\]$/, "$1") // unbracket an IPv6 literal
    .toLowerCase()
    .replace(/[^a-z0-9:.-]+/g, "") // drop every URL-unsafe char
    .replace(/[.:~-]/g, "-") // one char → one dash (punycode "xn--" survives)
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * The worker's naming decision: the page's <title> when the document
 * carries one (sanitized by the engine's outputBaseName), else the
 * final URL's hostname (hostnameBaseName). No extension appended.
 */
export function pickBaseName(
  title: string,
  finalUrl: string,
  lang: "en" | "hi"
): string {
  const trimmed = title.trim();
  if (trimmed !== "") {
    return outputBaseName(trimmed, lang);
  }
  return hostnameBaseName(finalUrl, lang);
}
