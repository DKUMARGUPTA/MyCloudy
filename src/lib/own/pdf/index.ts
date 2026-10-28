/**
 * DocoPDF own PDF micro-engine — public surface (P6-a).
 *
 * Page-surgery PDF engine: parse (classic + stream xref, ObjStm, predictors,
 * encryption refusal, brute recovery) → plan (select/reorder/rotate/blank) →
 * write (reachable-graph renumber, byte-exact stream passthrough).
 * Zero external dependencies — our own lexer/parser/writer/zip.
 */

export { PdfError, parsePdf, resolve, pngUnfilter, decodeForParser } from "./parser";
export type { ParsedPdf, XrefEntry } from "./parser";
export {
  Lexer,
  PdfSyntaxError,
  scanObjectHeaders,
  latin1,
} from "./lexer";
export type { Token } from "./lexer";
export {
  listPages,
  materializeInheritable,
  normalizeRotation,
  type PdfPageInfo,
} from "./document";
export {
  organizeMerge,
  organizePdf,
  organizePages,
  parseForOrganize,
  type MergePlanEntry,
  type OrganizeResult,
  type OrganizeSource,
  type OrganizeProgress,
  type PlanEntry,
} from "./ops";
export { writeDocument, type WritePage, type WriteProgress, type WriteSynthetic } from "./writer";
export { CreateContext, type CreateImage, type CreateImageOptions, type CreateLineOptions, type CreatePage, type CreateRectOptions, type CreateTextOptions, type CreateEllipseOptions, type CreateRoundedRectOptions } from "./create";
export { ComposeContext, type ComposedForm, type PageFormEmbed, pageFormEmbed } from "./compose";
export {
  StampContext,
  type StampForm,
  type StampFormOptions,
  type StampImage,
  type StampImageOptions,
  type StampTextOptions,
  type StampTtfFont,
} from "./stamp";
export {
  encodeWinAnsiBytes,
  encodeWinAnsiHex,
  measureStdText,
  winAnsiEncodable,
  type StampFontKey,
} from "./stamp-fonts";
export { decodePng, parseJpeg, flateImageBytes, type JpegInfo, type PngImage } from "./images";
export { ParsedTtfFont, TtfSubsetter } from "./font-ttf";
export { shapeText, type ShapedGlyph } from "./shape-deva";
export {
  type PdfObj,
  type PdfNewRef,
  type PdfRef,
  asArr,
  asBox,
  asDict,
  asName,
  asNum,
  cloneDict,
  collectRefs,
  dget,
  dict,
  arr,
  hstr,
  lstr,
  name,
  newDict,
  newref,
  num,
  pdfNameToString,
  pdfNumToString,
  pdfStringToHex,
  ref,
} from "./objects";
