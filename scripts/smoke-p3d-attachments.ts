/**
 * Smoke: P3-d attachments cluster (add/extract/remove-attachments).
 *
 *   0. Wiring: registry counts 137 total / 136 live / 1 deferred AI
 *      (translate only); the three new defs are enabled with the
 *      right accepts; configs + seo entries present; the NEW i18n
 *      error key exists in BOTH catalogs.
 *   1. MIME sniffer (PURE, tools/attachments-common/mime): magic
 *      bytes for PNG/JPEG/GIF/WEBP/BMP/PDF/gzip, ZIP-container
 *      discrimination (docx/xlsx/epub/plain), XML root (SVG vs
 *      generic), JSON, HTML, plain text, extension fallback,
 *      octet-stream default.
 *   2. Name helpers (PURE): uniqueAttachmentName counters,
 *      sanitizeAttachmentName + uniqueOutputName for extraction.
 *   3. Add roundtrip (own engine): base PDF → attachFile ×3 (one
 *      uncompressed, two Flate-packed) → rewrite → re-parse →
 *      inventory (sorted keys, names, mimes, sizes, tree+/AF dedupe)
 *      → decodeStreamBytes byte-exact → pdf-lib oracle (pages
 *      unchanged, structure loads).
 *   4. Sorted tree: flat /Names keys come out in code-unit order —
 *      the spec's binary-search requirement.
 *   5. Remove roundtrip: the with-attachments output → PURE
 *      removeAttachmentsFromDoc → re-parse → inventory 0, catalog
 *      clean (/AF gone, /Names gone), pdf-lib loads, output
 *      genuinely smaller (objects really deleted).
 *   6. Annotation protection: a file-attachment ANNOTATION /FS pin
 *      keeps its filespec object alive while the document-level
 *      references still go (keptAnnotated === 1, inventory 0 after).
 *
 * Run: bun scripts/smoke-p3d-attachments.ts
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PDFDocument } from "pdf-lib";
import { ALL_TOOLS, liveToolCount } from "../src/lib/tools/registry";
import { TOOL_CONFIGS } from "../src/lib/tools/configs";
import { getToolSeo } from "../src/lib/seo/tool-seo";
import {
  CreateContext,
  catalogDict,
  decodeStreamBytes,
  parsePdf,
  resolveTrailerRef,
  rewriteDocument,
  asArr,
  asDict,
  arrItems,
  name,
  arr,
  ref,
  type PdfObj,
} from "../src/lib/own/pdf";
import { attachFile, uniqueAttachmentName } from "../tools/attachments-common/write";
import {
  collectAttachments,
  decodePdfText,
} from "../tools/attachments-common/nametree";
import { sniffAttachmentMime } from "../tools/attachments-common/mime";
import {
  sanitizeAttachmentName,
  uniqueOutputName,
} from "../tools/extract-attachments/worker-lib";
import {
  protectedFilespecNums,
  removeAttachmentsFromDoc,
} from "../tools/remove-attachments/worker-lib";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, extra = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ""}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  ✗ FAIL: ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/* ------------------------------------------------------------------ */
/* 0. Wiring                                                           */
/* ------------------------------------------------------------------ */
section("0 · wiring");
{
  const deferred = ALL_TOOLS.filter((t) => !t.enabled).map((t) => t.id);
  check(
    "tool counts: 147 total / 144 live / 3 deferred (chat, summarize, translate)",
    ALL_TOOLS.length === 147 && liveToolCount === 144 &&
      deferred.join(",") === "chat-with-pdf,summarize-pdf,translate-pdf",
    `${ALL_TOOLS.length}/${liveToolCount}/${deferred.length}`,
  );

  const byId = new Map(ALL_TOOLS.map((t) => [t.id, t]));
  const add = byId.get("add-attachments");
  check(
    "add-attachments def: organize/D/any/enabled",
    add !== undefined && add.category === "organize" && add.mode === "D" &&
      add.accepts === "any" && add.enabled === true,
  );
  const extract = byId.get("extract-attachments");
  check(
    "extract-attachments def: convert-from/D/pdf/enabled (moved from organize in the R58-era registry reshuffle)",
    extract !== undefined && extract.category === "convert-from" && extract.mode === "D" &&
      extract.accepts === "pdf" && extract.enabled === true,
  );
  const editAt = byId.get("edit-attachments");
  check(
    "edit-attachments def: organize/D/pdf/enabled (absorbed remove-attachments)",
    editAt !== undefined && editAt.category === "organize" && editAt.mode === "D" &&
      editAt.accepts === "pdf" && editAt.enabled === true,
  );

  const addCfg = TOOL_CONFIGS["add-attachments"];
  const extractCfg = TOOL_CONFIGS["extract-attachments"];
  const editAtCfg = TOOL_CONFIGS["edit-attachments"];
  check(
    "configs: add 1..1 + 1 option (the wizard surface owns the rest); extract 1..5; edit-attachments 1..1",
    addCfg !== undefined && addCfg.minFiles === 1 && addCfg.maxFiles === 1 &&
      addCfg.options.length === 1 && addCfg.outputKind === "pdf" &&
      extractCfg !== undefined && extractCfg.minFiles === 1 && extractCfg.maxFiles === 5 &&
      extractCfg.outputKind === "pdf" &&
      editAtCfg !== undefined && editAtCfg.minFiles === 1 && editAtCfg.maxFiles === 1 &&
      editAtCfg.outputKind === "pdf",
  );
  check(
    "chains: edit-attachments→extract/add (the remove-attachments tool was consolidated into it)",
    editAtCfg.chainToolIds?.includes("extract-attachments") === true &&
      editAtCfg.chainToolIds?.includes("add-attachments") === true,
  );

  check(
    "seo: 3 honest entries",
    getToolSeo("add-attachments") !== null &&
      getToolSeo("extract-attachments") !== null &&
      getToolSeo("edit-attachments") !== null,
  );

  const root = join(import.meta.dir, "..");
  const en = JSON.parse(readFileSync(join(root, "src/i18n/en.json"), "utf8"));
  const hi = JSON.parse(readFileSync(join(root, "src/i18n/hi.json"), "utf8"));
  check(
    "i18n: et.errorNoAttachments en+hi (errorBasePdfFirst was retired with the old add-attachments error flow)",
    typeof en.et?.errorNoAttachments === "string" &&
      typeof hi.et?.errorNoAttachments === "string" &&
      en.et.errorNoAttachments.length > 10 &&
      hi.et.errorNoAttachments.length > 10,
  );
}

