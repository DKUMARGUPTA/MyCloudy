/**
 * DocoPDF own PDF micro-engine — object model (P6-a).
 *
 * Pure TypeScript + Uint8Array so the SAME code runs in browser Web Workers
 * (organize-family tools) and in bun smoke scripts. Zero external deps —
 * everything below is our own implementation (user mandate: depend only on
 * our code).
 *
 * Scope: page-surgery engine. Content streams are captured as RAW bytes and
 * passed through untouched — we never decode them. Only xref streams and
 * object streams get decoded (via our own zip engine's zlib inflate).
 */

/** A PDF indirect reference — "N G R". Generation is kept for round-trips. */
export interface PdfRef {
  readonly k: "ref";
  num: number;
  gen: number;
}

export type PdfObj =
  | { k: "num"; n: number }
  | { k: "bool"; b: boolean }
  | { k: "null" }
  | { k: "name"; v: string }
  | { k: "str"; b: Uint8Array }
  | { k: "arr"; items: PdfObj[] }
  | { k: "dict"; m: Map<string, PdfObj> }
  | { k: "stream"; m: Map<string, PdfObj>; raw: Uint8Array }
  | PdfRef;

export const ref = (num: number, gen = 0): PdfRef => ({ k: "ref", num, gen });
export const num = (n: number): PdfObj => ({ k: "num", n });
export const name = (v: string): PdfObj => ({ k: "name", v });
export const arr = (...items: PdfObj[]): PdfObj => ({ k: "arr", items });
export const dict = (m: Map<string, PdfObj>): PdfObj => ({ k: "dict", m });

export function newDict(pairs?: Array<[string, PdfObj]>): { k: "dict"; m: Map<string, PdfObj> } {
  const m = new Map<string, PdfObj>();
  if (pairs) for (const [key, value] of pairs) m.set(key, value);
  return { k: "dict", m };
}

/** dict lookups (name keys stored WITHOUT the leading slash). */
export function dget(o: PdfObj | undefined | null, key: string): PdfObj | undefined {
  if (!o || (o.k !== "dict" && o.k !== "stream")) return undefined;
  return o.m.get(key);
}

export function asName(o: PdfObj | undefined): string | undefined {
  return o && o.k === "name" ? o.v : undefined;
}

export function asNum(o: PdfObj | undefined): number | undefined {
  return o && o.k === "num" ? o.n : undefined;
}

export function asArr(o: PdfObj | undefined): PdfObj[] | undefined {
  return o && o.k === "arr" ? o.items : undefined;
}

export function asDict(o: PdfObj | undefined): Map<string, PdfObj> | undefined {
  return o && (o.k === "dict" || o.k === "stream") ? o.m : undefined;
}

/** [x0, y0, x1, y1] from a box array; undefined when malformed. */
export function asBox(o: PdfObj | undefined): [number, number, number, number] | undefined {
  const items = asArr(o);
  if (!items || items.length !== 4) return undefined;
  const v = items.map(asNum);
  if (v.some((n) => n === undefined || !Number.isFinite(n))) return undefined;
  return [v[0]!, v[1]!, v[2]!, v[3]!];
}

/** Walk any object graph; visit every indirect ref (no cycle risk — refs are leaves). */
export function collectRefs(o: PdfObj, visit: (r: PdfRef) => void, skipKey?: string): void {
  switch (o.k) {
    case "ref":
      visit(o);
      return;
    case "arr":
      for (const item of o.items) collectRefs(item, visit, skipKey);
      return;
    case "dict":
      for (const [key, value] of o.m) {
        if (key === skipKey) continue;
        collectRefs(value, visit, skipKey);
      }
      return;
    case "stream":
      for (const [key, value] of o.m) {
        if (key === skipKey) continue;
        collectRefs(value, visit, skipKey);
      }
      return;
    default:
      return;
  }
}

/**
 * Shallow-clone a dict, optionally dropping/overriding keys.
 * Used for page surgery (drop /Parent, set /Rotate) without mutating the
 * parsed source graph.
 */
export function cloneDict(
  source: Map<string, PdfObj>,
  overrides?: { drop?: string[]; set?: Array<[string, PdfObj]> },
): Map<string, PdfObj> {
  const m = new Map<string, PdfObj>();
  for (const [key, value] of source) m.set(key, value);
  if (overrides?.drop) for (const key of overrides.drop) m.delete(key);
  if (overrides?.set) for (const [key, value] of overrides.set) m.set(key, value);
  return m;
}

/**
 * Canonical number serialization: integers plain; reals with up to 10
 * fraction digits, trailing zeros trimmed, no exponent, "-0" → "0".
 */
export function pdfNumToString(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  let s = n.toFixed(10);
  if (s.indexOf(".") >= 0) {
    s = s.replace(/0+$/, "").replace(/\.$/, "");
  }
  if (s === "-0") s = "0";
  return s;
}

/**
 * Name serialization — escape everything outside the PDF "regular" set with
 * #xx (spec 7.3.5). Round-trips names parsed with #xx unescaping.
 */
export function pdfNameToString(v: string): string {
  let out = "/";
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    const ch = v[i]!;
    const regular =
      c >= 0x21 && c <= 0x7e && c !== 0x23 /* # */ && c !== 0x2f /* / */ &&
      c !== 0x28 && c !== 0x29 && c !== 0x3c && c !== 0x3e && c !== 0x5b &&
      c !== 0x5d && c !== 0x7b && c !== 0x7d && c !== 0x25;
    if (regular) out += ch;
    else out += "#" + c.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/** Strings are written as hex <...> — spec-legal and escape-proof. */
export function pdfStringToHex(b: Uint8Array): string {
  let out = "<";
  for (let i = 0; i < b.length; i++) out += b[i]!.toString(16).padStart(2, "0");
  return out + ">";
}
