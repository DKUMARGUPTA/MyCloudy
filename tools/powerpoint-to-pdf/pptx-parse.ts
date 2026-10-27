import { unzipSync } from "fflate";

import { scanXmlTags, unescapeXml } from "../word-to-pdf/docx-parse";

/**
 * PPTX parser (Task b4-b) — PURE, bun-testable, no DOM, no worker APIs.
 *
 * A .pptx is a PresentationML package: a ZIP whose parts are XML
 * documents plus the embedded media. This module opens the package with
 * fflate's unzipSync (the same library the sibling pptx WRITER zips
 * with) and reads exactly what an honest slides→PDF render needs:
 *
 *   ppt/presentation.xml             — <p:sldSz cx cy> (EMU → pt) + the
 *                                      <p:sldIdLst> r:id ORDER (slides
 *                                      follow this list, not filename
 *                                      order — a reshuffled deck must
 *                                      convert reshuffled)
 *   ppt/_rels/presentation.xml.rels   — rId → slide part paths
 *   ppt/slides/slideN.xml            — <p:sp> text shapes: <a:off>/
 *                                      <a:ext> rect (EMU → pt), <a:p>
 *                                      paragraphs, <a:r> runs with
 *                                      <a:rPr sz b> attrs (sz is
 *                                      HUNDREDTHS of a point) and <a:t>
 *                                      text (entities unescaped); <a:br/>
 *                                      hard breaks SPLIT the runs — the
 *                                      run after a break carries
 *                                      breaksBefore, a trailing break
 *                                      lands on the paragraph's
 *                                      trailingBreaks (the renderer never
 *                                      sees "\n" in run text);
 *                                      <a:pPr algn> alignment. <p:pic>
 *                                      pictures: rect + <a:blip r:embed>
 *                                      rel id.
 *   ppt/slides/_rels/slideN.xml.rels — rId → ../media/imageN.{jpg,png}
 *   ppt/media/*                      — raw image bytes; the renderer
 *                                      dispatches by magic bytes
 *                                      (FFD8FF JPEG vs 89504E47 PNG —
 *                                      zip entries carry no content type
 *                                      we can trust), other formats are
 *                                      skipped AND counted, never faked.
 *
 * The tag walking reuses the stack-driven XML scanner from the
 * word-to-pdf docx parser (same repair-tolerant event model; namespace
 * prefixes kept verbatim — "p:sp", "a:t", "r:embed").
 *
 * V1 honesty (stated in the tool FAQ): shapes inside <p:grpSp> groups
 * are read with their OWN rects (group scaling/chOff is not applied);
 * tables, charts and SmartArt (<p:graphicFrame>) contribute no text;
 * placeholder shapes without their own <a:xfrm> fall back to a 5%-inset
 * full-slide box; theme colours/fonts/backgrounds are not parsed.
 *
 * Robustness: the scanner never throws on malformed XML — stray closes
 * are ignored, unclosed shapes/paragraphs/runs flush at EOF. Structural
 * problems (not a zip, no ppt/presentation.xml, non-UTF-8 parts) throw
 * PptxParseError, which the worker maps to the honest tool.errorCorrupt.
 *
 * iOS-safe (worklog IOS-COMPAT): no matchAll/replaceAll, no regex
 * lookbehind, no Object.hasOwn / structuredClone — split/join and plain
 * exec/test only.
 */

/* ------------------------------------------------------------------ */
/* EMU math (1 pt = 12700 EMU — ECMA-376 Part 1 §20.1.3)               */
/* ------------------------------------------------------------------ */

/** EMU → PDF points. */
export function emuToPt(emu: number): number {
  return emu / 12700;
}

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** Horizontal alignment of one paragraph (justify degrades to left in v1). */
export type SlideAlign = "left" | "center" | "right";