/* ------------------------------------------------------------------ */
/* 1. MIME sniffer                                                     */
/* ------------------------------------------------------------------ */
section("1 · mime sniffer (PURE)");
{
  check("PNG magic", sniffAttachmentMime("x.png", enc("\x89PNG\r\n\x1a\n" + "rest")) === "image/png");
  check("JPEG magic", sniffAttachmentMime("x.jpg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])) === "image/jpeg");
  check("GIF89a magic", sniffAttachmentMime("x.gif", enc("GIF89a....")) === "image/gif");
  check("WEBP magic", sniffAttachmentMime("x.webp", enc("RIFF\x00\x00\x00\x00WEBPVP8 ")) === "image/webp");
  check("BMP magic", sniffAttachmentMime("x.bmp", enc("BM\x36\x00")) === "image/bmp");
  check("PDF magic", sniffAttachmentMime("x.bin", enc("%PDF-1.7\n")) === "application/pdf");
  check("gzip magic", sniffAttachmentMime("x.gz", new Uint8Array([0x1f, 0x8b, 0x08, 0x00])) === "application/gzip");
  check(
    "zip → docx (word/ part)",
    sniffAttachmentMime("x.zip", enc("PK\x03\x04" + "\x00\x00\x00word/document.xml")) ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  check(
    "zip → xlsx (xl/ part)",
    sniffAttachmentMime("x.zip", enc("PK\x03\x04" + "\x00\x00\x00xl/workbook.xml")) ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  check(
    "zip → epub (mimetype entry)",
    sniffAttachmentMime("x.zip", enc("PK\x03\x04" + "mimetypeapplication/epub+zip")) === "application/epub+zip",
  );
  check("zip → plain zip", sniffAttachmentMime("x.zip", enc("PK\x03\x04" + "\x00\x00random")) === "application/zip");
  check(
    "xml root svg",
    sniffAttachmentMime("x.svg", enc("<?xml version=\"1.0\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>")) === "image/svg+xml",
  );
  check("xml generic", sniffAttachmentMime("x.xml", enc("<?xml version=\"1.0\"?><catalog/>")) === "application/xml");
  check("json", sniffAttachmentMime("x", enc("{\"a\": 1}")) === "application/json");
  check("json array", sniffAttachmentMime("x", enc("[1, 2, 3]")) === "application/json");
  check("html", sniffAttachmentMime("x", enc("<!DOCTYPE html><html><body>hi</body>")) === "text/html");
  check("plain text", sniffAttachmentMime("x", enc("just some words\r\nline two")) === "text/plain");
  check(
    "extension fallback (empty file + .docx)",
    sniffAttachmentMime("invoice.docx", new Uint8Array(0)) ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  check("octet default", sniffAttachmentMime("weird.dat", new Uint8Array([0x00, 0x01, 0x02])) === "application/octet-stream");
  check(
    "binary beats extension (jpg named .png)",
    sniffAttachmentMime("photo.png", new Uint8Array([0xff, 0xd8, 0xff, 0xe1])) === "image/jpeg",
  );
}

/* ------------------------------------------------------------------ */
/* 2. Name helpers                                                     */
/* ------------------------------------------------------------------ */
section("2 · name helpers (PURE)");
{
  const taken = new Set<string>(["a.pdf"]);
  check("unique: first untouched", uniqueAttachmentName("a.pdf", new Set()) === "a.pdf");
  check("unique: (2) counter", uniqueAttachmentName("a.pdf", taken) === "a (2).pdf");
  check("unique: (3) next", uniqueAttachmentName("a.pdf", taken) === "a (3).pdf");
  const taken2 = new Set<string>(["a.pdf", "a (2).pdf"]);
  check("unique: skips to (3)", uniqueAttachmentName("a.pdf", taken2) === "a (3).pdf");
  check("unique: empty → file", uniqueAttachmentName("", new Set()) === "file");

  check("sanitize: path stripped", sanitizeAttachmentName("dir/sub/file.txt", 0) === "dir_sub_file.txt");
  check("sanitize: empty → attachment-N", sanitizeAttachmentName("???", 4) === "attachment-5.bin");
  check("sanitize: leading dots stripped", sanitizeAttachmentName(".hidden", 0) === "hidden");
  const out = new Set<string>(["r.pdf"]);
  check("output unique: (2)", uniqueOutputName("r.pdf", out) === "r (2).pdf");
  check("output unique: untouched", uniqueOutputName("q.pdf", out) === "q.pdf");
}

/* ------------------------------------------------------------------ */
/* 3. Add roundtrip (own engine)                                       */
/* ------------------------------------------------------------------ */
section("3 · add roundtrip (own engine)");
let withAttachments: Uint8Array;
let specNums: number[] = [];
{
  const doc = CreateContext.create();
  const page = doc.addPage(300, 200);
  page.drawText({ x: 20, y: 100, text: "Attachment host", size: 12 });
  doc.addPage(300, 200);
  doc.setProducer("DocoPDF");
  const baseBytes = doc.write();

  const parsed = parsePdf(baseBytes);
  const catalog = catalogDict(parsed);
  check("base parse: catalog present", catalog !== null);
  if (catalog === null) throw new Error("no catalog");

  let nextNum = 1;
  for (const n of parsed.entries.keys()) nextNum = Math.max(nextNum, n + 1);

  const files: { name: string; bytes: Uint8Array; compress: boolean }[] = [
    { name: "notes.txt", bytes: enc("Meeting notes — first quarter review.\nAction items: 3"), compress: false },
    {
      name: "photo.bin",
      bytes: (() => {
        const b = new Uint8Array(1024);
        for (let i = 0; i < b.length; i += 1) b[i] = (i * 7 + 13) & 0xff;
        return b;
      })(),
      compress: true,
    },
    { name: "data.json", bytes: enc('{"tool":"docopdf","round":"p3d","attachments":3}'), compress: true },
  ];

  const extras: Array<{ num: number; obj: PdfObj }> = [];
  for (const f of files) {
    const r = attachFile(
      parsed,
      catalog,
      { name: f.name, mime: sniffAttachmentMime(f.name, f.bytes), bytes: f.bytes },
      nextNum,
      { compress: f.compress, modDate: "D:20261101000000Z" },
    );
    nextNum = r.nextNum;
    extras.push(...r.extras);
  }
  specNums = extras
    .filter((e) => e.obj.k === "dict" && e.obj.m.has("EF"))
    .map((e) => e.num);

  withAttachments = parsePdfOrThrow(
    // classic output via rewriteDocument — import indirectly to keep
    // the import list tidy at the top
    rewriteDoc(parsed, extras),
  );

  /* ---- re-parse + inventory ------------------------------------- */
  const re = parsePdf(withAttachments);
  const inventory = collectAttachments(re);
  check("inventory: 3 attachments", inventory.length === 3, `${inventory.length}`);
  const keys = inventory.map((i) => i.key);
  check(
    "inventory: sorted keys",
    keys.join("|") === "data.json|notes.txt|photo.bin",
    keys.join("|"),
  );
  const notes = inventory.find((i) => i.name === "notes.txt");
  check(
    "notes.txt: text/plain + true size",
    notes !== undefined && notes.mime === "text/plain" && notes.size === files[0]!.bytes.length,
  );
  const photo = inventory.find((i) => i.name === "photo.bin");
  check(
    "photo.bin: octet-stream + true size (not the packed length)",
    photo !== undefined && photo.mime === "application/octet-stream" &&
      photo.size === files[1]!.bytes.length,
  );
  const json = inventory.find((i) => i.name === "data.json");
  check("data.json: application/json", json !== undefined && json.mime === "application/json");
  check(
    "modDate roundtrip",
    notes?.modDate === "D:20261101000000Z",
  );

  /* ---- tree + /AF dedupe ------------------------------------------ */
  const reCatalog = catalogDict(re);
  const af = reCatalog !== null ? asArr(reCatalog.get("AF")) : undefined;
  check("catalog /AF: 3 refs", af !== undefined && af.length === 3);
  check(
    "dedupe: every entry carries BOTH sources",
    inventory.every((i) => i.sources.includes("tree") && i.sources.includes("af")),
  );

  /* ---- byte-exact decode ------------------------------------------ */
  const decodedNotes = decodeAttachment(re, "notes.txt");
  check(
    "decode: notes.txt byte-exact (uncompressed)",
    decodedNotes !== null && bytesEqual(decodedNotes, files[0]!.bytes),
  );
  const decodedPhoto = decodeAttachment(re, "photo.bin");
  check(
    "decode: photo.bin byte-exact (Flate-packed)",
    decodedPhoto !== null && bytesEqual(decodedPhoto, files[1]!.bytes),
  );
  const decodedJson = decodeAttachment(re, "data.json");
  check(
    "decode: data.json byte-exact (Flate-packed)",
    decodedJson !== null && bytesEqual(decodedJson, files[2]!.bytes),
  );

  /* ---- pdf-lib oracle --------------------------------------------- */
  const oracle = await PDFDocument.load(withAttachments, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  check("pdf-lib oracle: loads, 2 pages unchanged", oracle.getPageCount() === 2);
}

/* ------------------------------------------------------------------ */
/* 4. Sorted tree structure                                            */
/* ------------------------------------------------------------------ */
section("4 · sorted tree");
{
  const re = parsePdf(withAttachments);
  const catalog = catalogDict(re);
  const namesDict = catalog !== null ? asDict(resolveTrailerRef(re, catalog.get("Names"))) : undefined;
  const root = namesDict !== undefined ? asDict(resolveTrailerRef(re, namesDict.get("EmbeddedFiles"))) : undefined;
  const flat = root !== undefined ? arrItems(root.get("Names")) : null;
  check("tree: flat /Names present", flat !== null && flat.length === 6);
  if (flat !== null) {
    const keys: string[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const k = decodePdfText(flat[i]);
      if (k !== undefined) keys.push(k);
    }
    const sorted = [...keys].sort(cmp);
    check("tree: keys in code-unit order", keys.join("|") === sorted.join("|"), keys.join("|"));
  }
}

/* ------------------------------------------------------------------ */
/* 5. Remove roundtrip                                                 */
/* ------------------------------------------------------------------ */
section("5 · remove roundtrip");
{
  const re = parsePdf(withAttachments);
  const outcome = removeAttachmentsFromDoc(re);
  check("remove: outcome present", outcome !== null);
  if (outcome !== null) {
    check("remove: inventoried 3, kept 0 (no annots)", outcome.removed === 3 && outcome.keptAnnotated === 0);

    const after = parsePdf(outcome.bytes);
    const inventory = collectAttachments(after);
    check("after: inventory empty", inventory.length === 0);
    const catalog = catalogDict(after);
    check("after: catalog /AF gone", catalog?.get("AF") === undefined);
    check(
      "after: /Names branch gone (nothing else lived there)",
      asDict(resolveTrailerRef(after, catalog?.get("Names"))) === undefined,
    );
    const oracle = await PDFDocument.load(outcome.bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    check("after: pdf-lib loads, 2 pages", oracle.getPageCount() === 2);
    check(
      "after: genuinely smaller (objects deleted)",
      outcome.bytes.length < withAttachments.length - 800,
      `${withAttachments.length} → ${outcome.bytes.length}`,
    );
    // The filespec object numbers must not exist in the new xref.
    const gone = specNums.every((n) => !after.entries.has(n));
    check("after: filespec object numbers gone from xref", gone);
  }
}

/* ------------------------------------------------------------------ */
/* 6. Annotation protection                                            */
/* ------------------------------------------------------------------ */
section("6 · annotation protection");
{
  // Host PDF + one attachment, then patch page 1 with a file-attachment
  // annotation whose /FS points at the SAME filespec (an inline dict
  // annot — the protection scan resolves refs AND inline dicts).
  const doc = CreateContext.create();
  doc.addPage(300, 200);
  doc.setProducer("DocoPDF");
  const baseBytes = doc.write();
  const parsed = parsePdf(baseBytes);
  const catalog = catalogDict(parsed);
  if (catalog === null) throw new Error("no catalog");
  let nextNum = 1;
  for (const n of parsed.entries.keys()) nextNum = Math.max(nextNum, n + 1);

  const payload = enc("pinned by an annotation");
  const r = attachFile(
    parsed,
    catalog,
    { name: "pinned.txt", mime: "text/plain", bytes: payload },
    nextNum,
    { compress: true },
  );
  const filespecRef = r.extras[1]!.num;

  // Page object: patch its dict with /Annots [ << /Subtype
  // /FileAttachment /FS filespecRef >> ] via replacements.
  const replacements = new Map<number, PdfObj>();
  const pages = [...parsed.entries.keys()];
  // Page objects are among the source numbers; find the dict whose
  // /Type is /Page via a brute scan of small objects.
  let pageNum = -1;
  for (const n of parsed.entries.keys()) {
    const o = parsed.getObject(n);
    if (o === undefined || o.k !== "dict") continue;
    const t = o.m.get("Type");
    if (t !== undefined && t.k === "name" && t.v === "Page") {
      pageNum = n;
      break;
    }
  }
  check("protection setup: found the page object", pageNum > 0, `obj ${pageNum}`);
  const pageObj = parsed.getObject(pageNum);
  if (pageObj !== undefined && pageObj.k === "dict" && pageNum > 0) {
    const patched = new Map<string, PdfObj>(pageObj.m);
    patched.set(
      "Annots",
      arr({
        k: "dict",
        m: new Map<string, PdfObj>([
          ["Subtype", name("FileAttachment")],
          ["FS", ref(filespecRef)],
        ]),
      }),
    );
    replacements.set(pageNum, { k: "dict", m: patched });

    const pinnedBytes = rewriteDoc(parsed, r.extras, replacements);
    const pinned = parsePdf(pinnedBytes);
    const inventory = collectAttachments(pinned);
    check("pinned: 1 attachment inventoried", inventory.length === 1);

    // The protection scan sees the annot /FS.
    const protectedNums = protectedFilespecNums(pinned);
    check("protection scan: annot /FS found", protectedNums.has(filespecRef));

    const outcome = removeAttachmentsFromDoc(pinned);
    check("protection: outcome present", outcome !== null);
    if (outcome !== null) {
      check(
        "protection: removed 1 reference, kept 1 object",
        outcome.removed === 1 && outcome.keptAnnotated === 1,
      );
      const after = parsePdf(outcome.bytes);
      check("protection: inventory empty after", collectAttachments(after).length === 0);
      // The filespec object SURVIVES (annotation still needs it).
      check("protection: filespec object alive", after.entries.has(filespecRef));
      const oracle = await PDFDocument.load(outcome.bytes, {
        ignoreEncryption: true,
        updateMetadata: false,
      });
      check("protection: pdf-lib loads, 1 page", oracle.getPageCount() === 1);
    }
  }
}

/* ------------------------------------------------------------------ */
/* helpers + summary                                                   */
/* ------------------------------------------------------------------ */
function cmp(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function decodeAttachment(doc: ReturnType<typeof parsePdf>, key: string): Uint8Array | null {
  const info = collectAttachments(doc).find((i) => i.key === key || i.name === key);
  if (info === undefined) return null;
  const ef = asDict(info.spec.get("EF"));
  if (ef === undefined) return null;
  for (const k of ["F", "UF"]) {
    const v = ef.get(k);
    const resolved = v !== undefined ? resolveTrailerRef(doc, v) : undefined;
    if (resolved !== undefined && resolved.k === "stream") {
      try {
        return decodeStreamBytes(resolved.raw, resolved.m);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function rewriteDoc(
  parsed: ReturnType<typeof parsePdf>,
  extras: Array<{ num: number; obj: PdfObj }>,
  replacements?: Map<number, PdfObj>,
): Uint8Array {
  return rewriteDocument(parsed, {
    extraObjects: extras,
    replacements,
    minVersion: "1.4",
  });
}

function parsePdfOrThrow(bytes: Uint8Array): Uint8Array {
  parsePdf(bytes); // throws on structural failure
  return bytes;
}

console.log(`\n════════════════════════════════════`);
console.log(`smoke-p3d-attachments: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
