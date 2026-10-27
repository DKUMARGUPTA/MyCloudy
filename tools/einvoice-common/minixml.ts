/**
 * Mini XML walker (P9 batch 5) — namespace-tolerant tag extraction for
 * WORKERS and Node tests, where DOMParser does not exist.
 *
 * Not a validator, not a parser: it finds elements by local name
 * (prefix-agnostic: "ram:Name" and "x:Name" both match find "Name")
 * and returns their inner text. E-invoice XML in the wild is machine
 * generated and shallow — this is exactly enough for it, and the
 * validate tool still reports malformed XML separately.
 */

/** Un-escapes basic XML entities in text content. */
export function unesc(v: string): string {
  return v
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

/** Next `<name…` occurrence (local name, any prefix) at/after `at`; -1 when done. */
function findOpenTag(scope: string, lower: string, at: number): number {
  let i = at;
  for (;;) {
    const lt = scope.indexOf("<", i);
    if (lt === -1) return -1;
    const ch = scope[lt + 1];
    // Skip closing tags, comments, CDATA, processing instructions.
    if (ch === "/" || ch === "?" || ch === "!") {
      i = lt + 1;
      continue;
    }
    const local = tagLocalName(scope, lt + 1);
    if (local.toLowerCase() === lower) return lt;
    i = lt + 1;
  }
}

/** Next `</name…` occurrence (local name, any prefix) at/after `at`. */
function findCloseTag(scope: string, lower: string, at: number): number {
  let i = at;
  for (;;) {
    const c = scope.indexOf("</", i);
    if (c === -1) return -1;
    const local = tagLocalName(scope, c + 2);
    if (local.toLowerCase() === lower) return c;
    i = c + 2;
  }
}

/** Reads the local name of the tag whose name starts at `from`. */
function tagLocalName(scope: string, from: number): string {
  let j = from;
  while (j < scope.length && !/[\s>/]/.test(scope[j])) j += 1;
  let name = scope.slice(from, j);
  const colon = name.indexOf(":");
  if (colon !== -1) name = name.slice(colon + 1);
  return name;
}

/** True when the tag at `lt` closes itself (`…/>`). */
function isSelfClosing(scope: string, lt: number): boolean {
  const gt = scope.indexOf(">", lt);
  return gt !== -1 && scope[gt - 1] === "/";
}

/**
 * Text of the FIRST element whose local name is `name`, searching
 * within `from` (whole document when omitted). Empty string when absent.
 */
export function xmlTag(xml: string, name: string, from?: string): string {
  const results = xmlTags(xml, name, from, 1);
  return results.length > 0 ? results[0] : "";
}

/**
 * Texts of up to `limit` elements with local name `name` inside
 * `from`. Each match starts after the previous one ends (no overlaps).
 */
export function xmlTags(
  xml: string,
  name: string,
  from?: string,
  limit = 64
): string[] {
  const scope = from ?? xml;
  const lower = name.toLowerCase();
  const out: string[] = [];
  let at = 0;

  while (out.length < limit) {
    const open = findOpenTag(scope, lower, at);
    if (open === -1) break;
    if (isSelfClosing(scope, open)) {
      at = open + 1;
      continue;
    }
    const textStart = scope.indexOf(">", open);
    if (textStart === -1) break;
    const close = findCloseTag(scope, lower, textStart);
    if (close === -1) break;
    out.push(unesc(scope.slice(textStart + 1, close).trim()));
    at = close + 2;
  }
  return out;
}

/** True when the text looks like XML (first tag + matching root close). */
export function looksLikeXml(text: string): boolean {
  const t = text.replace(/^\uFEFF/, "").trimStart();
  if (!t.startsWith("<")) return false;
  const m = t.match(/^<\?xml[\s\S]*?\?>\s*<([\w.-]+)(?::([\w.-]+))?/) ?? t.match(/^<([\w.-]+)(?::([\w.-]+))?/);
  if (!m) return false;
  const local = m[2] ?? m[1];
  // Root close with any (or no) prefix.
  return new RegExp(`</[\\w.-]*:?${local}\\s*>`, "i").test(t);
}

/** Detects the dialect by root local name. */
export function xmlDialect(text: string): "cii" | "ubl" | "other" {
  const m = text.match(/<([\w.-]+:)?(CrossIndustryInvoice|Invoice)\b/);
  if (!m) return "other";
  return m[2] === "Invoice" ? "ubl" : "cii";
}

/** Inner XML of the FIRST element with local name `name` (prefix-tolerant). */
export function scopeOf(xml: string, name: string): string {
  const lower = name.toLowerCase();
  const open = findOpenTag(xml, lower, 0);
  if (open === -1) return "";
  const gt = xml.indexOf(">", open);
  if (gt === -1 || isSelfClosing(xml, open)) return "";
  const close = findCloseTag(xml, lower, gt);
  if (close === -1) return "";
  return xml.slice(gt + 1, close);
}

/** Inner scopes of every element with local name `name`. */
export function allScopes(xml: string, name: string, limit = 200): string[] {
  const lower = name.toLowerCase();
  const out: string[] = [];
  let at = 0;
  while (out.length < limit) {
    const open = findOpenTag(xml, lower, at);
    if (open === -1) break;
    const gt = xml.indexOf(">", open);
    if (gt === -1) break;
    if (isSelfClosing(xml, open)) {
      at = open + 1;
      continue;
    }
    const close = findCloseTag(xml, lower, gt);
    if (close === -1) break;
    out.push(xml.slice(gt + 1, close));
    at = close + 2;
  }
  return out;
}