/** One text run inside a paragraph. */
export interface PptxTextRun {
  /** Run text (entities decoded). Never carries hard-break markers —
   *  <a:br/> splits runs; see breaksBefore. */
  text: string;
  /**
   * <a:rPr sz="3200"> — HUNDREDTHS of a point → pt here. null when the
   * run (and its paragraph defaults) declare no size: the renderer
   * auto-fits by box height.
   */
  sizePt: number | null;
  /** <a:rPr b="1"/> (or the paragraph's <a:defRPr b="1"/>). */
  bold: boolean;
  /**
   * Hard breaks (<a:br/>) between the previous run and this one; 0 or
   * missing when none. The renderer starts such a run on a fresh line;
   * each extra break is one blank line (the rtf tool's fixed model —
   * the renderer never sees "\n" in text).
   */
  breaksBefore?: number;
}

/** One <a:p> paragraph. */
export interface PptxParagraph {
  runs: PptxTextRun[];
  align: SlideAlign;
  /** Hard breaks after the last run (trailing <a:br/>): blank lines the
   *  renderer advances before the next paragraph. */
  trailingBreaks?: number;
}

/** A <p:sp> text shape. Rect in pt, PowerPoint top-left origin. */
export interface PptxTextBox {
  kind: "text";
  x: number;
  y: number;
  width: number;
  height: number;
  paragraphs: PptxParagraph[];
}

/** A <p:pic> picture. Rect in pt, top-left origin (renderer flips y). */
export interface PptxPicture {
  kind: "pic";
  x: number;
  y: number;
  width: number;
  height: number;
  /** Resolved media part path ("ppt/media/image1.jpg"), or null when the
   *  relationship is dangling / external. */
  mediaPath: string | null;
  /** Magic-byte dispatch result; null = unsupported/unknown (skipped). */
  mediaKind: MediaKind | null;
}

export type PptxShape = PptxTextBox | PptxPicture;

export interface ParsedSlide {
  /** Shapes in document order — the renderer's z-order. */
  shapes: PptxShape[];
}

export type MediaKind = "jpg" | "png";

export interface ParsedPptx {
  /** Slides in <p:sldIdLst> relationship order. */
  slides: ParsedSlide[];
  /** Presentation slide size (sldSz EMU → pt). */
  widthPt: number;
  heightPt: number;
  /** Every ppt/media/* part path → raw bytes. */
  media: Record<string, Uint8Array>;
  /** Non-whitespace chars across all text runs (the run detail). */
  charCount: number;
  /** Pictures honestly skipped: dangling/external rel, missing part or
   *  an image format pdf-lib cannot embed (WMF/EMF/GIF/TIFF/BMP…). */
  skippedMedia: number;
}

export type PptxParseFailure = "not-zip" | "not-pptx";

export class PptxParseError extends Error {
  readonly failure: PptxParseFailure;

  constructor(failure: PptxParseFailure) {
    super(failure);
    this.name = "PptxParseError";
    this.failure = failure;
  }
}

/* ------------------------------------------------------------------ */
/* Image magic bytes (zip entries carry no usable content type)        */
/* ------------------------------------------------------------------ */

/** JPEG SOI+JFIF marker → "jpg", PNG signature → "png", else null. */
export function detectImageKind(
  bytes: Uint8Array | undefined
): MediaKind | null {
  if (bytes === undefined || bytes.length < 4) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpg";
  }
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "png";
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Part-path resolution (relationship targets are relative)            */
/* ------------------------------------------------------------------ */

/**
 * Resolves a relationship Target against the directory of the part that
 * owns the .rels file: "../media/image1.jpg" from "ppt/slides" →
 * "ppt/media/image1.jpg". Leading "/" is package-absolute.
 */
