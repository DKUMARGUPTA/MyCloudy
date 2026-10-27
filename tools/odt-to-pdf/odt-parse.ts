import { unzipSync } from "fflate";

import {
  scanXmlTags,
  unescapeXml,
} from "../word-to-pdf/docx-parse";

/**
 * ODT parser (Task b4-c) — PURE, bun-testable, no DOM, no worker APIs.
 *
 * An .odt (OpenDocument Text) is a ZIP whose parts are XML documents —
 * the same idea as a .docx, one ODF flavour over. This module opens the
 * package with fflate's unzipSync (the same library the app zips with)
 * and parses the parts odt-to-pdf needs:
 *
 *   content.xml  — walked with the SHARED tag scanner from
 *                 ../word-to-pdf/docx-parse.ts (a stack, not regex —
 *                 content.xml can be 10 MB+). Collects render blocks:
 *                 text:h (+ text:outline-level) → headings,
 *                 text:p → paragraphs, text:list/text:list-item →
 *                 list items (nested lists → depth), text:span → styled
 *                 runs, text:s/text:tab/text:line-break → whitespace,
 *                 draw:image → counted (not rendered, honest v1).
 *   styles.xml   — style:style definitions (office:styles +
 *                 office:automatic-styles) → name → { bold, italic,
 *                 fontSize, outline level } with parent-style chains
 *                 followed (LibreOffice's automatic styles inherit
 *                 from named heading styles — without the chain, real
 *                 files lose their heading sizes).
 *
 * V1 honesty (stated in the tool FAQ): images are skipped (counted,
 * not embedded); tables and text boxes are not rebuilt — the text
 * inside them survives as plain paragraphs; tracked-change DELETIONS
 * are skipped (insertions render); automatic list numbering renders
 * as a bullet unless the file carries literal text:number text.
 *
 * Robustness: the scanner never throws on malformed XML — stray
 * closing tags are ignored (stack guard), unclosed paragraphs flush
 * at EOF, pretty-printed whitespace text nodes are dropped. Structural
 * problems (not a zip, no content.xml, non-UTF-8 parts) throw
 * OdtParseError, which the worker maps to the honest tool.errorCorrupt.
 *
 * Namespace tolerance: elements/attributes match either the canonical
 * prefixed name ("text:p", "text:outline-level") or the bare local name
 * ("p", "outline-level") — local names are unique inside a body walk.
 *
 * iOS-safe (worklog IOS-COMPAT): no matchAll/replaceAll, no regex
 * lookbehind, no Object.hasOwn / structuredClone — single-pass
 * String.replace, split/join and plain exec/test only.
 */

/* ------------------------------------------------------------------ */
/* Style tables (styles.xml + content.xml automatic-styles)            */
/* ------------------------------------------------------------------ */

/** Raw style:style definition (before parent resolution). */
export interface OdtStyleEntry {
  /** style:family ("paragraph", "text", …). */
  family?: string;
  /** style:parent-style-name — the inheritance chain. */
  parent?: string;
  /** style:class="heading" — named heading styles carry it. */
  headingClass?: boolean;
  /** style:paragraph-properties/@text:outline-level, when declared. */
  outlineLevel?: number;
  /** fo:font-weight → bold. */
  bold?: boolean;
  /** fo:font-style / style:font-style → italic. */
  italic?: boolean;
  /** fo:font-size ("14pt") → pt. */
  sizePt?: number;
}

export type OdtStyleTable = Map<string, OdtStyleEntry>;

/** A style after parent-chain resolution (child props win). */
export interface OdtResolvedStyle {
  bold?: boolean;
  italic?: boolean;
  sizePt?: number;
  outlineLevel?: number;
  headingClass?: boolean;
}

/** True when `attrs` carries the local attribute name under any prefix. */
function attr(attrs: Record<string, string>, local: string): string | undefined {
  const direct = attrs[local];
  if (direct !== undefined) return direct;
  for (const key of Object.keys(attrs)) {
    if (key.slice(key.indexOf(":") + 1) === local) return attrs[key];
  }
  return undefined;
}

/** Element name → its local part ("text:p" → "p"). */
function localName(name: string): string {
  const cut = name.indexOf(":");
  return cut === -1 ? name : name.slice(cut + 1);
}

/** fo:font-weight → boolean (bold/bolder/≥600 true; normal/lighter/<600 false). */
function parseWeight(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "bold" || v === "bolder") return true;
  if (v === "normal" || v === "lighter") return false;
  const n = Number(v);
  if (Number.isFinite(n)) return n >= 600;
  return undefined;
}

