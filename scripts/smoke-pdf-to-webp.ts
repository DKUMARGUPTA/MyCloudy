/**
 * Smoke tests for pdf-to-webp (TOOLS-B1-a, PRD §8.6 image matrix).
 *
 * Bun has no OffscreenCanvas, and pdf.js never settles under Bun (the
 * pinned P4.1-c2 lesson) — so this script proves everything that CAN be
 * proven headless, with REAL artifacts:
 *
 *  1. Fixture: a real 3-page PDF built with @cantoo/pdf-lib, re-parsed,
 *     byte-checked and written to download/qa-pdf-to-webp-fixture.pdf
 *     (a ready asset for the orchestrator's agent-browser QA).
 *  2. Format specs: the pdf-to-webp entry (mime/ext/alpha/lossy/verifyMime)
 *     + regression vectors that pdf-to-jpg / pdf-to-png behaviour is
 *     byte-identical after the formats.ts extraction (incl. the preserved
 *     NaN passthrough of the old inline percent math).
 *  3. Option parsing: webp quality select values (and garbage) through
 *     the REAL parseWebpQuality the worker calls.
 *  4. Page ranges: the REAL parsePageSpec the worker calls.
 *  5. Filename/mime mapping: pdfBaseName + pageOutputName against the
 *     fixture's real name and the P3.4-verified sibling naming shapes.
 *  6. Capability detection + the older-Safari fallback branch: the REAL
 *     probeWebpEncode / verifyWebpBlob with MOCKED canvases (WebP-ok,
 *     silent-PNG-fallback, empty type, throwing encode, no 2d context)
 *     → asserts the exact webpOut.errorUnsupported code + detail the
 *     worker posts.
 *  7. Config schema + chain targets + i18n parity (en↔hi key sets,
 *     placeholder parity, Devanagari present).
 *
 * NOT covered here (needs a real browser): pdf.js page rendering, a real
 * WebP encode, and the worker end-to-end — that is agent-browser QA,
 * exactly like the pdf-to-jpg/png family.
 *
 * Usage: bun scripts/smoke-pdf-to-webp.ts
 */
import * as fs from "node:fs";

import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";

import { parsePageSpec } from "../src/lib/workers/protocol";
import {
  FORMAT_SPECS,
  getFormatSpec,
  pageOutputName,
  parsePercentQuality,
  parseWebpQuality,
  pdfBaseName,
} from "../tools/pdf-to-images/formats";
import {
  probeWebpEncode,
  verifyWebpBlob,
  WEBP_MIME,
  WEBP_UNSUPPORTED_CODE,
  type ProbeCanvas,
  type ProbeContext2D,
} from "../tools/pdf-to-images/webp-encode";
import { config } from "../tools/pdf-to-webp/config";