export function resolvePartPath(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const segments = (baseDir.length > 0 ? baseDir.split("/") : []).concat(
    target.split("/")
  );
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

/** The .rels part path owned by `partPath` ("a/b.xml" → "a/_rels/b.xml.rels"). */
export function relsPartPath(partPath: string): string {
  const slash = partPath.lastIndexOf("/");
  const dir = slash === -1 ? "" : partPath.slice(0, slash);
  const base = slash === -1 ? partPath : partPath.slice(slash + 1);
  return dir.length > 0 ? `${dir}/_rels/${base}.rels` : `_rels/${base}.rels`;
}

/* ------------------------------------------------------------------ */
/* Relationship parts                                                  */
/* ------------------------------------------------------------------ */

export interface PptxRelationship {
  target: string;
  external: boolean;
}

/** Id → relationship for one .rels part (empty on missing/broken part). */
export function parseRelsXml(xml: string): Record<string, PptxRelationship> {
  const rels: Record<string, PptxRelationship> = {};
  scanXmlTags(
    xml,
    (tag) => {
      if (tag.closing || tag.name !== "Relationship") return;
      const id = tag.attrs["Id"];
      const target = tag.attrs["Target"];
      if (
        typeof id === "string" &&
        id.length > 0 &&
        typeof target === "string" &&
        target.length > 0
      ) {
        rels[id] = {
          target,
          external: tag.attrs["TargetMode"] === "External",
        };
      }
    },
    () => {
      /* .rels parts have no text content */
    }
  );
  return rels;
}

/* ------------------------------------------------------------------ */
/* ppt/presentation.xml                                                */
/* ------------------------------------------------------------------ */

/** PowerPoint's widescreen default (13.333 × 7.5 in) when sldSz is absent. */
export const DEFAULT_SLIDE_SIZE_PT = { width: 960, height: 540 };

export interface ParsedPresentation {
  /** r:id values of <p:sldId> entries, in sldIdLst order. */
  slideRids: string[];
  widthPt: number;
  heightPt: number;
}

/** sldSz (EMU → pt) + the slide r:id order from sldIdLst. */
export function parsePresentationXml(xml: string): ParsedPresentation {
  let widthPt = DEFAULT_SLIDE_SIZE_PT.width;
  let heightPt = DEFAULT_SLIDE_SIZE_PT.height;
  const slideRids: string[] = [];
  let inSldIdLst = false;
  scanXmlTags(
    xml,
    (tag) => {
      if (tag.name === "p:sldSz") {
        if (tag.closing) return;
        const cx = Number(tag.attrs["cx"]);
        const cy = Number(tag.attrs["cy"]);
        if (Number.isFinite(cx) && cx > 0 && Number.isFinite(cy) && cy > 0) {
          widthPt = emuToPt(cx);
          heightPt = emuToPt(cy);
        }
      } else if (tag.name === "p:sldIdLst") {
        inSldIdLst = !tag.closing;
      } else if (tag.name === "p:sldId" && inSldIdLst && !tag.closing) {
        const rid = tag.attrs["r:id"];
        if (typeof rid === "string" && rid.length > 0) slideRids.push(rid);
      }
    },
    () => {
      /* presentation.xml text content is irrelevant */
    }
  );
  return { slideRids, widthPt, heightPt };
}

/* ------------------------------------------------------------------ */
/* ppt/slides/slideN.xml → shapes                                      */
/* ------------------------------------------------------------------ */

/** algn attribute → the three alignments v1 renders (justify → left). */
const ALGN_MAP: Record<string, SlideAlign> = {
  l: "left",
  ctr: "center",
  r: "right",
  just: "left",
  justLow: "left",
  dist: "left",
  thaiDist: "left",
};

function algnToAlign(value: string | undefined): SlideAlign {
  if (typeof value !== "string") return "left";
  return ALGN_MAP[value] ?? "left";
}

interface MutableShapeBase {
  off: { x: number; y: number } | null;
  ext: { cx: number; cy: number } | null;
}

interface MutableTextShape extends MutableShapeBase {
  kind: "text";
  paragraphs: PptxParagraph[];
}

interface MutablePicShape extends MutableShapeBase {
  kind: "pic";
  relId: string | null;
}

interface MutableParagraph {
  runs: PptxTextRun[];
  align: SlideAlign;
  /** <a:pPr><a:defRPr sz b/> — run defaults for this paragraph. */
  defSizePt: number | null;
  defBold: boolean;
}

/** Fallback box for text shapes without their own <a:xfrm> (placeholders
 *  inherit position from layouts v1 does not parse): 5%-inset slide area. */
export function fallbackTextBox(
  slideW: number,
  slideH: number
): { x: number; y: number; width: number; height: number } {
  return {
    x: slideW * 0.05,
    y: slideH * 0.05,
    width: slideW * 0.9,
    height: slideH * 0.9,
  };
}

/**
 * Walks one slide part and collects its text shapes + pictures in
 * document order. `mediaByRid` maps r:embed ids to resolved media part
 * paths (null = dangling/external). Tolerant of malformed XML: unclosed
 * shapes, paragraphs and runs flush when the slide ends.
 */
export function parseSlideXml(
  xml: string,
  mediaByRid: Record<string, string | null>,
  slideW: number,
  slideH: number
): ParsedSlide {
  const shapes: PptxShape[] = [];

  let openText: MutableTextShape | null = null;
  let openPic: MutablePicShape | null = null;
  let para: MutableParagraph | null = null;
  let run: PptxTextRun | null = null;
  let tDepth = 0; // open <a:t> elements
  let textParts: string[] = []; // character data of the current run (entities already decoded)
  let pendingBreaks = 0; // <a:br/> count waiting for the next run (or the paragraph end)

  /**
   * Materializes the current run into the paragraph. textParts is the
   * ONLY text channel: <a:t> character data accumulates there (entities
   * decoded per event) and lands here — an implicit run is created for
   * <a:fld> text that never sat inside an <a:r>.
   */
  const flushRun = (): void => {
    let text = "";
    if (tDepth === 0) {
      text = textParts.join("");
      textParts = [];
    }
    if (run === null && para !== null && text.length > 0) {
      run = { text: "", sizePt: null, bold: false, breaksBefore: pendingBreaks };
      pendingBreaks = 0;
    }
    if (run !== null && para !== null) {
      const sizePt = run.sizePt !== null ? run.sizePt : para.defSizePt;
      const bold = run.bold || para.defBold;
      const joined = run.text + text;
      if (joined.length > 0) {
        para.runs.push({
          text: joined,
          sizePt,
          bold,
          ...(run.breaksBefore ? { breaksBefore: run.breaksBefore } : {}),
        });
      }
    } else {
      // No paragraph open (e.g. table/graphicFrame text): drop honestly.
      if (tDepth === 0) textParts = [];
    }
    run = null;
  };

  const flushParagraph = (): void => {
    flushRun();
    if (para === null || openText === null) {
      para = null;
      pendingBreaks = 0;
      return;
    }
    openText.paragraphs.push({
      runs: para.runs,
      align: para.align,
      ...(pendingBreaks ? { trailingBreaks: pendingBreaks } : {}),
    });
    para = null;
    pendingBreaks = 0;
  };

  const shapeRect = (
    shape: MutableShapeBase,
    pic: boolean
  ): { x: number; y: number; width: number; height: number } => {
    const hasRect =
      shape.off !== null &&
      shape.ext !== null &&
      shape.ext.cx > 0 &&
      shape.ext.cy > 0;
    if (hasRect && shape.off !== null && shape.ext !== null) {
      return {
        x: emuToPt(shape.off.x),
        y: emuToPt(shape.off.y),
        width: emuToPt(shape.ext.cx),
        height: emuToPt(shape.ext.cy),
      };
    }
    // No (or degenerate) xfrm: pictures go full-bleed (background-style
    // images), text gets the 5%-inset fallback box.
    return pic
      ? { x: 0, y: 0, width: slideW, height: slideH }
      : fallbackTextBox(slideW, slideH);
  };

  const flushTextShape = (): void => {
    flushParagraph();
    if (openText === null) return;
    const rect = shapeRect(openText, false);
    const hasText = openText.paragraphs.some((p) =>
      p.runs.some((r) => r.text.trim().length > 0)
    );
    if (hasText) {
      shapes.push({ kind: "text", ...rect, paragraphs: openText.paragraphs });
    }
    openText = null;
  };

  const flushPic = (): void => {
    if (openPic === null) return;
    const rect = shapeRect(openPic, true);
    const mediaPath =
      openPic.relId !== null ? (mediaByRid[openPic.relId] ?? null) : null;
    shapes.push({ kind: "pic", ...rect, mediaPath, mediaKind: null });
    openPic = null;
  };

  const captureRect = (
    shape: MutableShapeBase,
    tag: { name: string; attrs: Record<string, string> }
  ): void => {
    if (tag.name === "a:off" && shape.off === null) {
      const x = Number(tag.attrs["x"]);
      const y = Number(tag.attrs["y"]);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        shape.off = { x, y };
      }
    } else if (tag.name === "a:ext" && shape.ext === null) {
      const cx = Number(tag.attrs["cx"]);
      const cy = Number(tag.attrs["cy"]);
      if (Number.isFinite(cx) && Number.isFinite(cy)) {
        shape.ext = { cx, cy };
      }
    }
  };

  scanXmlTags(
    xml,
    (tag) => {
      if (tag.closing) {
        if (tag.name === "a:t") {
          // The character data stays in textParts until the run flushes
          // (an <a:r> may legally hold exactly one <a:t>; tolerating more).
          if (tDepth > 0) tDepth -= 1;
        } else if (tag.name === "a:r") {
          flushRun();
        } else if (tag.name === "a:p") {
          flushParagraph();
        } else if (tag.name === "p:sp") {
          flushTextShape();
        } else if (tag.name === "p:pic") {
          flushPic();
        }
        return;
      }

      if (tag.name === "p:sp") {
        flushTextShape(); // stray re-open safety
        openText = { kind: "text", off: null, ext: null, paragraphs: [] };
        return;
      }
      if (tag.name === "p:pic") {
        flushPic(); // stray re-open safety
        openPic = { kind: "pic", off: null, ext: null, relId: null };
        return;
      }

      if (openPic !== null) {
        // Inside a picture: only the rect + the blip relationship matter.
        captureRect(openPic, tag);
        if (tag.name === "a:blip") {
          const embed = tag.attrs["r:embed"];
          if (typeof embed === "string" && embed.length > 0) {
            openPic.relId = embed;
          }
        }
        return;
      }

      if (openText !== null) {
        captureRect(openText, tag);
        if (tag.name === "a:p") {
          flushParagraph(); // stray re-open safety
          para = { runs: [], align: "left", defSizePt: null, defBold: false };
        } else if (para !== null) {
          if (tag.name === "a:pPr") {
            para.align = algnToAlign(tag.attrs["algn"]);
          } else if (tag.name === "a:defRPr") {
            const sz = Number(tag.attrs["sz"]);
            if (para.defSizePt === null && Number.isFinite(sz) && sz > 0) {
              para.defSizePt = sz / 100;
            }
            if (tag.attrs["b"] === "1") para.defBold = true;
          } else if (tag.name === "a:r") {
            flushRun(); // stray re-open safety
            run = {
              text: "",
              sizePt: null,
              bold: false,
              breaksBefore: pendingBreaks,
            };
            pendingBreaks = 0;
          } else if (tag.name === "a:rPr" && run !== null) {
            const sz = Number(tag.attrs["sz"]);
            if (run.sizePt === null && Number.isFinite(sz) && sz > 0) {
              run.sizePt = sz / 100;
            }
            if (tag.attrs["b"] === "1") run.bold = true;
          } else if (tag.name === "a:br") {
            // Hard line break: it ENDS the current run — the break count
            // lands on the run that follows (or the paragraph's tail).
            flushRun();
            pendingBreaks += 1;
          } else if (tag.name === "a:t") {
            tDepth += 1;
          }
        }
      }
    },
    (text, raw) => {
      if (tDepth > 0) {
        // Entities decode per event — an entity never spans a text gap.
        textParts.push(raw ? text : unescapeXml(text));
      }
    }
  );

  // Tolerant EOF: flush whatever is still open.
  flushTextShape();
  flushPic();
  return { shapes };
}

