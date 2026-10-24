import type { OptionValues } from "@/lib/tools/config-types";
import type {
  List,
  ListItem,
  PhrasingContent,
  Root,
  RootContent,
} from "mdast";

/**
 * Markdown → PDF engine (PRD §8.6) — PURE. `parseMarkdown` walks the mdast
 * (mdast-util-from-markdown@2.0.2, MIT — chosen over "marked" because our
 * layout engine needs the AST, not HTML) into a small document model;
 * `layoutMd` wraps + paginates it into draw-ready runs and rects. The worker
 * only maps fonts/colors and paints. Everything here is verifiable
 * headlessly with bun (scripts/smoke-md2pdf.ts).
 *
 * Shared wrap/flow/script machinery lives in ../txt-to-pdf/text-layout.ts
 * (file ownership keeps it there — imported here with permission).
 *
 * Supported mdast nodes: heading (1-6), paragraph, list (ordered/unordered,
 * nested via listItem depth), listItem, code, inlineCode, strong, emphasis,
 * link (blue text + numbered footnote + "Links" section at the end), break,
 * blockquote (indent + bar + muted text), thematicBreak, text,
 * linkReference/imageReference (resolved when a matching definition exists,
 * literal "[label]" otherwise), image (audit R4-a: a BLOCK-LEVEL image —
 * a paragraph containing only the image — becomes an "image" block that
 * the worker embeds when the user dropped a matching local file; inline
 * images, remote http(s) URLs and unmatched files keep the honest
 * "[alt]" text — no network, on-device promise). Omissions documented in
 * the tool FAQ + code: html nodes skipped, GFM tables not parsed by core
 * mdast (they surface as plain paragraph text), no syntax coloring in
 * code blocks.
 *
 * Honest v1 font limits: Devanagari (or any non-WinAnsi block) renders in
 * the regular embedded Noto — no bold/italic/mono variants exist for it
 * yet; links are footnote-style, not clickable annotations (pdf-lib has
 * no high-level link annotation API on drawText — a v2 candidate).
 *
 * Known upstream parser quirk (micromark@4.0.2, verified against its own
 * HTML output): an UNRESOLVED reference whose label starts with a
 * lowercase "m" (≥2 chars) loses its first two literal chars ("[m") —
 * e.g. "![m..][undef]" renders one "m" short. Resolved references are
 * unaffected. Pinned dependency; documented, not worked around.
 */

import {
  blockScript,
  MM_TO_PT,
  PAGE_SIZES,
  PageFlow,
  planLineGroup,
  positionRuns,
  splitRunsAtBreaks,
  wrapRuns,
  type FontSpec,
  type MeasureRun,
  type PageGeometry,
  type PageSizeId,
  type PositionedTextRun,
  type ScriptFont,
  type WrapRun,
} from "../txt-to-pdf/text-layout";

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

export interface MdOptions {
  pageSize: PageSizeId;
  /** Page margin in mm (10–40). */
  margin: number;
  /** Body font size in pt (10/11/12). */
  bodySize: number;
  /** Code font size in pt (8/9/10). */
  monoSize: number;
  theme: "clean" | "warm";
}

function pickNumber(
  value: unknown,
  allowed: number[],
  fallback: number
): number {
  const n = typeof value === "number" ? value : Number(value);
  return allowed.includes(n) ? n : fallback;
}

/** Coerces raw panel values into typed options. */
export function resolveMdOptions(values: OptionValues): MdOptions {
  const margin = Number(values.margin);
  return {
    pageSize: values.pageSize === "letter" ? "letter" : "a4",
    margin: Number.isFinite(margin)
      ? Math.min(40, Math.max(10, margin))
      : 20,
    bodySize: pickNumber(values.bodySize, [10, 11, 12], 11),
    monoSize: pickNumber(values.monoSize, [8, 9, 10], 9),
    theme: values.theme === "warm" ? "warm" : "clean",
  };
}

/* ------------------------------------------------------------------ */
/* Document model (mdast → blocks)                                     */
/* ------------------------------------------------------------------ */

export interface MdInlineRun {
  text: string;
  bold: boolean;
  italic: boolean;
  /** Inline code → mono family. */
  code: boolean;
  /** Link text → blue + numbered footnote marker after it. */
  link: boolean;
  /** The [n] marker itself — superscript-ish. */
  sup: boolean;
}