const ROOT = new URL("..", import.meta.url).pathname;
const FIXTURE_PATH = `${ROOT}download/qa-pdf-to-webp-fixture.pdf`;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, extra = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${extra ? ` — ${extra}` : ""}`);
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Mock canvases (the browser side Bun cannot provide)
// ---------------------------------------------------------------------------

interface MockOptions {
  /** What convertToBlob pretends the browser produced (Safari-style: it
   * ignores the requested type — the recorded calls prove the ask). */
  blobType: string;
  throwOnConvert?: boolean;
  noContext?: boolean;
}

/** Records the exact convertToBlob args the probe passed. */
const convertCalls: { type: string; quality?: number }[] = [];

function mockCanvas(options: MockOptions): ProbeCanvas {
  const context: ProbeContext2D = {
    fillStyle: "",
    fillRect: () => undefined,
  };
  return {
    width: 1,
    height: 1,
    getContext: (type: "2d") => (options.noContext ? null : type === "2d" ? context : null),
    convertToBlob: async (opts) => {
      convertCalls.push({ type: opts.type, quality: opts.quality });
      if (options.throwOnConvert) throw new Error("encode failed");
      const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // "RIFF"
      return new Blob([bytes as unknown as BlobPart], {
        type: options.blobType,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture: a real multi-page PDF
// ---------------------------------------------------------------------------

async function buildFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("pdf-to-webp smoke fixture");
  doc.setAuthor("DocoPDF smoke");
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  // Three distinguishable pages (warm neutrals — no brand colours needed).
  const fills: [number, number, number][] = [
    [0.96, 0.93, 0.86],
    [0.87, 0.92, 0.84],
    [0.92, 0.87, 0.84],
  ];
  for (let i = 0; i < fills.length; i += 1) {
    const page = doc.addPage([420, 297]);
    page.drawRectangle({
      x: 0,
      y: 0,
      width: 420,
      height: 297,
      color: rgb(fills[i][0], fills[i][1], fills[i][2]),
    });
    page.drawText(`WEBP SMOKE PAGE ${i + 1} of ${fills.length}`, {
      x: 36,
      y: 148,
      size: 18,
      font,
    });
  }
  return doc.save();
}

async function main() {
  console.log("== fixture: real 3-page PDF ==");
  const fixture = await buildFixture();
  check("starts with %PDF-", fixture[0] === 0x25 && fixture[1] === 0x50 && fixture[2] === 0x44 && fixture[3] === 0x46);
  check("fixture has bytes", fixture.length > 1000, `${fixture.length}`);
  const reparsed = await PDFDocument.load(fixture.slice());
  check("re-parse page count = 3", reparsed.getPageCount() === 3, `${reparsed.getPageCount()}`);
  check("title round-trips", reparsed.getTitle() === "pdf-to-webp smoke fixture");
  fs.mkdirSync(`${ROOT}download`, { recursive: true });
  fs.writeFileSync(FIXTURE_PATH, fixture);
  const written = fs.statSync(FIXTURE_PATH);
  check(
    "fixture written to download/qa-pdf-to-webp-fixture.pdf",
    written.isFile() && written.size === fixture.length,
    `${written.size} bytes`
  );

  console.log("== format specs (worker's real table) ==");
  const webp = getFormatSpec("pdf-to-webp");
  check("mime image/webp", webp.mime === "image/webp");
  check("ext webp", webp.ext === "webp");
  check("alpha allowed", webp.alpha === true);
  check("lossy (quality applies)", webp.lossy === true);
  check("verifyMime on", webp.verifyMime === true);
  const jpg = getFormatSpec("pdf-to-jpg");
  check("jpg spec preserved", jpg.mime === "image/jpeg" && jpg.ext === "jpg" && jpg.alpha === false && jpg.lossy === true);
  const png = getFormatSpec("pdf-to-png");
  check("png spec preserved", png.mime === "image/png" && png.ext === "png" && png.alpha === true && png.lossy === false);
  check("png skips quality (lossy false → undefined)", png.lossy === false);
  check("unknown tool falls back to jpg", getFormatSpec("no-such-tool").ext === "jpg");
  check(
    "format table has exactly the 5 family tools (jpg, png, webp, tiff, svg)",
    Object.keys(FORMAT_SPECS)
      .sort()
      .join(",") === "pdf-to-jpg,pdf-to-png,pdf-to-svg,pdf-to-tiff,pdf-to-webp",
    Object.keys(FORMAT_SPECS).sort().join(",")
  );

  console.log("== quality parsing (real functions) ==");
  check('parseWebpQuality("0.9") = 0.9', parseWebpQuality("0.9") === 0.9);
  check('parseWebpQuality("0.85") = 0.85', parseWebpQuality("0.85") === 0.85);
  check('parseWebpQuality("0.8") = 0.8', parseWebpQuality("0.8") === 0.8);
  check('parseWebpQuality("0.7") = 0.7', parseWebpQuality("0.7") === 0.7);
  check("parseWebpQuality(undefined) = 0.85 default", parseWebpQuality(undefined) === 0.85);
  check('parseWebpQuality("garbage") = 0.85 fallback', parseWebpQuality("garbage") === 0.85);
  check('parseWebpQuality(2) clamps to 1', parseWebpQuality(2) === 1);
  check('parseWebpQuality("0.1") clamps to 0.5', parseWebpQuality("0.1") === 0.5);
  // pdf-to-jpg regression: identical to the pre-refactor inline math.
  check("parsePercentQuality(85) = 0.85 (jpg default)", parsePercentQuality(85) === 0.85);
  check("parsePercentQuality(undefined) = 0.85", parsePercentQuality(undefined) === 0.85);
  check("parsePercentQuality(40) = 0.4 floor", parsePercentQuality(40) === 0.4);
  check("parsePercentQuality(100) = 1", parsePercentQuality(100) === 1);
  check("parsePercentQuality(150) clamps to 1", parsePercentQuality(150) === 1);
  check(
    "parsePercentQuality NaN passthrough preserved (old behaviour)",
    Number.isNaN(parsePercentQuality("garbage"))
  );

  console.log("== page ranges (real parsePageSpec) ==");
  check('"all" → 0..2', JSON.stringify(parsePageSpec("all", 3)) === "[0,1,2]");
  check('"1-3, 5" of 10', JSON.stringify(parsePageSpec("1-3, 5", 10)) === "[0,1,2,4]");
  check('"8-" of 10 (open range)', JSON.stringify(parsePageSpec("8-", 10)) === "[7,8,9]");
  check('"2" of 10 (single)', JSON.stringify(parsePageSpec("2", 10)) === "[1]");
  check('"5-2" normalizes', JSON.stringify(parsePageSpec("5-2", 10)) === "[1,2,3,4]");
  check('"0-99" clamps to page count', JSON.stringify(parsePageSpec("0-99", 3)) === "[0,1,2]");
  check('"1,,3" skips empties', JSON.stringify(parsePageSpec("1,,3", 10)) === "[0,2]");
  check('"abc" → null', parsePageSpec("abc", 10) === null);
  check('"" → all', JSON.stringify(parsePageSpec("", 3)) === "[0,1,2]");
  check('fixture "1-2" selects 2 pages', (parsePageSpec("1-2", 3) ?? []).length === 2);

  console.log("== filename / mime mapping (real helpers) ==");
  const base = pdfBaseName("qa-pdf-to-webp-fixture.pdf");
  check("base name strips .pdf", base === "qa-pdf-to-webp-fixture", base);
  check(
    "base name strips .PDF case-insensitively",
    pdfBaseName("report.PDF") === "report"
  );
  check(
    "base name sanitizes path chars",
    pdfBaseName('a/b:c*d?"e<f>g|.pdf') === "a_b_c_d__e_f_g_"
  );
  check(
    "base name truncates to 120",
    pdfBaseName(`${"x".repeat(300)}.pdf`).length === 120
  );
  check(
    "single page → base.webp",
    pageOutputName("split-test", 5, 1, "webp") === "split-test.webp"
  );
  check(
    "multi page → base_pageN.webp (fixture shape)",
    pageOutputName(base, 2, 3, "webp") === "qa-pdf-to-webp-fixture_page2.webp"
  );
  check(
    "jpg naming shape preserved (P3.4-verified)",
    pageOutputName("report", 2, 3, "jpg") === "report_page2.jpg" &&
      pageOutputName("report", 1, 1, "jpg") === "report.jpg"
  );
  check(
    "png naming shape preserved",
    pageOutputName("split-test", 5, 1, "png") === "split-test.png"
  );

  console.log("== WebP capability probe (mocked canvas) ==");
  convertCalls.length = 0;
  const okProbe = await probeWebpEncode(() => mockCanvas({ blobType: WEBP_MIME }));
  check("webp-capable browser → supported", okProbe.supported === true);
  check("observed image/webp", okProbe.observed === WEBP_MIME);
  check(
    "probe asked convertToBlob for image/webp + quality",
    convertCalls.length === 1 &&
      convertCalls[0].type === "image/webp" &&
      typeof convertCalls[0].quality === "number"
  );

  convertCalls.length = 0;
  const safariProbe = await probeWebpEncode(() =>
    mockCanvas({ blobType: "image/png" })
  );
  check("older-Safari silent PNG fallback → NOT supported", safariProbe.supported === false);
  check("fallback observed = image/png", safariProbe.observed === "image/png");
  check(
    "probe still requested image/webp (proving the ask was right)",
    convertCalls.length === 1 && convertCalls[0].type === "image/webp"
  );

  const throwProbe = await probeWebpEncode(() => mockCanvas({ blobType: WEBP_MIME, throwOnConvert: true }));
  check("throwing encode → not supported", throwProbe.supported === false && throwProbe.observed === "error");

  const noCtxProbe = await probeWebpEncode(() => mockCanvas({ blobType: WEBP_MIME, noContext: true }));
  check("no 2d context → not supported", noCtxProbe.supported === false && noCtxProbe.observed === "no-2d-context");

  const emptyTypeProbe = await probeWebpEncode(() => mockCanvas({ blobType: "" }));
  check("empty blob type → observed none", emptyTypeProbe.observed === "none");

  console.log("== blob verification → webp-unsupported branch ==");
  const pngBlob = new Blob([new Uint8Array([0x89, 0x50]) as unknown as BlobPart], { type: "image/png" });
  const verdict = verifyWebpBlob(pngBlob);
  check(
    "PNG blob → NOT ok, code webpOut.errorUnsupported",
    verdict.ok === false && verdict.code === "webpOut.errorUnsupported"
  );
  check("PNG blob detail = image/png", !verdict.ok && verdict.detail === "image/png");
  check(
    "WEBP_UNSUPPORTED_CODE is the i18n key",
    WEBP_UNSUPPORTED_CODE === "webpOut.errorUnsupported"
  );
  const webpBlob = new Blob([new Uint8Array([0x52, 0x49]) as unknown as BlobPart], { type: WEBP_MIME });
  const okVerdict = verifyWebpBlob(webpBlob);
  check("real WebP blob passes", okVerdict.ok === true);
  const emptyBlob = new Blob([]);
  const emptyVerdict = verifyWebpBlob(emptyBlob);
  check(
    "empty-type blob → webp-unsupported, detail none",
    emptyVerdict.ok === false && emptyVerdict.detail === "none"
  );
  check(
    "worker contract: Safari probe failure maps to the exact error post",
    !safariProbe.supported &&
      !verdict.ok &&
      safariProbe.observed === verdict.detail &&
      verdict.code === WEBP_UNSUPPORTED_CODE
  );

  console.log("== config schema ==");
  check("toolId pdf-to-webp", config.toolId === "pdf-to-webp");
  check("outputKind image", config.outputKind === "image");
  check("file limits 1..5", config.minFiles === 1 && config.maxFiles === 5);
  const byId: Record<string, (typeof config.options)[number]> = {};
  for (const field of config.options) byId[field.id] = field;
  check("exactly 3 options: dpi, pages, quality", Object.keys(byId).sort().join(",") === "dpi,pages,quality");
  const dpi = byId.dpi;
  check("dpi is select", dpi.kind === "select");
  if (dpi.kind === "select") {
    check(
      "dpi choices 72/150/300/600 default 150",
      dpi.choices.map((c) => c.value).join(",") === "72,150,300,600" && dpi.default === "150"
    );
  }
  check("pages default all", byId.pages.kind === "pages" && byId.pages.default === "all");
  const quality = byId.quality;
  check("quality is select", quality.kind === "select");
  if (quality.kind === "select") {
    check(
      "quality choices 0.9/0.85/0.8/0.7 default 0.85",
      quality.choices.map((c) => c.value).join(",") === "0.9,0.85,0.8,0.7" &&
        quality.default === "0.85"
    );
    check(
      "every quality choice parses inside 0.5..1",
      quality.choices.every((c) => {
        const q = parseWebpQuality(c.value);
        return q >= 0.5 && q <= 1;
      })
    );
  }
  check(
    "createWorker targets the shared family worker",
    typeof config.createWorker === "function"
  );
  check(
    "features: 5 bullets, en+hi non-empty",
    config.features.length === 5 &&
      config.features.every((f) => f.en.length > 0 && f.hi.length > 0)
  );
  check(
    "faq: 3 items, q+a en+hi non-empty",
    config.faq.length === 3 &&
      config.faq.every((f) => f.q.en.length > 0 && f.q.hi.length > 0 && f.a.en.length > 0 && f.a.hi.length > 0)
  );
  check(
    "every L10n string in the schema carries Devanagari Hindi",
    config.features.concat(config.faq.flatMap((f) => [f.q, f.a])).every((l) => /[\u0900-\u097F]/.test(l.hi))
  );

  console.log("== chain targets exist in the registry ==");
  const registrySource = fs.readFileSync(`${ROOT}src/lib/tools/registry.ts`, "utf8");
  check("registry entry for pdf-to-webp exists", registrySource.includes('id: "pdf-to-webp"'));
  const chains = config.chainToolIds ?? [];
  check("chainToolIds non-empty", chains.length > 0);
  for (const id of chains) {
    check(`chain target "${id}" is a registry id`, registrySource.includes(`id: "${id}"`));
  }

  console.log("== i18n parity (tools/pdf-to-webp/i18n.json) ==");
  const part = JSON.parse(fs.readFileSync(`${ROOT}tools/pdf-to-webp/i18n.json`, "utf8")) as {
    en: { webpOut: Record<string, string> };
    hi: { webpOut: Record<string, string> };
  };
  const enKeys = Object.keys(part.en.webpOut).sort();
  const hiKeys = Object.keys(part.hi.webpOut).sort();
  check("en↔hi key parity", JSON.stringify(enKeys) === JSON.stringify(hiKeys));
  check(
    "section carries the expected keys",
    enKeys.join(",") === "errorUnsupported,hint,successNote,successTitle,surfaceLabel",
    enKeys.join(",")
  );
  check(
    "all values non-empty",
    Object.keys(part.en.webpOut).every((k) => part.en.webpOut[k].length > 0) &&
      Object.keys(part.hi.webpOut).every((k) => part.hi.webpOut[k].length > 0)
  );
  check(
    "errorUnsupported carries {detail} in both locales",
    part.en.webpOut.errorUnsupported.indexOf("{detail}") >= 0 &&
      part.hi.webpOut.errorUnsupported.indexOf("{detail}") >= 0
  );
  check(
    "successNote plural in both locales",
    part.en.webpOut.successNote.indexOf("count, plural") >= 0 &&
      part.hi.webpOut.successNote.indexOf("count, plural") >= 0
  );
  check(
    "every Hindi value contains Devanagari",
    Object.keys(part.hi.webpOut).every((k) => /[\u0900-\u097F]/.test(part.hi.webpOut[k]))
  );

  console.log("== coverage honesty ==");
  console.log(
    "  covered  : real 3-page PDF fixture (built, re-parsed, written);" +
      " format table incl. jpg/png regression vectors; quality + page-range" +
      " + naming logic (the REAL worker functions); WebP capability probe" +
      " and blob verification with mocked canvases, incl. the older-Safari" +
      " silent-PNG fallback → webpOut.errorUnsupported; config schema;" +
      " chain targets; i18n parity."
  );
  console.log(
    "  NOT here : real pdf.js render, real WebP encode, worker E2E —" +
      " Bun has no OffscreenCanvas and pdf.js never settles under Bun" +
      " (P4.1-c2). Needs agent-browser QA (fixture: download/qa-pdf-to-webp-fixture.pdf)."
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) console.log(`  FAILED: ${f}`);
    process.exit(1);
  }
}

void main();