/* ------------------------------------------------------------------ */
/* The package reader                                                   */
/* ------------------------------------------------------------------ */

function decodeStrictUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * bytes → slides + slide size + media. Throws PptxParseError("not-zip")
 * for a non-zip and PptxParseError("not-pptx") for a zip without the
 * PresentationML skeleton (ppt/presentation.xml) or with non-UTF-8 XML
 * parts. Unreadable single slides degrade to skipped slides; a deck
 * where NOTHING resolves is the worker's honest "no slides" error.
 */
export function parsePptxBytes(bytes: Uint8Array): ParsedPptx {
  let parts: Record<string, Uint8Array>;
  try {
    parts = unzipSync(bytes);
  } catch {
    throw new PptxParseError("not-zip");
  }
  const presentationBytes = parts["ppt/presentation.xml"];
  if (presentationBytes === undefined) {
    throw new PptxParseError("not-pptx");
  }
  const presentationXml = decodeStrictUtf8(presentationBytes);
  if (presentationXml === null) {
    throw new PptxParseError("not-pptx");
  }
  const presentation = parsePresentationXml(presentationXml);

  const presRelsBytes = parts["ppt/_rels/presentation.xml.rels"];
  const presRels =
    presRelsBytes === undefined
      ? {}
      : parseRelsXml(decodeStrictUtf8(presRelsBytes) ?? "");

  // Every media part, keyed by its package path.
  const media: Record<string, Uint8Array> = {};
  for (const name of Object.keys(parts)) {
    if (name.indexOf("ppt/media/") === 0) media[name] = parts[name];
  }

  const slides: ParsedSlide[] = [];
  let charCount = 0;
  let skippedMedia = 0;
  for (const rid of presentation.slideRids) {
    const rel = presRels[rid];
    if (rel === undefined || rel.external) continue;
    const slidePath = resolvePartPath("ppt", rel.target);
    const slideBytes = parts[slidePath];
    if (slideBytes === undefined) continue;
    const slideXml = decodeStrictUtf8(slideBytes);
    if (slideXml === null) continue;

    const slash = slidePath.lastIndexOf("/");
    const slideDir = slash === -1 ? "" : slidePath.slice(0, slash);
    const slideRelsBytes = parts[relsPartPath(slidePath)];
    const slideRels =
      slideRelsBytes === undefined
        ? {}
        : parseRelsXml(decodeStrictUtf8(slideRelsBytes) ?? "");
    const mediaByRid: Record<string, string | null> = {};
    for (const id of Object.keys(slideRels)) {
      const r = slideRels[id];
      mediaByRid[id] = r.external
        ? null
        : resolvePartPath(slideDir, r.target);
    }

    const slide = parseSlideXml(
      slideXml,
      mediaByRid,
      presentation.widthPt,
      presentation.heightPt
    );
    for (const shape of slide.shapes) {
      if (shape.kind === "pic") {
        const imageBytes =
          shape.mediaPath === null ? undefined : media[shape.mediaPath];
        const kind = detectImageKind(imageBytes);
        shape.mediaKind = kind;
        if (kind === null) skippedMedia += 1;
      } else {
        for (const p of shape.paragraphs) {
          for (const r of p.runs) {
            charCount += r.text.replace(/\s/g, "").length;
          }
        }
      }
    }
    slides.push(slide);
  }

  return {
    slides,
    widthPt: presentation.widthPt,
    heightPt: presentation.heightPt,
    media,
    charCount,
    skippedMedia,
  };
}
