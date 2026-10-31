import type { OptionValues } from "@/lib/tools/config-types";
import {
  listPages,
  parsePdf,
  resolve,
  type ParsedPdf,
  type PdfObj,
} from "@/lib/own/pdf";

/**
 * View PDF metadata — the shared pipeline (worker + smoke import the same
 * function). READ-ONLY: the own engine parses the file and a structured
 * snapshot is rendered as a TXT spec sheet or a JSON object. Encrypted
 * inputs are reported honestly (name/size/encrypted flag) instead of
 * failing — an inspector should say what it sees.
 */

export interface MetaPageRow {
  page: number;
  /** Media box size in PDF points (width × height). */
  widthPt: number;
  heightPt: number;
  /** Millimetres (points × 25.4 / 72), 1-decimal. */
  widthMm: number;
  heightMm: number;
  rotation: number;
}

export interface MetaSnapshot {
  fileName: string;
  fileSizeBytes: number;
  encrypted: boolean;
  pdfVersion: string;
  pageCount: number;
  info: {
    title?: string;
    author?: string;
    subject?: string;
    keywords?: string;
    creator?: string;
    producer?: string;
    creationDate?: string;
    modificationDate?: string;
    /** Non-standard Info entries, display order preserved. */
    custom: { key: string; value: string }[];
  };
  xmp: { present: boolean; bytes: number };
  /** Unique (width × height × rotation) shapes with their page counts. */
  sizeSummary: { widthPt: number; heightPt: number; rotation: number; pages: number }[];
  pages: MetaPageRow[];
}

export interface ViewMetaOptions {
  format: "txt" | "json";
  includePages: boolean;
}

export function resolveViewMetaOptions(options: OptionValues): ViewMetaOptions {
  return {
    format: options.format === "json" ? "json" : "txt",
    includePages: options.includePages !== false,
  };
}

/* ------------------------------------------------------------------ */
/* PDF string / date decoding (read side — pdf-lib writes, we read)    */
/* ------------------------------------------------------------------ */

/** Decode a PDF string: UTF-16BE with BOM, else Latin-1 (PDFDocEncoding-ish). */
function decodePdfText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
    }
    return out;
  }
  let latin = "";
  for (let i = 0; i < bytes.length; i += 1) {
    latin += String.fromCharCode(bytes[i]!);
  }
  return latin;
}

/** `D:YYYYMMDDHHmmSSOHH'mm'` → `YYYY-MM-DD HH:MM` (what is present). */
function formatPdfDate(raw: string): string | undefined {
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(raw);
  if (m === null) return raw.length > 0 ? raw.slice(0, 40) : undefined;
  const [, y, mo, d, h, mi] = m;
  let out = y!;
  if (mo) out += `-${mo}`;
  if (d) out += `-${d}`;
  if (h) out += ` ${h}:${mi ?? "00"}`;
  return out;
}

