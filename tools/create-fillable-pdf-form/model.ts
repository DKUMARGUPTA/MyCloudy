/**
 * Create fillable PDF form — pure model (P3-FORM, the 65th tool).
 *
 * The ZERO-MISTAKE core of the visual builder. Everything here is pure
 * (no DOM, no storage, no pdf-lib) and the smoke script
 * (scripts/smoke-create-fillable-pdf-form.ts) re-proves every function
 * with hand-computed vectors:
 *
 *  - CANVAS MODEL: elements live in CSS-px space on an A4 page at 96 dpi
 *    (page = 595.28pt × 841.89pt ÷ 0.75 = 793.71×1122.52 px, margin 40 px,
 *    8 px grid). px→pt is an exact ×0.75 with a y-flip:
 *    PDF y = (PAGE_H_PX − y − h) × 0.75.
 *  - NAMES: field names are formula-safe slugs ([a-z0-9_], never a leading
 *    digit, never a hyphen — a hyphen would be ambiguous with the minus
 *    operator). Collisions dedupe with an "_2" suffix (the make-pdf-
 *    fillable "Name 2" pattern, hyphen-free so `total_2 * price` stays one
 *    token).
 *  - FORMULA COMPILER: tokenizer → recursive-descent parser → validation
 *    (unknown identifier with near-match, non-number reference, duplicate
 *    target, empty/syntax errors, self/cycle detection with the exact
 *    path) → stable topological order → per-target JavaScript emit.
 *  - PARSE: parseFormDoc coerces a serialized form at the worker boundary
 *    (unknown kinds dropped, geometry clamped to the page, NaN guards,
 *    name dedupe, ASCII-safe export values).
 */

/* ------------------------------------------------------------------ */
/* Canvas geometry (px @96dpi on A4; ×0.75 → pt)                        */
/* ------------------------------------------------------------------ */

export const PT_PER_PX = 0.75;
export const PAGE_W_PT = 595.28;
export const PAGE_H_PT = 841.89;
export const PAGE_W_PX = PAGE_W_PT / PT_PER_PX; // 793.7066…
export const PAGE_H_PX = PAGE_H_PT / PT_PER_PX; // 1122.52
export const MARGIN_PX = 40;
export const GRID_PX = 8;

/** Display px rect (x,y from TOP) → PDF pt rect (y from BOTTOM). */
export function pxToPtRect(rect: {
  x: number;
  y: number;
  w: number;
  h: number;
}): { x: number; y: number; w: number; h: number } {
  return {
    x: rect.x * PT_PER_PX,
    y: (PAGE_H_PX - rect.y - rect.h) * PT_PER_PX,
    w: rect.w * PT_PER_PX,
    h: rect.h * PT_PER_PX,
  };
}

/** Display px point (x, y from top) → PDF pt point (y from bottom). */
export function pxToPt(x: number, y: number): { x: number; y: number } {
  return { x: x * PT_PER_PX, y: (PAGE_H_PX - y) * PT_PER_PX };
}

export function snap(v: number, grid = GRID_PX): number {
  return Math.round(v / grid) * grid;
}

export function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/* ------------------------------------------------------------------ */
/* Document shape                                                       */
/* ------------------------------------------------------------------ */

export type StaticKind = "heading" | "text" | "divider" | "box";
export type FieldKind =
  | "text"
  | "multiline"
  | "number"
  | "date"
  | "checkbox"
  | "radio"
  | "dropdown";
export type NumberFormat = "plain" | "rupee" | "percent";

export const FIELD_KINDS: readonly FieldKind[] = [
  "text",
  "multiline",
  "number",
  "date",
  "checkbox",
  "radio",
  "dropdown",
];

export const STATIC_KINDS: readonly StaticKind[] = [
  "heading",
  "text",
  "divider",
  "box",
];

