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
  normalizeRotation,
  type PdfPageInfo,
} from "./document";
export {
  organizePdf,
  type OrganizeResult,
  type PlanEntry,
} from "./ops";
export { writeDocument, type WritePage } from "./writer";
export {
  type PdfObj,
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
  name,
  newDict,
  num,
  pdfNameToString,
  pdfNumToString,
  pdfStringToHex,
  ref,
} from "./objects";
