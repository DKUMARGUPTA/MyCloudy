/**
 * Smoke: magic bytes (P7-b) — the input-gate regression lock.
 *
 * DOM TRUTH (verified 2025-10-30, agent-browser, merge-pdf + pdfa + image
 * surfaces): the DropZone sniffs CONTENT, not extensions —
 *   - a GIF named .pdf → rejected with the honest toast "That's not a PDF —
 *     We checked the file's content — it isn't a valid PDF." (shadcn toast,
 *     li[data-state], immediate-poll — 3s-after-eval misses it)
 *   - a VALID PDF named .jpg → accepted (content-based tolerance — users
 *     rename files by accident; the workers parse bytes anyway)
 *
 * This smoke locks the SOURCE patterns so the battery catches regressions:
 *
 *  1. DropZone gates: sniffIsPdf + sniffIsImage called before accept, with
 *     the errNotPdf + errNotImage toasts, wired for click/drop/paste.
 *  2. sniffIsPdf reads "%PDF-" (content), not the extension/MIME label.
 *  3. The images→PDF worker carries the full magic table (JPEG/PNG/GIF/
 *     WEBP/HEIC-brands/TIFF/SVG).
 *  4. PDF-consuming workers parse bytes (parsePdf/StampContext.load/
 *     organize paths) — the parser IS the byte validator; typed refusals.
 *  5. The ZIP-family converters catch unzip failures → honest corrupt codes.
 *  6. i18n: the dropzone error keys exist in BOTH locales.
 *
 * Run: bun scripts/smoke-magic-bytes.ts
 */
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  ✗ ${label}${actual !== undefined ? ` — ${JSON.stringify(actual).slice(0, 250)}` : ""}`);
  }
}

/* ------------------------------------------------------------------ */
/* 1. The DropZone input gate                                          */
/* ------------------------------------------------------------------ */

{
  const dz = readFileSync("src/components/doco/tool/drop-zone.tsx", "utf8");
  check(
    "dropzone: content sniffing before accept (pdf + image kinds)",
    dz.includes("await sniffIsPdf(file)") && dz.includes("await sniffIsImage(file)")
  );
  check(
    "dropzone: honest rejection toasts (not-PDF + not-image)",
    dz.includes("dropzone.errNotPdfTitle") && dz.includes("dropzone.errNotImageTitle")
  );
  check(
    "dropzone: click + drop + paste all route through validateAndAccept",
    dz.includes("handleInputChange") &&
      dz.includes("handleDrop") &&
      dz.includes("document.addEventListener(\"paste\", onPaste)")
  );
  check(
    "dropzone: oversize guard before sniff (limit + room)",
    dz.includes("file.size > limit") && dz.includes("incoming.slice(0, room)")
  );
}

/* ------------------------------------------------------------------ */
/* 2. sniffIsPdf is a CONTENT sniff                                    */
/* ------------------------------------------------------------------ */

{
  const th = readFileSync("src/lib/pdf/thumbnails.ts", "utf8");
  check(
    "sniffIsPdf: reads the %PDF- magic from the file head",
    /sniffIsPdf/.test(th) && /%PDF-/.test(th)
  );
  check(
    "sniffIsPdf: async (streams the head — no full-file read)",
    /async function sniffIsPdf/.test(th)
  );
}

/* ------------------------------------------------------------------ */
/* 3. The images→PDF magic table                                        */
/* ------------------------------------------------------------------ */

{
  const ig = readFileSync("tools/imagegrid/worker.ts", "utf8");
  const magics: Array<[string, string, RegExp]> = [
    ["JPEG", "jpeg", /\[0xff, 0xd8, 0xff\]/],
    ["PNG", "png", /\[0x89, 0x50, 0x4e, 0x47\]/],
    ["GIF", "gif", /\[0x47, 0x49, 0x46, 0x38\]/],
    ["WEBP (RIFF+offset)", "webp", /\[0x52, 0x49, 0x46, 0x46\]/],
    ["HEIC (ftyp brands)", "heic", /\[0x66, 0x74, 0x79, 0x70\]/],
  ];
  for (const [label, kind, re] of magics) {
    check(`imagegrid: ${label} magic present`, re.test(ig) && ig.includes(`"${kind}"`));
  }
  check(
    "imagegrid: TIFF magic via isTiffBytes + SVG via head scan",
    ig.includes("isTiffBytes") && ig.includes("isSvgBytes")
  );
}

/* ------------------------------------------------------------------ */
/* 4. PDF-consuming workers parse BYTES (typed refusal = the gate)      */
/* ------------------------------------------------------------------ */

{
  const workers = [
    "tools/add-watermark/worker.ts",
    "tools/compress-pdf/worker.ts",
    "tools/edit-pdf/worker.ts",
    "tools/flatten-pdf/worker.ts",
    "tools/merge-pdf/worker.ts",
    "tools/pdf-to-pdfa/worker.ts",
    "tools/redact-pdf/worker.ts",
    "tools/split-pdf/worker.ts",
  ];
  const parseSeams =
    /(parsePdf|StampContext\.load|parseForOrganize|organizeMerge|writeDocument|CreateContext)/;
  const corruptMaps = /(errorCorrupt|errCorrupt|PdfError)/;
  const bad: string[] = [];
  for (const w of workers) {
    let src = "";
    try {
      src = readFileSync(w, "utf8");
    } catch {
      bad.push(`${w} (missing)`);
      continue;
    }
    if (!parseSeams.test(src) || !corruptMaps.test(src)) bad.push(w);
  }
  check(
    "pdf workers: every consumer parses bytes + maps typed corrupt refusals",
    bad.length === 0,
    bad
  );

  const pdfa = readFileSync("tools/pdf-to-pdfa/worker.ts", "utf8");
  check(
    "pdfa: the explicit sniffIsPdf gate before parse (the 96th tool's rule)",
    pdfa.includes("sniffIsPdf") && pdfa.includes("PA_CODES.notPdf")
  );
}

/* ------------------------------------------------------------------ */
/* 5. ZIP-family converters: honest corrupt codes on unzip failure     */
/* ------------------------------------------------------------------ */

{
  const zipWorkers = [
    "tools/excel-to-pdf/worker.ts",
    "tools/powerpoint-to-pdf/worker.ts",
    "tools/epub-to-pdf/worker.ts",
    "tools/word-to-pdf/worker.ts",
  ];
  // The unzip may live in a shared parser (parseXlsx/parsePptx unzip inside);
  // the worker must consume a byte-parsing seam + catch with corrupt mapping.
  const bad: string[] = [];
  for (const w of zipWorkers) {
    const src = readFileSync(w, "utf8");
    const parses =
      /unzipSync|parseXlsx|parsePptx\b/.test(src) ||
      /parseDocx|parsePub/.test(src);
    const catches = /(catch|Corrupt|corrupt|errCorrupt|errorCorrupt)/.test(src);
    if (!parses || !catches) bad.push(w);
  }
  check("zip-family: byte-parsing seam + corrupt catch in every converter", bad.length === 0, bad);

  const pptxParse = readFileSync("tools/powerpoint-to-pdf/pptx-parse.ts", "utf8");
  check(
    "pptx-parse: the shared parser unzips bytes (PK) with typed failures",
    /unzipSync|PK/.test(pptxParse) && /catch|Corrupt/.test(pptxParse)
  );
}

/* ------------------------------------------------------------------ */
/* 6. i18n: the dropzone gate keys exist in BOTH locales               */
/* ------------------------------------------------------------------ */

{
  const en = JSON.parse(readFileSync("src/i18n/en.json", "utf8")) as Record<string, unknown>;
  const hi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8")) as Record<string, unknown>;
  const dz = (loc: Record<string, unknown>): Record<string, string> =>
    (loc.dropzone as Record<string, string>) ?? {};
  const keys = [
    "errNotPdfTitle",
    "errNotPdfDesc",
    "errNotImageTitle",
    "errNotImageDesc",
    "errTooLargeTitle",
    "errTooManyTitle",
  ];
  const missing = keys.filter(
    (k) => dz(en)[k] === undefined || dz(hi)[k] === undefined
  );
  check("i18n: dropzone gate keys exist in en + hi", missing.length === 0, missing);
}

/* ------------------------------------------------------------------ */
/* 7. The pasted/dropped route cannot bypass the gate                  */
/* ------------------------------------------------------------------ */

{
  const dz = readFileSync("src/components/doco/tool/drop-zone.tsx", "utf8");
  check(
    "dropzone: the ONLY accept path is onAccept(accepted) after validation",
    dz.includes("if (accepted.length > 0) onAccept(accepted);") &&
      (dz.match(/onAccept\(/g) ?? []).length <= 2
  );
}

console.log(`\nmagic-bytes smoke: ${pass} passed, ${fail} failed${fail > 0 ? ` — ${failures.join(" | ")}` : ""}`);
process.exit(fail > 0 ? 1 : 0);