export interface BaseEl {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StaticEl extends BaseEl {
  kind: StaticKind;
  /** Printed text (\n honored). Unused for divider/box. */
  text: string;
  /** Font size in px. */
  fs: number;
}

export interface FieldEl extends BaseEl {
  kind: FieldKind;
  /** Unique formula-safe slug (PDF field name). */
  name: string;
  /** Printed label (any script — drawn with the embedded Noto font). */
  label: string;
  fs: number;
  required: boolean;
  /** text/multiline: max characters (0 = unset). */
  maxLength: number;
  /** number: printed prefix/suffix decoration. */
  format: NumberFormat;
  /** radio/dropdown: display labels (radio any script, dropdown ASCII). */
  options: string[];
  /** Name was edited manually — stop auto-slugging from the label. */
  nameMan: boolean;
}

export type FormElement = StaticEl | FieldEl;

export interface FormPage {
  id: string;
  elements: FormElement[];
}

export interface CalcRule {
  id: string;
  /** Target field NAME (must be a number field). */
  target: string;
  /** Expression source text. */
  expr: string;
}

export interface FormDoc {
  title: string;
  pages: FormPage[];
  rules: CalcRule[];
}

/**
 * Structural discriminator — "text" is BOTH a StaticKind (paragraph) and
 * a FieldKind (single-line text field), so `kind` alone CANNOT decide.
 * The tie-break is `name`: a FieldEl ALWAYS carries one, a StaticEl
 * NEVER does (makeStatic/makeField/templates all guarantee this, and
 * parseFormDoc enforces it at the boundary).
 */
export function isFieldEl(el: FormElement): el is FieldEl {
  return "name" in el;
}

export function allFields(doc: FormDoc): FieldEl[] {
  const out: FieldEl[] = [];
  for (const page of doc.pages) {
    for (const el of page.elements) if (isFieldEl(el)) out.push(el);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Derived geometry (single source of truth for preview AND PDF)        */
/* ------------------------------------------------------------------ */

/** Line height for a font size (px). */
export function lineHeight(fs: number): number {
  return fs * 1.4;
}

/** Height of the printed label line above a field box (px). */
export function labelHeight(el: { label: string; fs: number }): number {
  return el.label ? Math.round(el.fs * 1.5) : 0;
}

/** The interactive box rect inside a field element (px, y from top). */
export function boxRect(el: FieldEl): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const lh = labelHeight(el);
  if (el.kind === "checkbox") {
    // Square centred in the area below the label (make-pdf-fillable pattern).
    const size = Math.max(8, Math.floor(Math.min(el.w, el.h - lh)));
    return {
      x: el.x,
      y: el.y + lh + Math.max(0, (el.h - lh - size) / 2),
      w: size,
      h: size,
    };
  }
  return { x: el.x, y: el.y + lh, w: el.w, h: Math.max(12, el.h - lh) };
}

/** Radio row height derived from the element height and option count. */
export function radioRowHeight(el: FieldEl): number {
  const n = Math.max(1, el.options.filter((o) => o.trim() !== "").length || 1);
  return Math.max(16, Math.round((el.h - labelHeight(el)) / n));
}

/** Radio circle side (px). */
export function radioCircle(el: FieldEl): number {
  return Math.max(8, Math.min(14, radioRowHeight(el) - 4));
}

/** Rows for a radio group: per-option circle rect (px, y from top). */
export function radioRows(el: FieldEl): {
  y: number;
  h: number;
  circle: number;
  cy: number;
}[] {
  const lh = labelHeight(el);
  const rowH = radioRowHeight(el);
  const circle = radioCircle(el);
  return el.options.map((_, i) => ({
    y: el.y + lh + i * rowH,
    h: rowH,
    circle,
    cy: el.y + lh + i * rowH + (rowH - circle) / 2,
  }));
}

/** Element height for an option list (used when options change). */
export function heightForOptions(el: FieldEl, count: number): number {
  const rowH = Math.max(16, Math.round(el.fs * 1.5));
  return labelHeight(el) + Math.max(1, count) * rowH;
}

/* ------------------------------------------------------------------ */
/* Word wrap (pure; measurer injected — pdf-lib or canvas 2d)           */
/* ------------------------------------------------------------------ */

export type Measurer = (text: string, fs: number) => number;

/** Greedy word wrap with hard-break for over-long words; \n honored. */
export function wrapText(
  text: string,
  maxW: number,
  fs: number,
  measure: Measurer,
): string[] {
  const out: string[] = [];
  for (const para of String(text ?? "").split("\n")) {
    if (para === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? line + " " + word : word;
      if (measure(next, fs) <= maxW) {
        line = next;
        continue;
      }
      if (!line) {
        // Single word wider than the box: hard-break it.
        let chunk = "";
        for (const ch of word) {
          if (measure(chunk + ch, fs) > maxW && chunk) {
            out.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        line = chunk;
        continue;
      }
      out.push(line);
      line = word;
    }
    out.push(line);
  }
  return out.length ? out : [""];
}

/* ------------------------------------------------------------------ */
/* Names: slug + dedupe + ASCII safety                                  */
/* ------------------------------------------------------------------ */

/**
 * Formula-safe slug: lowercase, [a-z0-9_] only, no leading digit, never
 * empty. Hyphens/spaces fold to "_" (a hyphen in a name would be
 * ambiguous with the minus operator in expressions).
 */
export function slugify(s: string): string {
  const base = String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  if (base === "") return "field";
  if (/^[0-9]/.test(base)) return "f_" + base;
  return base;
}

/** Dedupe a slug against taken names: "qty", "qty_2", "qty_3"… */
export function uniqueName(base: string, taken: Set<string>): string {
  const clean = base.slice(0, 40) || "field";
  if (!taken.has(clean)) {
    taken.add(clean);
    return clean;
  }
  for (let n = 2; n < 500; n += 1) {
    const candidate = `${clean}_${n}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  const stamped = `${clean}_${Date.now()}`;
  taken.add(stamped);
  return stamped;
}

/** WinAnsi-safe ASCII for field-side strings (option export values). */
export function asciiSafe(s: string): string {
  return (
    String(s ?? "")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2013\u2014]/g, "-")
      .replace(/\u00a0/g, " ")
      .replace(/[^\x20-\x7e]/g, "")
      .trim()
  );
}

/** True when asciiSafe would change the string (honest-warning signal). */
export function needsAsciiTrim(s: string): boolean {
  return asciiSafe(s) !== String(s ?? "").trim();
}

/** Radio/dropdown export value for option `i` (ASCII slug, 1-based fallback). */
export function exportValueFor(option: string, index: number): string {
  const slug = slugify(asciiSafe(option));
  return slug === "field" ? `opt${index + 1}` : slug;
}

/* ------------------------------------------------------------------ */
/* Column-flow placement (next free 8px grid cell, top-left scan)       */
/* ------------------------------------------------------------------ */

function overlaps(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * First free position scanning row by row from the top-left margin in
 * 8px steps (column-flow). Falls back to the margin origin when the page
 * is crowded — the user can drag from there.
 */
export function nextSlot(
  elements: FormElement[],
  w: number,
  h: number,
): { x: number; y: number } {
  const maxX = PAGE_W_PX - MARGIN_PX;
  const maxY = PAGE_H_PX - MARGIN_PX;
  for (let y = MARGIN_PX; ; y += GRID_PX) {
    const clampedY = Math.min(y, maxY);
    for (let x = MARGIN_PX; ; x += GRID_PX) {
      const clampedX = Math.min(x, maxX);
      const probe = {
        x: clampedX,
        y: clampedY,
        w: Math.min(w, maxX - clampedX),
        h,
      };
      if (!elements.some((el) => overlaps(probe, el))) {
        return { x: clampedX, y: clampedY };
      }
      if (x + GRID_PX > maxX) break;
    }
    if (y + GRID_PX > maxY) break;
  }
  return { x: MARGIN_PX, y: MARGIN_PX };
}

/* ------------------------------------------------------------------ */
/* Factories                                                            */
/* ------------------------------------------------------------------ */

export const STATIC_DEFAULTS: Record<
  StaticKind,
  { w: number; h: number; fs: number }
> = {
  heading: { w: 420, h: 24, fs: 16 },
  text: { w: 420, h: 18, fs: 12 },
  divider: { w: 714, h: 8, fs: 12 },
  box: { w: 200, h: 100, fs: 12 },
};

export const FIELD_DEFAULTS: Record<
  FieldKind,
  { w: number; h: number; fs: number; options: string[] }
> = {
  text: { w: 220, h: 40, fs: 12, options: [] },
  multiline: { w: 320, h: 98, fs: 12, options: [] },
  number: { w: 120, h: 40, fs: 12, options: [] },
  date: { w: 130, h: 40, fs: 12, options: [] },
  checkbox: { w: 16, h: 34, fs: 12, options: [] },
  radio: { w: 220, h: 72, fs: 12, options: ["Option 1", "Option 2", "Option 3"] },
  dropdown: { w: 180, h: 40, fs: 12, options: ["Option 1", "Option 2", "Option 3"] },
};

let idSeq = 0;
/** Deterministic element id (e<seq>; parsers regenerate their own). */
export function nextId(prefix = "e"): string {
  idSeq += 1;
  return `${prefix}${idSeq}`;
}

export function makeStatic(
  kind: StaticKind,
  id: string,
  x: number,
  y: number,
  text = "",
): StaticEl {
  const d = STATIC_DEFAULTS[kind];
  return {
    id,
    kind,
    x: snap(x),
    y: snap(y),
    w: d.w,
    h: d.h,
    fs: d.fs,
    text: kind === "divider" || kind === "box" ? "" : text,
  };
}

export function makeField(
  kind: FieldKind,
  id: string,
  x: number,
  y: number,
  label: string,
  taken: Set<string>,
): FieldEl {
  const d = FIELD_DEFAULTS[kind];
  return {
    id,
    kind,
    x: snap(x),
    y: snap(y),
    w: d.w,
    h: d.h,
    fs: d.fs,
    label,
    name: uniqueName(slugify(label), taken),
    nameMan: false,
    required: false,
    maxLength: 0,
    format: "plain",
    options:
      kind === "radio" || kind === "dropdown" ? d.options.slice() : [],
  };
}

/* ------------------------------------------------------------------ */
/* Formula compiler — tokenizer                                         */
/* ------------------------------------------------------------------ */

export type Tok =
  | { t: "num"; v: string }
  | { t: "id"; v: string }
  | { t: "op"; v: "+" | "-" | "*" | "/" | "(" | ")" };

export interface TokenizeResult {
  toks: Tok[];
  error: boolean;
}

export function tokenize(src: string): TokenizeResult {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      if (src[j] === ".") {
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      }
      toks.push({ t: "num", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      toks.push({ t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (
      ch === "+" ||
      ch === "-" ||
      ch === "*" ||
      ch === "/" ||
      ch === "(" ||
      ch === ")"
    ) {
      toks.push({ t: "op", v: ch });
      i += 1;
      continue;
    }
    return { toks, error: true };
  }
  return { toks, error: false };
}

/* ------------------------------------------------------------------ */
/* Formula compiler — parser (recursive descent)                        */
/* ------------------------------------------------------------------ */

/**
 * Grammar:
 *   expr   := term (("+" | "-") term)*
 *   term   := unary (("*" | "/") unary)*
 *   unary  := ("-" | "+") unary | primary
 *   primary:= NUM | ID | "(" expr ")"
 * Unary minus IS supported and survives into the emitted JS verbatim
 * (e.g. `-qty * 2` → `- g("qty") * 2`).
 */
export function parseTokens(toks: Tok[]): boolean {
  let pos = 0;
  const peek = (): Tok | null => toks[pos] ?? null;
  const eat = (): Tok | null => toks[pos++] ?? null;

  const parsePrimary = (): boolean => {
    const t = peek();
    if (t === null) return false;
    if (t.t === "num" || t.t === "id") {
      eat();
      return true;
    }
    if (t.t === "op" && t.v === "(") {
      eat();
      if (!parseExpr()) return false;
      const close = peek();
      if (close === null || close.t !== "op" || close.v !== ")") return false;
      eat();
      return true;
    }
    return false;
  };

  const parseUnary = (): boolean => {
    const t = peek();
    if (t !== null && t.t === "op" && (t.v === "-" || t.v === "+")) {
      eat();
      return parseUnary();
    }
    return parsePrimary();
  };

  const parseTerm = (): boolean => {
    if (!parseUnary()) return false;
    for (;;) {
      const t = peek();
      if (t !== null && t.t === "op" && (t.v === "*" || t.v === "/")) {
        eat();
        if (!parseUnary()) return false;
      } else {
        return true;
      }
    }
  };

  function parseExpr(): boolean {
    if (!parseTerm()) return false;
    for (;;) {
      const t = peek();
      if (t !== null && t.t === "op" && (t.v === "+" || t.v === "-")) {
        eat();
        if (!parseTerm()) return false;
      } else {
        return true;
      }
    }
  }

  if (toks.length === 0) return false;
  if (!parseExpr()) return false;
  return pos === toks.length; // trailing operator = syntax error
}

/** Identifiers referenced by a token stream (order preserved, deduped). */
export function collectIds(toks: Tok[]): string[] {
  const out: string[] = [];
  for (const t of toks) if (t.t === "id" && !out.includes(t.v)) out.push(t.v);
  return out;
}

/**
 * Emit JS from the ORIGINAL token stream: every identifier becomes
 * g("name"), everything else is verbatim — parens and precedence are
 * preserved by construction.
 */
export function emitJs(toks: Tok[]): string {
  return toks
    .map((t) => (t.t === "id" ? `g(${JSON.stringify(t.v)})` : t.v))
    .join(" ");
}

/* ------------------------------------------------------------------ */
/* Formula compiler — the emitted action script                        */
/* ------------------------------------------------------------------ */

/**
 * The per-target calculation script written into the field's /AA /C
 * action (ISO 32000-1 §12.6.4). `this` at the outer level is the Doc in
 * Acrobat's calculation context; the IIFE captures it once as `d` so the
 * nested `g` helper can call `d.getField(name)` for every reference —
 * missing fields read as 0 and non-numeric values read as 0, exactly like
 * the pinned template. (Capturing `d` instead of using `this` inside `g`
 * is the one deliberate deviation: a plainly-called `g` would otherwise
 * lose its `this` and the script would not run — proven by executing the
 * emitted string in the smoke battery.)
 */
export const CALC_PREFIX =
  'event.value = (function(){var d=this;var g=function(n){var f=d.getField(n);if(!f){return 0;}var v=parseFloat(f.value);return isNaN(v)?0:v;};return (';
export const CALC_SUFFIX = ');}).call(this);';

export function calcScript(exprJs: string): string {
  return CALC_PREFIX + exprJs + CALC_SUFFIX;
}

/* ------------------------------------------------------------------ */
/* Formula compiler — validation, cycles, topological order             */
/* ------------------------------------------------------------------ */

export interface CalcError {
  /** Rule index (−1 = document-level). */
  rule: number;
  /** i18n key. */
  key: string;
  name?: string;
  near?: string;
  detail?: string;
}

export interface CompiledRule {
  target: string;
  js: string;
  deps: string[];
}

export interface CalcCompile {
  ok: boolean;
  errors: CalcError[];
  /** Compiled rules in topological order (dependencies first). */
  compiled: CompiledRule[];
}

/** Levenshtein ≤ 2 (case-insensitive) → the closest known name. */
export function nearMatch(name: string, known: readonly string[]): string {
  const lower = name.toLowerCase();
  let best = "";
  let bestDist = 3;
  for (const k of known) {
    const d = editDistance(lower, k.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = k;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 9;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m][n];
}

/** DFS cycle detection; returns the exact cycle path "a → b → a" or null. */
export function findCycle(edges: Map<string, string[]>): string[] | null {
  const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
  const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    const st = state.get(node);
    if (st === 2) return null;
    if (st === 1) {
      const at = stack.indexOf(node);
      return [...stack.slice(at), node];
    }
    state.set(node, 1);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(node, 2);
    return null;
  };
  for (const node of edges.keys()) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * Compile the rules list. Referencable names: number fields and other
 * rule targets. Output order is a stable topological sort (definition
 * order among ready nodes).
 */
export function compileRules(
  rules: CalcRule[],
  fields: readonly { name: string; kind: FieldKind }[],
): CalcCompile {
  const errors: CalcError[] = [];
  const known = new Set(fields.map((f) => f.name));
  const numeric = new Set(
    fields.filter((f) => f.kind === "number").map((f) => f.name),
  );

  interface Parsed {
    idx: number;
    target: string;
    exprJs: string;
    ids: string[];
  }
  const parsed: Parsed[] = [];

  rules.forEach((rule, idx) => {
    const target = String(rule.target ?? "").trim();
    if (target === "") {
      errors.push({ rule: idx, key: "form.calcErrNoTarget" });
      return;
    }
    if (!numeric.has(target)) {
      errors.push({
        rule: idx,
        key: known.has(target) ? "form.calcErrTargetKind" : "form.calcErrTarget",
        name: target,
      });
      return;
    }
    const { toks, error } = tokenize(String(rule.expr ?? ""));
    if (error) {
      errors.push({ rule: idx, key: "form.calcErrChar" });
      return;
    }
    if (toks.length === 0) {
      errors.push({ rule: idx, key: "form.calcErrEmpty" });
      return;
    }
    if (!parseTokens(toks)) {
      errors.push({ rule: idx, key: "form.calcErrSyntax" });
      return;
    }
    const ids = collectIds(toks);
    let ok = true;
    for (const id of ids) {
      if (!numeric.has(id)) {
        if (known.has(id)) {
          errors.push({ rule: idx, key: "form.calcErrNotNumber", name: id });
        } else {
          errors.push({
            rule: idx,
            key: "form.calcErrUnknown",
            name: id,
            near: nearMatch(id, [...numeric]),
          });
        }
        ok = false;
      }
    }
    if (!ok) return;
    parsed.push({ idx, target, exprJs: emitJs(toks), ids });
  });

  // Duplicate targets.
  const seen = new Map<string, number>();
  for (const p of parsed) {
    if (seen.has(p.target)) {
      errors.push({
        rule: p.idx,
        key: "form.calcErrDup",
        name: p.target,
      });
    } else {
      seen.set(p.target, p.idx);
    }
  }

  // Cycle detection (includes self-reference a = a + 1).
  const edgeMap = new Map<string, string[]>();
  for (const p of parsed) {
    edgeMap.set(p.target, p.ids.filter((id) => numeric.has(id)));
  }
  const cycle = findCycle(edgeMap);
  if (cycle) {
    errors.push({ rule: -1, key: "form.calcErrCycle", detail: cycle.join(" → ") });
  }

  if (errors.length > 0) {
    return { ok: false, errors, compiled: [] };
  }

  // Stable topological order (first ready rule in definition order wins).
  const order: string[] = [];
  const done = new Set<string>();
  while (order.length < parsed.length) {
    let progressed = false;
    for (const p of parsed) {
      if (done.has(p.target)) continue;
      if (p.ids.every((id) => done.has(id) || !edgeMap.has(id))) {
        order.push(p.target);
        done.add(p.target);
        progressed = true;
      }
    }
    if (!progressed) break; // unreachable (cycles rejected above)
  }

  const compiled: CompiledRule[] = [];
  for (const target of order) {
    const p = parsed.find((x) => x.target === target);
    if (!p) continue; // unreachable: order is built from parsed targets
    compiled.push({ target, js: calcScript(p.exprJs), deps: p.ids });
  }
  return { ok: true, errors: [], compiled };
}

/* ------------------------------------------------------------------ */
/* Honest warnings (live on the surface, same rules as the parse)      */
/* ------------------------------------------------------------------ */

/** i18n keys for things the export will sanitize or degrade. */
export function formWarnings(doc: FormDoc): string[] {
  const w: string[] = [];
  for (const el of allFields(doc)) {
    if (needsAsciiTrim(el.name)) w.push("form.warnNameAscii");
    if (el.kind === "dropdown" && el.options.some((o) => needsAsciiTrim(o))) {
      w.push("form.warnDropAscii");
    }
  }
  return w;
}

/* ------------------------------------------------------------------ */
/* Worker boundary: serialize + defensive parse                        */
/* ------------------------------------------------------------------ */

export const MAX_PAGES = 10;
export const MAX_ELEMENTS_PER_PAGE = 100;
export const MAX_OPTIONS = 20;
export const MAX_RULES = 30;
export const MAX_FS = 48;
export const MIN_FS = 6;

function str(v: unknown, max = 300): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  return clampNum(v, min, max, fallback);
}

function coerceStatic(o: Record<string, unknown>, id: string): StaticEl | null {
  const kind = o.kind;
  if (
    kind !== "heading" &&
    kind !== "text" &&
    kind !== "divider" &&
    kind !== "box"
  ) {
    return null;
  }
  const x = num(o.x, MARGIN_PX, 0, PAGE_W_PX - 8);
  const y = num(o.y, MARGIN_PX, 0, PAGE_H_PX - 8);
  const w = num(o.w, 100, 8, PAGE_W_PX - x);
  const h = num(o.h, 18, 8, PAGE_H_PX - y);
  const fs = num(o.fs, kind === "heading" ? 16 : 12, MIN_FS, MAX_FS);
  return { id, kind, x, y, w, h, fs, text: str(o.text, 4000) };
}

const KINDS = new Set<string>(FIELD_KINDS);

function coerceField(
  o: Record<string, unknown>,
  id: string,
  taken: Set<string>,
): FieldEl | null {
  const kind = o.kind;
  if (typeof kind !== "string" || !KINDS.has(kind)) return null;
  const k = kind as FieldKind;
  const x = num(o.x, MARGIN_PX, 0, PAGE_W_PX - 8);
  const y = num(o.y, MARGIN_PX, 0, PAGE_H_PX - 8);
  const def = FIELD_DEFAULTS[k];
  const w = num(o.w, def.w, 8, PAGE_W_PX - x);
  const h = num(o.h, def.h, 8, PAGE_H_PX - y);
  const fs = num(o.fs, 12, MIN_FS, MAX_FS);
  const label = str(o.label, 200);
  const name = uniqueName(slugify(String(o.name ?? "")), taken);
  let options: string[] = [];
  if (Array.isArray(o.options)) {
    options = o.options
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim().slice(0, 80))
      .filter((v) => v !== "")
      .slice(0, MAX_OPTIONS);
  } else if (k === "radio" || k === "dropdown") {
    options = def.options.slice();
  }
  const format = o.format === "rupee" || o.format === "percent" ? o.format : "plain";
  const lh = label ? Math.round(fs * 1.5) : 0;
  return {
    id,
    kind: k,
    x,
    y,
    w,
    h:
      k === "radio"
        ? Math.max(h, lh + Math.max(1, options.length) * 16)
        : h,
    fs,
    label,
    name,
    nameMan: o.nameMan === true,
    required: o.required === true,
    maxLength:
      k === "text" || k === "multiline"
        ? Math.round(num(o.maxLength, 0, 0, 500))
        : 0,
    format: k === "number" ? format : "plain",
    options: k === "radio" || k === "dropdown" ? options : [],
  };
}

function coerceId(v: unknown, fallback: string): string {
  const s = str(v, 24).replace(/[^a-zA-Z0-9_-]/g, "");
  return s || fallback;
}

/**
 * Parse a serialized FormDoc (used by the surface boot, the smoke script
 * and the worker). Everything untrusted is clamped/validated — a
 * tampered payload can never reach the PDF builder as a wrong type, an
 * off-page rect or a duplicate field name. Unreadable JSON falls back to
 * a single blank page.
 */
export function parseFormDoc(raw: unknown): FormDoc {
  let parsed: unknown = raw;
  if (typeof raw === "string" && raw !== "") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }
  }
  if (typeof parsed === "string") parsed = {};
  const o = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;

  const pagesRaw = Array.isArray(o.pages) ? o.pages.slice(0, MAX_PAGES) : [];
  const taken = new Set<string>();
  let elSeq = 0;
  const pages: FormPage[] = pagesRaw.map((p, pi) => {
    const po = (typeof p === "object" && p !== null ? p : {}) as Record<
      string,
      unknown
    >;
    const elementsRaw = Array.isArray(po.elements)
      ? po.elements.slice(0, MAX_ELEMENTS_PER_PAGE)
      : [];
    const elements: FormElement[] = [];
    for (const e of elementsRaw) {
      const eo = (typeof e === "object" && e !== null ? e : {}) as Record<
        string,
        unknown
      >;
      elSeq += 1;
      const id = coerceId(eo.id, `e${elSeq}`);
      // "text" is both a static and a field kind — the structural
      // tie-break is `name` (fields always have one, statics never).
      const kindStr = typeof eo.kind === "string" ? eo.kind : "";
      const wantsField =
        kindStr === "text"
          ? "name" in eo && typeof eo.name === "string"
          : kindStr !== "heading" &&
            kindStr !== "divider" &&
            kindStr !== "box";
      const el = wantsField
        ? coerceField(eo, id, taken)
        : coerceStatic(eo, id);
      if (el) elements.push(el);
    }
    return { id: coerceId(po.id, `p${pi + 1}`), elements };
  });

  const rulesRaw = Array.isArray(o.rules) ? o.rules.slice(0, MAX_RULES) : [];
  let ruleSeq = 0;
  const rules: CalcRule[] = [];
  for (const r of rulesRaw) {
    const ro = (typeof r === "object" && r !== null ? r : {}) as Record<
      string,
      unknown
    >;
    ruleSeq += 1;
    rules.push({
      id: coerceId(ro.id, `r${ruleSeq}`),
      target: str(ro.target, 60).trim(),
      expr: str(ro.expr, 300),
    });
  }

  return {
    title: str(o.title, 120),
    pages: pages.length ? pages : [{ id: "p1", elements: [] }],
    rules,
  };
}

/** Output file name from the form title (or "fillable-form"). */
export function outputBaseName(doc: FormDoc): string {
  const base = (doc.title || "fillable-form")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base || "fillable-form";
}

/* ------------------------------------------------------------------ */
/* Blank document                                                       */
/* ------------------------------------------------------------------ */

export function blankDoc(title = ""): FormDoc {
  return { title, pages: [{ id: "p1", elements: [] }], rules: [] };
}

export function docIsEmpty(doc: FormDoc): boolean {
  return doc.pages.every((p) => p.elements.length === 0) && doc.rules.length === 0;
}