function stringValue(obj: PdfObj | undefined): string | undefined {
  if (obj === undefined) return undefined;
  if (obj.k === "str" || obj.k === "lstr" || obj.k === "hstr") {
    const text = decodePdfText(obj.b);
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

const MM_PER_PT = 25.4 / 72;
const r1 = (n: number): number => Math.round(n * 10) / 10;

/* ------------------------------------------------------------------ */
/* Snapshot                                                            */
/* ------------------------------------------------------------------ */

const STANDARD_INFO = new Set([
  "Title",
  "Author",
  "Subject",
  "Keywords",
  "Creator",
  "Producer",
  "CreationDate",
  "ModDate",
  "Trapped",
]);

export function buildSnapshot(
  bytes: Uint8Array,
  fileName: string
): MetaSnapshot {
  const base: MetaSnapshot = {
    fileName,
    fileSizeBytes: bytes.length,
    encrypted: false,
    pdfVersion: "",
    pageCount: 0,
    info: { custom: [] },
    xmp: { present: false, bytes: 0 },
    sizeSummary: [],
    pages: [],
  };

  let doc: ParsedPdf;
  try {
    doc = parsePdf(bytes);
  } catch {
    // Encrypted (the parser's only soft refusal) or unparseable — report
    // the honest "what is visible without a password" view.
    return { ...base, encrypted: true };
  }

  const snapshot: MetaSnapshot = { ...base, pdfVersion: doc.version };

  /* Info dict (trailer /Info → six standards + customs + dates). */
  const infoDict = (() => {
    const info = doc.trailer.get("Info");
    if (info === undefined) return undefined;
    const resolved = resolve(doc, info);
    if (resolved === undefined) return undefined;
    if (resolved.k === "dict") return resolved.m;
    if (resolved.k === "stream") return resolved.m;
    return undefined;
  })();

  const info: MetaSnapshot["info"] = { custom: [] };
  if (infoDict !== undefined) {
    info.title = stringValue(infoDict.get("Title"));
    info.author = stringValue(infoDict.get("Author"));
    info.subject = stringValue(infoDict.get("Subject"));
    const kw = infoDict.get("Keywords");
    if (kw?.k === "arr") {
      const parts = kw.items
        .map((item) => stringValue(item))
        .filter((v): v is string => v !== undefined);
      if (parts.length > 0) info.keywords = parts.join(", ");
    } else {
      info.keywords = stringValue(kw);
    }
    info.creator = stringValue(infoDict.get("Creator"));
    info.producer = stringValue(infoDict.get("Producer"));
    const created = stringValue(infoDict.get("CreationDate"));
    info.creationDate = created !== undefined ? formatPdfDate(created) : undefined;
    const modified = stringValue(infoDict.get("ModDate"));
    info.modificationDate =
      modified !== undefined ? formatPdfDate(modified) : undefined;
    for (const [key, value] of infoDict) {
      if (STANDARD_INFO.has(key)) continue;
      const text = stringValue(value);
      if (text !== undefined) {
        info.custom.push({ key, value: text.slice(0, 200) });
      }
    }
  }
  snapshot.info = info;

  /* Pages (count, per-page rows, unique-shape summary). */
  const pages = listPages(doc);
  snapshot.pageCount = pages.length;
  const rows: MetaPageRow[] = pages.map((page, i) => {
    const [x0, y0, x1, y1] = page.cropBox;
    return {
      page: i + 1,
      widthPt: r1(x1 - x0),
      heightPt: r1(y1 - y0),
      widthMm: r1((x1 - x0) * MM_PER_PT),
      heightMm: r1((y1 - y0) * MM_PER_PT),
      rotation: page.rotate,
    };
  });
  snapshot.pages = rows;

  const shapeKey = (row: MetaPageRow): string =>
    `${row.widthPt}×${row.heightPt}@${row.rotation}`;
  const counts = new Map<string, { row: MetaPageRow; pages: number }>();
  for (const row of rows) {
    const key = shapeKey(row);
    const hit = counts.get(key);
    if (hit === undefined) {
      counts.set(key, { row, pages: 1 });
    } else {
      hit.pages += 1;
    }
  }
  snapshot.sizeSummary = [...counts.values()].map(({ row, pages }) => ({
    widthPt: row.widthPt,
    heightPt: row.heightPt,
    rotation: row.rotation,
    pages,
  }));

  /* XMP: the catalog's /Metadata stream. */
  const catalog = (() => {
    const root = doc.trailer.get("Root");
    if (root === undefined) return undefined;
    const resolved = resolve(doc, root);
    return resolved?.k === "dict" ? resolved.m : undefined;
  })();
  const metadata = catalog?.get("Metadata");
  if (metadata !== undefined) {
    const resolved = resolve(doc, metadata);
    if (resolved?.k === "stream") {
      snapshot.xmp = { present: true, bytes: resolved.raw.length };
    }
  }

  return snapshot;
}

/* ------------------------------------------------------------------ */
/* Report rendering                                                    */
/* ------------------------------------------------------------------ */

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function line(label: string, value: string | undefined): string {
  return `${label.padEnd(22)}${value !== undefined && value.length > 0 ? value : "—"}`;
}

export function renderTxtReport(snap: MetaSnapshot, includePages: boolean): string {
  const out: string[] = [];
  out.push("PDF METADATA REPORT");
  out.push("===================");
  out.push("");
  out.push("FILE");
  out.push(line("  File name", snap.fileName));
  out.push(line("  File size", `${snap.fileSizeBytes} bytes (${humanBytes(snap.fileSizeBytes)})`));
  out.push(line("  PDF version", snap.pdfVersion.length > 0 ? snap.pdfVersion : undefined));
  out.push(line("  Encrypted", snap.encrypted ? "Yes — password-protected (unlock for full details)" : "No"));
  out.push("");

  out.push("DOCUMENT");
  out.push(line("  Pages", snap.pageCount > 0 ? String(snap.pageCount) : undefined));
  if (snap.encrypted) {
    out.push("  (Info fields are not readable without the password)");
  } else {
    out.push(line("  Title", snap.info.title));
    out.push(line("  Author", snap.info.author));
    out.push(line("  Subject", snap.info.subject));
    out.push(line("  Keywords", snap.info.keywords));
    out.push(line("  Creator", snap.info.creator));
    out.push(line("  Producer", snap.info.producer));
    out.push(line("  Created", snap.info.creationDate));
    out.push(line("  Modified", snap.info.modificationDate));
    if (snap.info.custom.length > 0) {
      out.push("  Custom entries:");
      for (const { key, value } of snap.info.custom) {
        out.push(`    ${key}: ${value}`);
      }
    }
    out.push(line("  XMP packet", snap.xmp.present ? `Present (${snap.xmp.bytes} bytes)` : "None"));
  }
  out.push("");

  out.push("PAGE SIZES (crop box)");
  if (snap.sizeSummary.length === 0) {
    out.push("  —");
  } else {
    for (const shape of snap.sizeSummary) {
      out.push(
        `  ${shape.widthPt} × ${shape.heightPt} pt  (${r1(shape.widthPt * MM_PER_PT)} × ${r1(shape.heightPt * MM_PER_PT)} mm)  rotation ${shape.rotation}°  — ${shape.pages} page${shape.pages > 1 ? "s" : ""}`
      );
    }
  }
  out.push("");

  if (includePages && snap.pages.length > 0 && !snap.encrypted) {
    out.push("EVERY PAGE");
    for (const row of snap.pages) {
      out.push(
        `  Page ${String(row.page).padStart(String(snap.pages.length).length)}: ${row.widthPt} × ${row.heightPt} pt (${row.widthMm} × ${row.heightMm} mm), rotation ${row.rotation}°`
      );
    }
    out.push("");
  }

  out.push("Generated on-device by DocoPDF — the PDF was not modified or uploaded.");
  return out.join("\n");
}

export function renderJsonReport(snap: MetaSnapshot, includePages: boolean): string {
  const payload = {
    fileName: snap.fileName,
    fileSizeBytes: snap.fileSizeBytes,
    pdfVersion: snap.pdfVersion.length > 0 ? snap.pdfVersion : undefined,
    encrypted: snap.encrypted,
    pageCount: snap.pageCount,
    documentInfo: snap.encrypted
      ? { note: "not readable without the password" }
      : {
          title: snap.info.title,
          author: snap.info.author,
          subject: snap.info.subject,
          keywords: snap.info.keywords,
          creator: snap.info.creator,
          producer: snap.info.producer,
          creationDate: snap.info.creationDate,
          modificationDate: snap.info.modificationDate,
          custom: snap.info.custom.length > 0 ? snap.info.custom : undefined,
        },
    xmp: snap.encrypted ? undefined : snap.xmp,
    pageSizes: snap.sizeSummary,
    pages: includePages && !snap.encrypted ? snap.pages : undefined,
  };
  return JSON.stringify(payload, null, 2);
}

/* ------------------------------------------------------------------ */
/* The whole run (worker + smoke call this)                            */
/* ------------------------------------------------------------------ */

export interface ViewMetaResult {
  report: string;
  pageCount: number;
  encrypted: boolean;
}

export function runViewMetadata(
  bytes: Uint8Array,
  fileName: string,
  options: OptionValues
): ViewMetaResult {
  const opts = resolveViewMetaOptions(options);
  const snap = buildSnapshot(bytes, fileName);
  const report =
    opts.format === "json"
      ? renderJsonReport(snap, opts.includePages)
      : renderTxtReport(snap, opts.includePages);
  return { report, pageCount: snap.pageCount, encrypted: snap.encrypted };
}