/** fo:font-style / style:font-style → italic flag. */
function parseFontStyle(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "italic" || v === "oblique") return true;
  if (v === "normal") return false;
  return undefined;
}

/** "14pt" / "14.5pt" → 14 / 14.5 (any other unit is ignored). */
function parseSizePt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^([0-9]+(?:\.[0-9]+)?)pt$/i.exec(value.trim());
  if (match === null) return undefined;
  const pt = Number(match[1]);
  if (!Number.isFinite(pt) || pt < 1 || pt > 400) return undefined;
  return pt;
}

/** One ODF number, clamped to a sane range (guards text:c="99999"). */
function attrCount(attrs: Record<string, string>, fallback: number): number {
  const raw = attr(attrs, "c");
  const n = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(400, Math.floor(n));
}

/**
 * Parses every style:style in an ODF styles document — both
 * office:styles (named styles: Heading_20_1, Standard…) and
 * office:automatic-styles (the P1/T1… styles content.xml references).
 * Malformed markup degrades to what could be read, never throws.
 */
export function parseStylesXml(xml: string): OdtStyleTable {
  const table: OdtStyleTable = new Map();
  let name: string | null = null;
  let current: OdtStyleEntry | null = null;
  scanXmlTags(
    xml,
    (tag) => {
      if (tag.closing) {
        if (localName(tag.name) === "style" && name !== null && current !== null) {
          table.set(name, current);
          name = null;
          current = null;
        }
        return;
      }
      const ln = localName(tag.name);
      if (ln === "style") {
        const styleName = attr(tag.attrs, "name");
        if (styleName === undefined || styleName.length === 0) {
          name = null;
          current = null;
          return;
        }
        const family = attr(tag.attrs, "family");
        const parent = attr(tag.attrs, "parent-style-name");
        const entry: OdtStyleEntry = {
          family: family !== undefined && family.length > 0 ? family : undefined,
          parent: parent !== undefined && parent.length > 0 ? parent : undefined,
        };
        // style:class carries information only when it IS "heading" — a
        // prop-less "text"-classed style keeps family only (no redundant
        // headingClass:false; the resolver treats it as truthy-only).
        if (attr(tag.attrs, "class") === "heading") entry.headingClass = true;
        if (tag.selfClosing) {
          // <style:style .../> — attributes only (LibreOffice writes its
          // automatic paragraph styles exactly like this, parent ref and
          // all — skipping them would lose the heading chains).
          table.set(styleName, entry);
          name = null;
          current = null;
          return;
        }
        name = styleName;
        current = entry;
        return;
      }
      if (name === null || current === null) return;
      if (ln === "text-properties") {
        const weight = parseWeight(attr(tag.attrs, "font-weight"));
        if (weight !== undefined) current.bold = weight;
        const italic = parseFontStyle(
          attr(tag.attrs, "font-style") ?? attr(tag.attrs, "font-style-asian")
        );
        if (italic !== undefined) current.italic = italic;
        const sizePt = parseSizePt(
          attr(tag.attrs, "font-size") ?? attr(tag.attrs, "font-size-asian")
        );
        if (sizePt !== undefined && current.sizePt === undefined) {
          current.sizePt = sizePt;
        }
      } else if (ln === "paragraph-properties") {
        const lvl = Number(attr(tag.attrs, "outline-level"));
        if (Number.isFinite(lvl) && lvl >= 1 && current.outlineLevel === undefined) {
          current.outlineLevel = Math.floor(lvl);
        }
      }
    },
    () => {
      /* style definition text is irrelevant */
    }
  );
  if (name !== null && current !== null) table.set(name, current); // unclosed tail
  return table;
}

/**
 * Resolves one style name through its parent-style-name chain
 * (parents first, child overrides; cycle-safe, depth-capped).
 */