export type MdBlock =
  | { kind: "heading"; level: number; runs: MdInlineRun[] }
  | { kind: "paragraph"; runs: MdInlineRun[] }
  | { kind: "code"; lines: string[] }
  | { kind: "rule" }
  | { kind: "image"; url: string; alt: string }
  | { kind: "quote"; children: MdBlock[] }
  | {
      kind: "listItem";
      depth: number;
      ordered: boolean;
      number: number;
      runs: MdInlineRun[];
    };

export interface ParsedMarkdown {
  blocks: MdBlock[];
  /** Numbered link targets, in marker order (1-based index + 1). */
  links: string[];
}

interface ParseCtx {
  links: string[];
  defs: Map<string, string>;
}

function baseRun(text: string): MdInlineRun {
  return {
    text,
    bold: false,
    italic: false,
    code: false,
    link: false,
    sup: false,
  };
}

function sameStyle(a: MdInlineRun, b: MdInlineRun): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.code === b.code &&
    a.link === b.link &&
    a.sup === b.sup
  );
}

/** Merges adjacent runs with identical style (fewer draw calls). */
function mergeRuns(runs: MdInlineRun[]): MdInlineRun[] {
  const out: MdInlineRun[] = [];
  for (const run of runs) {
    if (run.text.length === 0) continue;
    const last = out[out.length - 1];
    if (
      last &&
      sameStyle(last, run) &&
      last.text !== "\n" &&
      run.text !== "\n"
    ) {
      last.text += run.text;
    } else {
      out.push({ ...run });
    }
  }
  return out;
}

interface InlineStyle {
  bold: boolean;
  italic: boolean;
  link: boolean;
}

function walkPhrasing(
  nodes: readonly PhrasingContent[],
  style: InlineStyle,
  ctx: ParseCtx,
  out: MdInlineRun[]
): void {
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out.push({
          ...baseRun(node.value),
          bold: style.bold,
          italic: style.italic,
          link: style.link,
        });
        break;
      case "emphasis":
        walkPhrasing(
          node.children,
          { ...style, italic: true },
          ctx,
          out
        );
        break;
      case "strong":
        walkPhrasing(node.children, { ...style, bold: true }, ctx, out);
        break;
      case "inlineCode":
        out.push({ ...baseRun(node.value), code: true });
        break;
      case "break":
        out.push(baseRun("\n"));
        break;
      case "link": {
        walkPhrasing(node.children, { ...style, link: true }, ctx, out);
        const n = ctx.links.push(node.url);
        out.push({
          ...baseRun(` [${n}]`),
          link: true,
          sup: true,
        });
        break;
      }
      case "linkReference": {
        const url = ctx.defs.get(node.identifier);
        if (url !== undefined) {
          walkPhrasing(node.children, { ...style, link: true }, ctx, out);
          const n = ctx.links.push(url);
          out.push({ ...baseRun(` [${n}]`), link: true, sup: true });
        } else {
          out.push(baseRun(`[${node.label ?? node.identifier}]`));
        }
        break;
      }
      case "image":
        out.push({ ...baseRun(`[${node.alt ?? ""}]`), italic: true });
        break;
      case "imageReference": {
        const url = ctx.defs.get(node.identifier);
        const alt = `[${node.alt ?? ""}]`;
        if (url !== undefined) {
          const n = ctx.links.push(url);
          out.push({ ...baseRun(`${alt} [${n}]`), link: true, sup: true });
        } else {
          out.push({ ...baseRun(alt), italic: true });
        }
        break;
      }
      case "html":
        // inline raw HTML — skipped (honest omission, see FAQ)
        break;
      default:
        break;
    }
  }
}

function inlineRuns(
  nodes: readonly PhrasingContent[],
  ctx: ParseCtx
): MdInlineRun[] {
  const out: MdInlineRun[] = [];
  walkPhrasing(nodes, { bold: false, italic: false, link: false }, ctx, out);
  return mergeRuns(out);
}