export function resolveOdtStyle(
  table: OdtStyleTable,
  name: string | null
): OdtResolvedStyle {
  const chain: OdtStyleEntry[] = [];
  const seen = new Set<string>();
  let current = name;
  while (
    current !== null &&
    current.length > 0 &&
    chain.length < 12 &&
    !seen.has(current)
  ) {
    seen.add(current);
    const entry = table.get(current);
    if (entry === undefined) break;
    chain.push(entry);
    current = entry.parent ?? null;
  }
  const out: OdtResolvedStyle = {};
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const entry = chain[i];
    if (entry.headingClass) out.headingClass = true;
    if (entry.bold !== undefined) out.bold = entry.bold;
    if (entry.italic !== undefined) out.italic = entry.italic;
    if (entry.sizePt !== undefined) out.sizePt = entry.sizePt;
    if (entry.outlineLevel !== undefined) out.outlineLevel = entry.outlineLevel;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The document model                                                   */
/* ------------------------------------------------------------------ */

/** One styled fragment of text inside a paragraph. */
export interface OdtRun {
  text: string;
  bold: boolean;
  italic: boolean;
}

/** One renderable block (classification happens in the parser). */
export type OdtDocBlock =
  | {
      kind: "heading";
      /** 1–6 (text:outline-level, clamped onto the markdown ladder). */
      level: number;
      /** styles.xml size when declared, else the default ladder. */
      sizePt: number;
      /** Style-resolved bold (default true — the heading convention). */
      bold: boolean;
      runs: OdtRun[];
    }
  | { kind: "para"; runs: OdtRun[] }
  | {
      kind: "listItem";
      /** 0-based nesting depth (0 = top level). */
      depth: number;
      /** Literal text:number text from the file, when present. */
      number: string | null;
      runs: OdtRun[];
    }
  | { kind: "spacer" };

/**
 * The markdown-to-pdf heading ladder (pt) — the render-side defaults
 * real ODT styles.xml usually overrides.
 */
export const DEFAULT_HEADING_SIZES_PT: readonly number[] = [
  22, 18, 15, 13, 12, 11,
];

/* ------------------------------------------------------------------ */
/* content.xml → blocks                                                 */
/* ------------------------------------------------------------------ */

/** One open text:p / text:h being accumulated (a stack: nested
 *  text:p inside draw:text-box frames becomes its own paragraph). */
interface ParaCtx {
  /** The SOURCE element ("h" | "p") — close events match on this. */
  elem: "h" | "p";
  /** Effective kind (a text:p styled as a heading converts to "h"). */
  kind: "h" | "p";
  /** text:outline-level for headings (clamped later). */
  level: number;
  /** Open text:list count at open time (0 = not a list item). */
  listDepth: number;
  resolved: OdtResolvedStyle;
  baseBold: boolean;
  baseItalic: boolean;
  runs: OdtRun[];
  inDeletion: boolean;
  /** Literal number captured from text:number (marker para only). */
  itemNumber: string | null;
  isMarkerPara: boolean;
}

export interface OdtContent {
  blocks: OdtDocBlock[];
  /** draw:image elements seen in content.xml (skipped in v1, honestly). */
  imageCount: number;
  /** office:body appeared at all. */
  sawBody: boolean;
  /** office:text appeared (ODS/ODP bodies have office:spreadsheet etc.). */
  sawTextBody: boolean;
}

/**
 * ODF text-node semantics: line breaks belong to <text:line-break/> and
 * tabs to <text:tab/>, so raw \r\n in a text node is a pretty-printing
 * artifact — a whitespace-only node is indentation (dropped), anything
 * else collapses the newline region to one space. A literal tab becomes
 * one space. No-newline text is kept verbatim (trailing space between
 * a text node and a <text:span> is real content).
 */
function odtTextNode(text: string): string {
  if (/[\r\n]/.test(text)) {
    if (text.trim().length === 0) return "";
    return text.replace(/\s*[\r\n]+\s*/g, " ");
  }
  return text.indexOf("\t") === -1 ? text : text.split("\t").join(" ");
}

/** Parses content.xml (body walk) against a resolved style table. */
export function parseContentXml(
  xml: string,
  styles: OdtStyleTable
): OdtContent {
  const blocks: OdtDocBlock[] = [];
  const paraStack: ParaCtx[] = [];
  const spanStack: Array<{ bold?: boolean; italic?: boolean }> = [];
  const itemStack: Array<{ number: string; used: boolean }> = [];
  let listDepth = 0;
  let deletionDepth = 0;
  let numberDepth = 0;
  let imageCount = 0;
  let sawBody = false;
  let sawTextBody = false;
  /** The still-open list item's block (continuation paragraphs merge in). */
  let openItemRuns: OdtRun[] | null = null;

  const pushRun = (text: string): void => {
    if (deletionDepth > 0 || text.length === 0) return;
    const ctx = paraStack[paraStack.length - 1];
    if (ctx === undefined) return;
    const span = spanStack[spanStack.length - 1];
    const bold =
      span !== undefined && span.bold !== undefined ? span.bold : ctx.baseBold;
    const italic =
      span !== undefined && span.italic !== undefined
        ? span.italic
        : ctx.baseItalic;
    ctx.runs.push({ text, bold, italic });
  };

  const pushPara = (elem: "h" | "p", attrs: Record<string, string>): void => {
    let kind: "h" | "p" = elem;
    const styleName = attr(attrs, "style-name") ?? null;
    const resolved =
      styleName !== null ? resolveOdtStyle(styles, styleName) : {};
    let level = 1;
    if (kind === "h") {
      const ol = Number(attr(attrs, "outline-level"));
      level =
        Number.isFinite(ol) && ol >= 1
          ? Math.floor(ol)
          : (resolved.outlineLevel ?? 1);
    } else if (resolved.outlineLevel !== undefined) {
      // A paragraph styled as a heading (no text:h element) still is one.
      kind = "h";
      level = resolved.outlineLevel;
    }
    const ctx: ParaCtx = {
      elem,
      kind,
      level: Math.min(10, Math.max(1, level)),
      listDepth,
      resolved,
      baseBold: resolved.bold ?? false,
      baseItalic: resolved.italic ?? false,
      runs: [],
      inDeletion: deletionDepth > 0,
      itemNumber: null,
      isMarkerPara: false,
    };
    if (kind === "p" && listDepth > 0 && itemStack.length > 0) {
      const top = itemStack[itemStack.length - 1];
      if (!top.used) {
        top.used = true;
        ctx.isMarkerPara = true;
        ctx.itemNumber = top.number.trim();
      }
    }
    paraStack.push(ctx);
  };

  const finishPara = (elem: "h" | "p"): void => {
    const ctx = paraStack[paraStack.length - 1];
    if (ctx === undefined || ctx.elem !== elem) return; // stray close
    paraStack.pop();
    if (ctx.inDeletion || deletionDepth > 0) return;
    const text = ctx.runs.map((run) => run.text).join("");
    if (ctx.kind === "h") {
      if (text.trim().length === 0) return;
      const level = Math.min(6, Math.max(1, ctx.level));
      blocks.push({
        kind: "heading",
        level,
        sizePt: ctx.resolved.sizePt ?? DEFAULT_HEADING_SIZES_PT[level - 1],
        bold: ctx.resolved.bold ?? true,
        runs: ctx.runs,
      });
      openItemRuns = null;
      return;
    }
    if (ctx.isMarkerPara) {
      if (text.trim().length === 0) return;
      const block: OdtDocBlock = {
        kind: "listItem",
        depth: Math.max(0, ctx.listDepth - 1),
        number:
          ctx.itemNumber !== null && ctx.itemNumber.length > 0
            ? ctx.itemNumber
            : null,
        runs: ctx.runs,
      };
      blocks.push(block);
      openItemRuns = block.runs;
      return;
    }
    if (ctx.listDepth > 0 && openItemRuns !== null) {
      // A second paragraph of the same list item stays inside the item
      // (hard break) instead of spawning a phantom extra bullet.
      if (text.trim().length > 0) {
        openItemRuns.push({ text: "\n", bold: false, italic: false });
        for (const run of ctx.runs) openItemRuns.push(run);
      }
      return;
    }
    if (text.trim().length === 0) {
      blocks.push({ kind: "spacer" });
      return;
    }
    blocks.push({ kind: "para", runs: ctx.runs });
    openItemRuns = null;
  };

  scanXmlTags(
    xml,
    (tag) => {
      const ln = localName(tag.name);
      if (tag.closing) {
        if (ln === "span") {
          spanStack.pop();
        } else if (ln === "list") {
          if (listDepth > 0) listDepth -= 1;
        } else if (ln === "list-item") {
          itemStack.pop();
          openItemRuns = null;
        } else if (ln === "deletion") {
          if (deletionDepth > 0) deletionDepth -= 1;
        } else if (ln === "number") {
          if (numberDepth > 0) numberDepth -= 1;
        } else if (ln === "p" || ln === "h") {
          finishPara(ln);
        }
        return;
      }
      if (ln === "body") {
        sawBody = true;
      } else if (ln === "text") {
        sawTextBody = true;
      } else if (ln === "h" || ln === "p") {
        pushPara(ln, tag.attrs);
        if (tag.selfClosing) finishPara(ln);
      } else if (ln === "span") {
        const styleName = attr(tag.attrs, "style-name");
        const resolved =
          styleName !== undefined && styleName.length > 0
            ? resolveOdtStyle(styles, styleName)
            : {};
        spanStack.push({ bold: resolved.bold, italic: resolved.italic });
      } else if (ln === "list") {
        listDepth += 1;
      } else if (ln === "list-item") {
        itemStack.push({ number: "", used: false });
      } else if (ln === "deletion") {
        deletionDepth += 1;
      } else if (ln === "number") {
        numberDepth += 1;
      } else if (ln === "s") {
        pushRun(" ".repeat(attrCount(tag.attrs, 1)));
      } else if (ln === "tab") {
        pushRun("    ");
      } else if (ln === "line-break") {
        pushRun("\n");
      } else if (ln === "image") {
        imageCount += 1;
      }
      // everything else (frames, text boxes, tables, links, fields,
      // sections, tracked-changes wrappers) is transparent — the text
      // inside flows through as paragraphs (the honest v1 flatten)
    },
    (text, raw) => {
      if (deletionDepth > 0) return;
      if (numberDepth > 0) {
        // Literal list-item number text (written by some producers).
        if (itemStack.length > 0) {
          itemStack[itemStack.length - 1].number += raw
            ? text
            : unescapeXml(text);
        }
        return;
      }
      pushRun(odtTextNode(raw ? text : unescapeXml(text)));
    }
  );
  // Flush paragraphs left open by a truncated/malformed tail.
  while (paraStack.length > 0) finishPara(paraStack[paraStack.length - 1].elem);
  return { blocks, imageCount, sawBody, sawTextBody };
}

/* ------------------------------------------------------------------ */
/* The package reader                                                   */
/* ------------------------------------------------------------------ */

/** Why a package could not be read as an .odt. */
export type OdtParseFailure = "not-zip" | "not-odt";

export class OdtParseError extends Error {
  readonly failure: OdtParseFailure;

  constructor(failure: OdtParseFailure) {
    super(failure);
    this.name = "OdtParseError";
    this.failure = failure;
  }
}

export interface ParsedOdt {
  blocks: OdtDocBlock[];
  /** Non-whitespace characters across all blocks (the empty guard). */
  charCount: number;
  /** draw:image elements seen (v1 renders none — the FAQ says so). */
  imageCount: number;
  /** The mimetype part, when the package carries one. */
  mimetype: string | null;
  /** office:body was present. */
  sawBody: boolean;
  /** office:text was present (a spreadsheet/presentation body is not). */
  sawTextBody: boolean;
}

function decodeStrictUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * bytes → blocks + styles. Throws OdtParseError("not-zip") for a non-zip
 * and OdtParseError("not-odt") for a zip without content.xml or with a
 * content part that is not strict UTF-8. A missing/broken styles.xml
 * degrades to the default ladder, not to a dead tool.
 */
export function parseOdtBytes(bytes: Uint8Array): ParsedOdt {
  let parts: Record<string, Uint8Array>;
  try {
    parts = unzipSync(bytes);
  } catch {
    throw new OdtParseError("not-zip");
  }
  const contentBytes = parts["content.xml"];
  if (contentBytes === undefined) {
    throw new OdtParseError("not-odt");
  }
  const contentXml = decodeStrictUtf8(contentBytes);
  if (contentXml === null) {
    throw new OdtParseError("not-odt");
  }

  // styles.xml (named + automatic) first, then content.xml's own
  // automatic-styles — content references win on a name collision.
  const styles: OdtStyleTable = new Map();
  const stylesBytes = parts["styles.xml"];
  if (stylesBytes !== undefined) {
    const stylesXml = decodeStrictUtf8(stylesBytes);
    if (stylesXml !== null) {
      for (const [name, entry] of parseStylesXml(stylesXml)) {
        styles.set(name, entry);
      }
    }
  }
  for (const [name, entry] of parseStylesXml(contentXml)) {
    styles.set(name, entry);
  }

  const content = parseContentXml(contentXml, styles);
  let charCount = 0;
  for (const block of content.blocks) {
    if (block.kind === "spacer") continue;
    for (const run of block.runs) {
      charCount += run.text.split(/\s/).join("").length;
    }
  }
  let mimetype: string | null = null;
  const mimeBytes = parts["mimetype"];
  if (mimeBytes !== undefined) {
    mimetype = new TextDecoder("utf-8").decode(mimeBytes).trim();
  }
  return {
    blocks: content.blocks,
    charCount,
    imageCount: content.imageCount,
    mimetype,
    sawBody: content.sawBody,
    sawTextBody: content.sawTextBody,
  };
}