/** Collects reference definitions anywhere in the document (label → url). */
function collectDefinitions(
  nodes: readonly RootContent[],
  into: Map<string, string>
): void {
  for (const node of nodes) {
    if (node.type === "definition") {
      into.set(node.identifier, node.url);
    } else if ("children" in node && Array.isArray(node.children)) {
      collectDefinitions(
        node.children as RootContent[],
        into
      );
    }
  }
}

function codeLines(value: string): string[] {
  const cleaned = value.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
  const lines = cleaned.split("\n");
  // fenced blocks implicitly end with a newline — drop that phantom line
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * A paragraph is a block-level image when its only phrasing child is one
 * `image` node (or one `imageReference` that resolves to a definition).
 * Returns the url + alt for the embed resolver, else null.
 */
function soleImageNode(
  nodes: readonly PhrasingContent[],
  ctx: ParseCtx
): { url: string; alt: string } | null {
  if (nodes.length !== 1) return null;
  const node = nodes[0];
  if (node.type === "image") {
    return { url: node.url, alt: node.alt ?? "" };
  }
  if (node.type === "imageReference") {
    const url = ctx.defs.get(node.identifier);
    if (url !== undefined) {
      return { url, alt: node.alt ?? "" };
    }
  }
  return null;
}

function walkBlocks(
  nodes: readonly RootContent[],
  ctx: ParseCtx,
  out: MdBlock[],
  depth: number
): void {
  for (const node of nodes) {
    switch (node.type) {
      case "heading":
        out.push({
          kind: "heading",
          level: node.depth,
          runs: inlineRuns(node.children, ctx),
        });
        break;
      case "paragraph": {
        // Block-level image: a paragraph whose ONLY child is one image
        // (or one reference-resolved imageReference) — audit R4-a. The
        // worker decides embed vs honest "[alt]" text at layout time.
        const sole = soleImageNode(node.children, ctx);
        if (sole !== null) {
          out.push({ kind: "image", url: sole.url, alt: sole.alt });
        } else {
          out.push({
            kind: "paragraph",
            runs: inlineRuns(node.children, ctx),
          });
        }
        break;
      }
      case "code":
        out.push({ kind: "code", lines: codeLines(node.value) });
        break;
      case "thematicBreak":
        out.push({ kind: "rule" });
        break;
      case "blockquote":
        out.push({
          kind: "quote",
          children: walkBlocksInto(node.children, ctx),
        });
        break;
      case "list": {
        const list = node as List;
        const start = typeof list.start === "number" ? list.start : 1;
        const hoisted: MdBlock[] = [];
        list.children.forEach((item, index) => {
          hoisted.push(...listItemBlocks(item, ctx, depth, list.ordered === true, start + index));
        });
        out.push(...hoisted);
        break;
      }
      case "html":
      case "definition":
        // block raw HTML / reference definitions — skipped (see FAQ)
        break;
      default:
        break;
    }
  }
}

/**
 * One mdast listItem → its own block (phrasing content merged with hard
 * breaks) + nested lists flattened as deeper item blocks. Block-level
 * code/quote/heading inside an item is hoisted as a top-level block right
 * after the list (a documented v1 simplification — rare in the wild).
 */
function listItemBlocks(
  item: ListItem,
  ctx: ParseCtx,
  depth: number,
  ordered: boolean,
  number: number
): MdBlock[] {
  const out: MdBlock[] = [];
  const runs: MdInlineRun[] = [];
  const after: MdBlock[] = [];
  for (const child of item.children) {
    if (child.type === "paragraph") {
      if (runs.length > 0) runs.push(baseRun("\n"));
      runs.push(...inlineRuns(child.children, ctx));
    } else if (child.type === "list") {
      const list = child as List;
      const start = typeof list.start === "number" ? list.start : 1;
      list.children.forEach((nested, index) => {
        after.push(
          ...listItemBlocks(
            nested,
            ctx,
            depth + 1,
            list.ordered === true,
            start + index
          )
        );
      });
    } else if (child.type === "blockquote") {
      after.push({
        kind: "quote",
        children: walkBlocksInto(child.children, ctx),
      });
    } else if (child.type === "code") {
      after.push({ kind: "code", lines: codeLines(child.value) });
    } else if (child.type === "heading") {
      after.push({
        kind: "heading",
        level: child.depth,
        runs: inlineRuns(child.children, ctx),
      });
    } else if (child.type === "thematicBreak") {
      after.push({ kind: "rule" });
    }
    // html/definition inside items: skipped like everywhere else
  }
  if (runs.length > 0) {
    out.push({ kind: "listItem", depth, ordered, number, runs: mergeRuns(runs) });
  }
  out.push(...after);
  return out;
}

function walkBlocksInto(
  nodes: readonly RootContent[],
  ctx: ParseCtx
): MdBlock[] {
  const out: MdBlock[] = [];
  walkBlocks(nodes, ctx, out, 0);
  return out;
}

/** Parses markdown source into the document model + numbered links.
 *
 * The mdast parser is INJECTED (not imported): Turbopack's dev worker
 * loader compiles workers to classic blob scripts where the ESM-only
 * mdast-util-from-markdown graph cannot be imported (SyntaxError with no
 * message — found in P4.1 browser QA). The worker loads the precompiled
 * classic bundle public/md/md-parser.js instead; smokes running under bun
 * pass the ESM `fromMarkdown` directly. mdast type-only imports are erased
 * at compile time, so this file stays out of the worker's chunk graph.
 */
export function parseMarkdown(
  source: string,
  parse: (source: string) => Root
): ParsedMarkdown {
  const root = parse(source);
  const ctx: ParseCtx = { links: [], defs: new Map() };
  collectDefinitions(root.children, ctx.defs);
  const blocks: MdBlock[] = [];
  walkBlocks(root.children, ctx, blocks, 0);
  return { blocks, links: ctx.links };
}


/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

export type RunColor = "text" | "muted" | "link";
export type RectKind = "codeBg" | "quoteBar" | "rule";

export interface MdRectDraw {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: RectKind;
}

/** One placed block image — page coords like the rects (pdf-lib, y up). */
export interface MdImageDraw {
  /** The markdown url the worker resolves back to the embedded image. */
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MdPageDraw {
  runs: PositionedTextRun[];
  rects: MdRectDraw[];
  /** Block images placed on this page (audit R4-a). */
  images: MdImageDraw[];
  /** Warm paper theme paints a cream page background first. */
  warm: boolean;
}

/** Intrinsic pixel dims of one resolved image asset, keyed by url. */
export type MdImageDims = Map<string, { width: number; height: number }>;

export interface MdLayoutResult {
  pages: MdPageDraw[];
  linkCount: number;
  /** Block images embedded into the layout (resolvable in `images`). */
  imageCount: number;
  /** Block images that fell back to honest "[alt]" text (remote,
   *  unmatched or unsupported — never silently dropped). */
  imagesSkipped: number;
}

/** h1…h6 sizes in pt. */
const HEADING_SIZES = [22, 18, 15, 13, 12, 11];
/** h1…h6 [spaceBefore, spaceAfter] in pt. */
const HEADING_SPACING: [number, number][] = [
  [16, 8],
  [14, 7],
  [12, 6],
  [10, 5],
  [9, 5],
  [8, 4],
];
const HEADING_LINE_HEIGHT = 1.3;
const BODY_LINE_HEIGHT = 1.5;
const MONO_LINE_HEIGHT = 1.35;
const CODE_PAD = 6;
const LIST_INDENT = 18;
const MARKER_GAP = 6;
const QUOTE_INDENT = 12;
const QUOTE_BAR_WIDTH = 3;
const QUOTE_BAR_OVERHANG = 2;
const RULE_THICKNESS = 0.75;
/** Gap before a paragraph-ish block, in body advances. */
const BLOCK_GAP = 0.45;
const ITEM_GAP = 0.25;

const MARKERS = ["•", "–", "·"];

function fontSpecFor(run: MdInlineRun): FontSpec {
  if (run.code) return { family: "mono", bold: false, italic: false };
  return { family: "sans", bold: run.bold, italic: run.italic };
}

function runsText(runs: readonly MdInlineRun[]): string {
  return runs.map((run) => run.text).join("");
}

/** Rough advance of a block's first line — heading keep-with-next math. */
function firstLineAdvance(
  block: MdBlock,
  bodyAdvance: number,
  monoAdvance: number
): number {
  switch (block.kind) {
    case "heading":
      return (
        HEADING_SIZES[Math.min(6, Math.max(1, block.level)) - 1] *
        HEADING_LINE_HEIGHT
      );
    case "code":
      return monoAdvance;
    case "image":
    case "quote":
    case "paragraph":
    case "listItem":
    case "rule":
      return bodyAdvance;
  }
}

export function layoutMd(
  parsed: ParsedMarkdown,
  options: MdOptions,
  measure: MeasureRun,
  /** Intrinsic dims of the images the caller embedded (worker) — an
   *  image block whose url is absent here degrades to the honest
   *  "[alt]" text paragraph (remote/unmatched/unsupported). */
  images?: MdImageDims
): MdLayoutResult {
  const { blocks, links } = parsed;
  const size = PAGE_SIZES[options.pageSize];
  const marginPt = options.margin * MM_TO_PT;
  const geometry: PageGeometry = {
    pageW: size.width,
    pageH: size.height,
    marginLeft: marginPt,
    marginRight: marginPt,
    marginTop: marginPt,
    marginBottom: marginPt,
  };
  const flow = new PageFlow(geometry);
  const pages: MdPageDraw[] = [
    { runs: [], rects: [], images: [], warm: options.theme === "warm" },
  ];
  const ensurePage = (index: number): MdPageDraw => {
    while (pages.length <= index) {
      pages.push({
        runs: [],
        rects: [],
        images: [],
        warm: options.theme === "warm",
      });
    }
    return pages[index];
  };

  let imageCount = 0;
  let imagesSkipped = 0;

  const bodyAdvance = options.bodySize * BODY_LINE_HEIGHT;
  const monoAdvance = options.monoSize * MONO_LINE_HEIGHT;
  const monoSpec: FontSpec = { family: "mono", bold: false, italic: false };
  const sansSpec: FontSpec = { family: "sans", bold: false, italic: false };

  /** Open quote extents, innermost last: per-page line extents. */
  const quoteStack: {
    extents: { page: number; top: number; bottom: number }[];
  }[] = [];

  let indent = 0;
  let muted = false;
  let gapScale = 1;
  let placedAny = false;
  /** Open-quote nesting (muted stays on when an INNER quote closes). */
  let quoteDepth = 0;

  const contentLeft = (): number => geometry.marginLeft + indent;

  const toWrapRuns = (runs: readonly MdInlineRun[]): WrapRun[] => {
    const out: WrapRun[] = [];
    for (const run of runs) {
      const color: RunColor = run.link
        ? "link"
        : muted
          ? "muted"
          : "text";
      out.push({
        text: run.text,
        spec: fontSpecFor(run),
        color,
        sup: run.sup,
      });
    }
    return out;
  };

  /**
   * Wraps one run group (hard-break segments flow without extra gaps) and
   * places it with orphan/widow protection. Registers extents with every
   * open quote so their bars size correctly across page breaks.
   */
  const placeRuns = (
    runs: readonly MdInlineRun[],
    x: number,
    maxWidth: number,
    fontSize: number,
    advance: number
  ): { page: number; top: number; bottom: number; baseline: number }[] => {
    const script = blockScript(runsText(runs));
    const segments = splitRunsAtBreaks(toWrapRuns(runs));
    const allLines: WrapRun[][] = [];
    for (const segment of segments) {
      if (segment.length === 0) {
        allLines.push([]);
        continue;
      }
      allLines.push(
        ...wrapRuns(segment, { maxWidth, size: fontSize, script, measure })
      );
    }
    const placements = planLineGroup(flow, allLines.length, advance, fontSize);
    const extents: {
      page: number;
      top: number;
      bottom: number;
      baseline: number;
    }[] = [];
    for (let i = 0; i < placements.length; i += 1) {
      const place = placements[i];
      const page = ensurePage(place.pageIndex);
      page.runs.push(
        ...positionRuns(allLines[i], x, place.baseline, fontSize, script, measure)
      );
      const extent = {
        page: place.pageIndex,
        top: place.top,
        bottom: place.top + advance,
        baseline: place.baseline,
      };
      extents.push(extent);
      for (const open of quoteStack) open.extents.push(extent);
    }
    return extents;
  };

  const gapBefore = (gap: number): void => {
    if (!placedAny) return;
    flow.consumeGap(gap * gapScale);
  };

  const placeCodeBlock = (lines: string[]): void => {
    if (lines.length === 0) return;
    const blockX = contentLeft();
    // Wrapped + positioned per VISUAL line — a source line wider than the
    // block wraps into continuation lines (never truncated; indentation is
    // preserved as an x offset per line)
    const indentWidths = lines.map((line) => {
      const indentMatch = /^[ ]*/.exec(line);
      const indentText = indentMatch ? indentMatch[0] : "";
      return {
        text: indentText,
        width: measure(indentText, monoSpec, options.monoSize, "std"),
        body: line.slice(indentText.length).replace(/[ ]+$/, ""),
      };
    });
    const maxIndent = indentWidths.reduce(
      (max, entry) => Math.max(max, entry.width),
      0
    );
    const wrapWidth = Math.max(
      24,
      flow.contentWidth - indent - 2 * CODE_PAD - maxIndent
    );
    const wrappedLines: {
      runs: WrapRun[];
      script: ScriptFont;
      indent: number;
    }[] = [];
    for (const entry of indentWidths) {
      const script = blockScript(entry.text + entry.body || " ");
      const wrapped = wrapRuns([{ text: entry.body, spec: monoSpec }], {
        maxWidth: wrapWidth,
        size: options.monoSize,
        script,
        measure,
      });
      for (const lineRuns of wrapped) {
        wrappedLines.push({ runs: lineRuns, script, indent: entry.width });
      }
    }
    const height = wrappedLines.length * monoAdvance + 2 * CODE_PAD;
    // ≤3-line blocks never split across pages (when a full page could hold
    // them); longer blocks split without 1-line fragments (strictSingle)
    if (
      lines.length <= 3 &&
      flow.pageHasContent &&
      !flow.fits(height) &&
      height <= flow.contentHeight
    ) {
      flow.breakPage();
    }
    gapBefore(bodyAdvance * BLOCK_GAP);

    const placements = planLineGroup(
      flow,
      wrappedLines.length,
      monoAdvance,
      options.monoSize,
      true,
      CODE_PAD
    );
    const fragmentByPage = new Map<number, { top: number; count: number }>();
    for (let i = 0; i < placements.length; i += 1) {
      const place = placements[i];
      const fragment = fragmentByPage.get(place.pageIndex);
      if (fragment) {
        fragment.count += 1;
      } else {
        fragmentByPage.set(place.pageIndex, { top: place.top, count: 1 });
      }
      const line = wrappedLines[i];
      const page = ensurePage(place.pageIndex);
      page.runs.push(
        ...positionRuns(
          line.runs,
          blockX + CODE_PAD + line.indent,
          place.baseline,
          options.monoSize,
          line.script,
          measure
        )
      );
      const extent = {
        page: place.pageIndex,
        top: place.top,
        bottom: place.top + monoAdvance,
      };
      for (const open of quoteStack) open.extents.push(extent);
    }
    for (const [pageIndex, fragment] of fragmentByPage) {
      const page = ensurePage(pageIndex);
      // no top padding when the fragment starts at the content top — the
      // page margin already provides the gap there
      const topPad = fragment.top > 0 ? CODE_PAD : 0;
      const topY =
        geometry.pageH - geometry.marginTop - fragment.top + topPad;
      page.rects.push({
        x: blockX,
        y: topY - fragment.count * monoAdvance - topPad - CODE_PAD,
        w: flow.contentWidth - indent,
        h: fragment.count * monoAdvance + topPad + CODE_PAD,
        kind: "codeBg",
      });
    }
  };

  const placeBlock = (
    block: MdBlock,
    next: MdBlock | null
  ): void => {
    const bodyGap = bodyAdvance * BLOCK_GAP;
    switch (block.kind) {
      case "heading": {
        const level = Math.min(6, Math.max(1, block.level));
        const fontSize = HEADING_SIZES[level - 1];
        const advance = fontSize * HEADING_LINE_HEIGHT;
        // keep-with-next: the heading + its spacing + ~2 lines of the
        // following block, else the heading never dangles at a page bottom
        // (the gaps count too — they are consumed after this check)
        const [spaceBefore, spaceAfter] = HEADING_SPACING[level - 1];
        const nextAdvance = next
          ? firstLineAdvance(next, bodyAdvance, monoAdvance)
          : bodyAdvance;
        const needed =
          spaceBefore * gapScale +
          advance +
          spaceAfter * gapScale +
          bodyAdvance * BLOCK_GAP * gapScale +
          2 * nextAdvance;
        if (flow.pageHasContent && !flow.fits(needed)) flow.breakPage();
        gapBefore(spaceBefore);
        const headingRuns: MdInlineRun[] = block.runs.map((run) => ({
          ...run,
          bold: true,
          italic: level === 6,
          code: false,
        }));
        placeRuns(
          headingRuns,
          contentLeft(),
          flow.contentWidth - indent,
          fontSize,
          advance
        );
        gapBefore(spaceAfter);
        break;
      }
      case "paragraph": {
        if (block.runs.length === 0) return;
        gapBefore(bodyGap);
        placeRuns(
          block.runs,
          contentLeft(),
          flow.contentWidth - indent,
          options.bodySize,
          bodyAdvance
        );
        break;
      }
      case "image": {
        const dims = images?.get(block.url);
        if (!dims || dims.width <= 0 || dims.height <= 0) {
          // Honest fallback — the exact "[alt]" paragraph v1 printed for
          // every image (remote URLs keep it forever: no network).
          gapBefore(bodyGap);
          placeRuns(
            [{ ...baseRun(`[${block.alt}]`), italic: true }],
            contentLeft(),
            flow.contentWidth - indent,
            options.bodySize,
            bodyAdvance
          );
          imagesSkipped += 1;
          placedAny = true;
          break;
        }
        // Atomic block: px-as-pt natural size (imagegrid's fit pages),
        // capped at the content box, never upscaled, never split.
        const maxW = Math.max(24, flow.contentWidth - indent);
        const scale = Math.min(
          1,
          maxW / dims.width,
          flow.contentHeight / dims.height
        );
        const w = dims.width * scale;
        const h = dims.height * scale;
        if (flow.pageHasContent && !flow.fits(h)) flow.breakPage();
        gapBefore(bodyGap);
        const page = ensurePage(flow.pageIndex);
        const top = flow.contentTopY();
        page.images.push({
          url: block.url,
          x: contentLeft(),
          y: top - h,
          w,
          h,
        });
        flow.consume(h);
        gapBefore(bodyGap * 0.5);
        imageCount += 1;
        placedAny = true;
        break;
      }
      case "code": {
        placeCodeBlock(block.lines);
        break;
      }
      case "rule": {
        gapBefore(bodyGap);
        if (flow.pageHasContent && !flow.fits(RULE_THICKNESS * 2)) {
          flow.breakPage();
        }
        const page = ensurePage(flow.pageIndex);
        const y = flow.contentTopY() - RULE_THICKNESS;
        page.rects.push({
          x: contentLeft(),
          y,
          w: flow.contentWidth - indent,
          h: RULE_THICKNESS * 2,
          kind: "rule",
        });
        flow.consume(RULE_THICKNESS * 2);
        gapBefore(bodyGap * 0.5);
        break;
      }
      case "quote": {
        gapBefore(bodyGap);
        indent += QUOTE_INDENT;
        quoteDepth += 1;
        muted = true;
        gapScale *= 0.7;
        quoteStack.push({ extents: [] });
        for (let i = 0; i < block.children.length; i += 1) {
          placeBlock(
            block.children[i],
            block.children[i + 1] ?? null
          );
        }
        const open = quoteStack.pop();
        quoteDepth -= 1;
        indent -= QUOTE_INDENT;
        muted = quoteDepth > 0;
        gapScale /= 0.7;
        if (open && open.extents.length > 0) {
          const byPage = new Map<number, { top: number; bottom: number }>();
          for (const extent of open.extents) {
            const span = byPage.get(extent.page);
            if (span) {
              span.top = Math.min(span.top, extent.top);
              span.bottom = Math.max(span.bottom, extent.bottom);
            } else {
              byPage.set(extent.page, {
                top: extent.top,
                bottom: extent.bottom,
              });
            }
          }
          for (const [pageIndex, span] of byPage) {
            const page = ensurePage(pageIndex);
            const topY = geometry.pageH - geometry.marginTop - span.top;
            page.rects.push({
              x: contentLeft(),
              y: topY - span.bottom - QUOTE_BAR_OVERHANG,
              w: QUOTE_BAR_WIDTH,
              h: span.bottom - span.top + 2 * QUOTE_BAR_OVERHANG,
              kind: "quoteBar",
            });
          }
        }
        break;
      }
      case "listItem": {
        gapBefore(bodyAdvance * ITEM_GAP);
        const markerX = contentLeft() + block.depth * LIST_INDENT;
        const marker = block.ordered
          ? `${block.number}.`
          : MARKERS[Math.min(MARKERS.length - 1, block.depth)];
        const markerWidth = measure(
          marker,
          sansSpec,
          options.bodySize,
          "std"
        );
        const textX = markerX + markerWidth + MARKER_GAP;
        const maxWidth = Math.max(
          24,
          geometry.marginLeft + flow.contentWidth - textX
        );
        const extents = placeRuns(
          block.runs,
          textX,
          maxWidth,
          options.bodySize,
          bodyAdvance
        );
        if (extents.length > 0) {
          const page = ensurePage(extents[0].page);
          page.runs.push({
            text: marker,
            x: markerX,
            baseline: extents[0].baseline,
            size: options.bodySize,
            spec: sansSpec,
            script: "std",
            color: muted ? "muted" : "text",
          });
        }
        break;
      }
    }
    if (block.kind !== "paragraph" || block.runs.length > 0) {
      placedAny = true;
    }
  };

  for (let i = 0; i < blocks.length; i += 1) {
    placeBlock(blocks[i], blocks[i + 1] ?? null);
  }

  // Links section: bold "Links" heading + one numbered line per URL. The
  // heading gets the same keep-with-next guarantee as document headings —
  // never the very last line of a page.
  if (links.length > 0) {
    gapBefore(bodyAdvance * BLOCK_GAP);
    const linksAdvance = 12 * HEADING_LINE_HEIGHT;
    if (
      flow.pageHasContent &&
      !flow.fits(linksAdvance + bodyAdvance)
    ) {
      flow.breakPage();
    }
    placeRuns(
      [{ ...baseRun("Links"), bold: true }],
      contentLeft(),
      flow.contentWidth - indent,
      12,
      linksAdvance
    );
    for (let n = 1; n <= links.length; n += 1) {
      placeRuns(
        [baseRun(`${n}. `), { ...baseRun(links[n - 1]), link: true }],
        contentLeft(),
        flow.contentWidth - indent,
        options.bodySize,
        bodyAdvance
      );
    }
  }

  return { pages, linkCount: links.length, imageCount, imagesSkipped };
}

/**
 * Unique image urls in document order (the worker's embed list).
 * Inside quotes/list items images stay honest text, so only top-level
 * blocks are walked — matching what layoutMd can actually embed.
 */
export function collectImageUrls(parsed: ParsedMarkdown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const block of parsed.blocks) {
    if (block.kind === "image" && !seen.has(block.url)) {
      seen.add(block.url);
      out.push(block.url);
    }
  }
  return out;
}

/**
 * Resolves one markdown image url against the dropped asset names by
 * BASENAME (audit R4-a): strips ?query/#hash, decodes %20-style escapes
 * (malformed passes through), takes the last path segment and matches
 * case-insensitively — "images/my photo.png?v=2" hits "My Photo.PNG".
 * Remote http(s)/data urls and unmatched names return null (the layout
 * then keeps the honest "[alt]" text — no network, on-device promise).
 */
export function matchImageAsset(
  url: string,
  assetNames: readonly string[]
): string | null {
  if (/^(https?:|data:|blob:)/i.test(url)) return null;
  let tail = url.split("#")[0] ?? "";
  const q = tail.indexOf("?");
  if (q >= 0) tail = tail.slice(0, q);
  if (tail === "") return null;
  try {
    tail = decodeURIComponent(tail);
  } catch {
    /* malformed escapes pass through */
  }
  const slash = Math.max(tail.lastIndexOf("/"), tail.lastIndexOf("\\"));
  const base = slash >= 0 ? tail.slice(slash + 1) : tail;
  if (base === "") return null;
  const lower = base.toLowerCase();
  return assetNames.find((name) => name.toLowerCase() === lower) ?? null;
}
