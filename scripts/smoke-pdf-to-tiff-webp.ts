/**
 * Smoke tests for pdf-to-webp + pdf-to-tiff wiring (RB3-quick round).
 *
 * The two tools ride the shared tools/pdf-to-images/worker.ts:
 *  - webp joins the canvas-encode FORMAT map (with the honest
 *    blob.type guard for encoders that silently hand back PNG),
 *  - tiff branches to the clean-room TiffBuilder (multipage chain
 *    per file, or separate single-page files).
 *
 * What Node can honestly verify (no OffscreenCanvas in Node):
 * 1. Config wiring: both tool configs import, correct ids, options,
 *    chains; registry defs enabled; configs routed in TOOL_CONFIGS;
 *    panels registered.
 * 2. i18n: the new tool.errorWebpUnsupported key resolves in BOTH
 *    catalogs (en/hi) + the shared pdfimg.* panel keys exist.
 * 3. TIFF integration at the EXACT worker call-shape: multipage=true
 *    (one builder, pages added as the worker adds them) and
 *    multipage=false (one builder per page) — decoded back through
 *    the production TIFF reader (tools/imgconv/tiff) as the oracle:
 *    page count, dimensions, pixel-exact RGBA, LZW/none compression
 *    tags, DPI rationals via the independent minimal parser.
 * 4. Rendered-pixel RAM budget (ENH-1): the shared worker checks
 *    RenderPixelBudget BEFORE every page render (canvas-encode and
 *    TIFF branches alike) and refuses runs past ~250 accumulated
 *    megapixels with the honest tool.errorRenderBudget error.
 *
 * Usage: bun scripts/smoke-pdf-to-tiff-webp.ts
 */
import { readFileSync } from "node:fs";
import { TiffBuilder } from "../tools/pdf-to-images/tiff-writer";
import {
  RenderPixelBudget,
  RENDER_PIXEL_BUDGET,
} from "../tools/pdfjs-common/pixel-budget";
import { decodeTiffPages, type TiffRgbaPage } from "../tools/imgconv/tiff";
import { config as webpConfig } from "../tools/pdf-to-webp/config";
import { config as tiffConfig } from "../tools/pdf-to-tiff/config";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, note = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}${note ? ` — ${note}` : ""}`);
  } else {
    failed += 1;
    failures.push(`${name}${note ? ` — ${note}` : ""}`);
    console.log(`  ✗ ${name}${note ? ` — ${note}` : ""}`);
  }
}

/* ---------------------------------------------------------------- */
/* Independent minimal little-endian TIFF structure reader          */
/* (test-only; mirrors scripts/smoke-tiff.ts's oracle)              */
/* ---------------------------------------------------------------- */
interface ParsedIfd {
  entries: Map<number, { type: number; count: number; value: number }>;
  nextIfd: number;
}

function parseTiff(bytes: Uint8Array): {
  ifds: ParsedIfd[];
  readShort: (at: number) => number;
  readLong: (at: number) => number;
} {
  if (bytes[0] !== 0x49 || bytes[1] !== 0x49) throw new Error("not II");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(2, true) !== 42) throw new Error("bad magic");
  const readShort = (at: number) => view.getUint16(at, true);
  const readLong = (at: number) => view.getUint32(at, true);
  const ifds: ParsedIfd[] = [];
  let at = readLong(4);
  while (at !== 0 && ifds.length < 100) {
    const count = readShort(at);
    const entries = new Map<
      number,
      { type: number; count: number; value: number }
    >();
    for (let i = 0; i < count; i += 1) {
      const e = at + 2 + i * 12;
      entries.set(readShort(e), {
        type: readShort(e + 2),
        count: readLong(e + 4),
        value: readLong(e + 8),
      });
    }
    const nextIfd = readLong(at + 2 + count * 12);
    ifds.push({ entries, nextIfd });
    at = nextIfd;
  }
  return { ifds, readShort, readLong };
}

/** Deterministic RGBA page (mirrors the worker's ImageData layout). */
function makePage(
  width: number,
  height: number,
  seed: number
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, s = 0; p < width * height; p += 1, s += 4) {
    rgba[s] = (p * 7 + seed) & 0xff;
    rgba[s + 1] = (p * 13 + seed * 3) & 0xff;
    rgba[s + 2] = (p * 29 + seed * 5) & 0xff;
    rgba[s + 3] = 255;
  }
  return rgba;
}

async function main(): Promise<void> {
  console.log("pdf-to-webp + pdf-to-tiff wiring — configs + i18n + TIFF integration");

  /* ---------------- 1. config wiring ---------------- */
  console.log("── 1. config wiring ──────────────────────────────");
  check("webp config toolId", webpConfig.toolId === "pdf-to-webp");
  check("tiff config toolId", tiffConfig.toolId === "pdf-to-tiff");
  check(
    "webp worker URL targets the shared pdf-to-images worker",
    String(webpConfig.createWorker).includes("pdf-to-images")
  );
  check(
    "tiff worker URL targets the shared pdf-to-images worker",
    String(tiffConfig.createWorker).includes("pdf-to-images")
  );
  const webpOptionIds = webpConfig.options.map((o) => o.id);
  check(
    "webp options: dpi/pages/quality/transparent",
    ["dpi", "pages", "quality", "transparent"].every((id) =>
      webpOptionIds.includes(id)
    ),
    webpOptionIds.join(",")
  );
  const tiffOptionIds = tiffConfig.options.map((o) => o.id);
  check(
    "tiff options: dpi/pages/compression/multipage",
    ["dpi", "pages", "compression", "multipage"].every((id) =>
      tiffOptionIds.includes(id)
    ),
    tiffOptionIds.join(",")
  );
  check(
    "tiff chains to tiff-to-pdf (round-trip closes)",
    (tiffConfig.chainToolIds ?? []).includes("tiff-to-pdf")
  );
  check(
    "webp chains to webp-to-pdf",
    (webpConfig.chainToolIds ?? []).includes("webp-to-pdf")
  );
  check(
    "webp features/faq bilingual",
    webpConfig.features.every((f) => f.en && f.hi) &&
      webpConfig.faq.every((q) => q.q.en && q.q.hi && q.a.en && q.a.hi)
  );
  check(
    "tiff features/faq bilingual",
    tiffConfig.features.every((f) => f.en && f.hi) &&
      tiffConfig.faq.every((q) => q.q.en && q.q.hi && q.a.en && q.a.hi)
  );

  /* ---------------- 2. registry + routing ---------------- */
  console.log("── 2. registry + routing ────────────────────────");
  const registrySrc = readFileSync("src/lib/tools/registry.ts", "utf8");
  for (const id of ["pdf-to-webp", "pdf-to-tiff"]) {
    const m = registrySrc.match(
      new RegExp(`id: "${id}"[\\s\\S]*?enabled: (true|false)`)
    );
    check(`registry ${id} enabled: true`, m?.[1] === "true");
  }
  const configsSrc = readFileSync("src/lib/tools/configs.ts", "utf8");
  check(
    "TOOL_CONFIGS routes pdf-to-webp",
    /pdfToWebp\.toolId\]\s*:\s*pdfToWebp/.test(configsSrc)
  );
  check(
    "TOOL_CONFIGS routes pdf-to-tiff",
    /pdfToTiff\.toolId\]\s*:\s*pdfToTiff/.test(configsSrc)
  );
  const panelsSrc = readFileSync("src/lib/tools/panels.tsx", "utf8");
  check(
    "panels.tsx maps both to PdfToImagesPanel",
    /"pdf-to-webp": PdfToImagesPanel/.test(panelsSrc) &&
      /"pdf-to-tiff": PdfToImagesPanel/.test(panelsSrc)
  );

  /* ---------------- 3. worker FORMAT/tiff branch ---------------- */
  console.log("── 3. worker branches ────────────────────────────");
  const workerSrc = readFileSync("tools/pdf-to-images/worker.ts", "utf8");
  check(
    'FORMAT has webp entry (lossy + alpha)',
    /"pdf-to-webp":\s*\{ mime: "image\/webp", ext: "webp", alpha: true, lossy: true \}/.test(
      workerSrc
    )
  );
  check(
    "tiff branch routes to TiffBuilder",
    /tiffBuilder \?\?= new TiffBuilder/.test(workerSrc) &&
      /isTiff = toolId === "pdf-to-tiff"/.test(workerSrc)
  );
  check(
    "webp honest encoder guard (blob.type mismatch → errorWebpUnsupported)",
    /blob\.type !== format\.mime/.test(workerSrc) &&
      /tool\.errorWebpUnsupported/.test(workerSrc)
  );
  check(
    "canvas quality applied only to lossy formats",
    /quality: format\.lossy \? quality : undefined/.test(workerSrc)
  );

  /* ---------------- 4. i18n keys ---------------- */
  console.log("── 4. i18n keys ──────────────────────────────────");
  const en = JSON.parse(readFileSync("src/i18n/en.json", "utf8"));
  const hi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8"));
  check(
    "tool.errorWebpUnsupported in en",
    typeof en.tool?.errorWebpUnsupported === "string" &&
      en.tool.errorWebpUnsupported.length > 10
  );
  check(
    "tool.errorWebpUnsupported in hi",
    typeof hi.tool?.errorWebpUnsupported === "string" &&
      hi.tool.errorWebpUnsupported.length > 10
  );
  for (const key of [
    "previewTitle",
    "previewSize",
    "previewNote",
    "previewLoading",
    "previewFailed",
  ]) {
    check(
      `pdfimg.${key} shared in both catalogs`,
      typeof en.pdfimg?.[key] === "string" && typeof hi.pdfimg?.[key] === "string"
    );
  }

  // AUD-B fix: the shared preview panel must catch probe failures — a
  // rejected getPdfPagePixelSize may never leave the loading state up.
  const panelSrc = readFileSync("tools/pdf-to-images/panel.tsx", "utf8");
  check(
    "panel: failure state set in the catch + honest hint rendered",
    /\.catch\(\(\) =>\s*\{[\s\S]*?setFailed\(true\)/.test(panelSrc) &&
      panelSrc.includes("pdfimg.previewFailed")
  );
  check(
    "panel: previewLoading only shown while NOT failed",
    /failed\s*\?\s*[\s\S]*?previewFailed[\s\S]*?:\s*[\s\S]*?previewLoading/.test(
      panelSrc
    )
  );

  /* ---------------- 5. TIFF integration (worker call-shape) ---------------- */
  console.log("── 5. TIFF integration — multipage=true ───────────");
  const DPI = 300;
  const PAGES = [
    { w: 64, h: 48, rgba: makePage(64, 48, 1) },
    { w: 61, h: 47, rgba: makePage(61, 47, 2) }, // odd dims like real renders
    { w: 55, h: 41, rgba: makePage(55, 41, 3) },
  ];

  // The worker's exact multipage pattern: ONE builder, addPage per render.
  const builder = new TiffBuilder({ compression: "lzw", dpi: DPI });
  for (const p of PAGES) builder.addPage({ width: p.w, height: p.h, rgba: p.rgba });
  const tiff = builder.finish();

  const { ifds, readShort, readLong } = parseTiff(tiff);
  check("multipage: 3 chained IFDs", ifds.length === 3, `got ${ifds.length}`);
  check("multipage: NextIFD chain 0→1→2→0", ifds[0].nextIfd !== 0 && ifds[1].nextIfd !== 0 && ifds[2].nextIfd === 0);
  check("multipage: LZW compression tag", ifds.every((i) => i.entries.get(259)?.value === 5));
  check(
    "multipage: XResolution rational = 300/1",
    ifds.every((i) => {
      const at = i.entries.get(282)!.value;
      return readLong(at) === DPI && readLong(at + 4) === 1;
    })
  );
  check(
    "multipage: YResolution rational = 300/1",
    ifds.every((i) => {
      const at = i.entries.get(283)!.value;
      return readLong(at) === DPI && readLong(at + 4) === 1;
    })
  );
  check(
    "multipage: ResolutionUnit = inch",
    ifds.every((i) => i.entries.get(296)?.value === 2)
  );
  check(
    "multipage: PageNumber pairs [i, 3]",
    ifds.every((i, n) => {
      const v = i.entries.get(297)!.value;
      return (v & 0xffff) === n && (v >>> 16) === 3;
    })
  );
  check(
    "multipage: per-page dims",
    ifds[0].entries.get(256)?.value === 64 &&
      ifds[0].entries.get(257)?.value === 48 &&
      ifds[1].entries.get(256)?.value === 61 &&
      ifds[1].entries.get(257)?.value === 47 &&
      ifds[2].entries.get(256)?.value === 55 &&
      ifds[2].entries.get(257)?.value === 41
  );
  check(
    "multipage: BitsPerSample 8/8/8 via offset",
    ifds.every((i) => {
      const at = i.entries.get(258)!.value;
      return readShort(at) === 8 && readShort(at + 2) === 8 && readShort(at + 4) === 8;
    })
  );

  // Production reader oracle: pixel-exact decode of every page.
  const decoded: TiffRgbaPage[] = decodeTiffPages(tiff);
  check("multipage: reader sees 3 pages", decoded.length === 3);
  let pixelsExact = true;
  for (let n = 0; n < 3; n += 1) {
    const page = decoded[n];
    if (page.width !== PAGES[n].w || page.height !== PAGES[n].h) {
      pixelsExact = false;
      break;
    }
    const rgba = PAGES[n].rgba;
    for (let s = 0; s < rgba.length; s += 4) {
      if (
        page.rgba[s] !== rgba[s] ||
        page.rgba[s + 1] !== rgba[s + 1] ||
        page.rgba[s + 2] !== rgba[s + 2]
      ) {
        pixelsExact = false;
        break;
      }
    }
    if (!pixelsExact) break;
  }
  check("multipage: pixel-exact RGBA through the production reader", pixelsExact);

  console.log("── 6. TIFF integration — multipage=false ──────────");
  // The worker's per-page pattern: a FRESH builder per page.
  for (let n = 0; n < PAGES.length; n += 1) {
    const single = new TiffBuilder({ compression: "lzw", dpi: DPI });
    single.addPage({
      width: PAGES[n].w,
      height: PAGES[n].h,
      rgba: PAGES[n].rgba,
    });
    const bytes = single.finish();
    const parsed = parseTiff(bytes);
    check(
      `single page ${n + 1}: exactly one IFD, terminating chain`,
      parsed.ifds.length === 1 && parsed.ifds[0].nextIfd === 0
    );
    const decodedSingle: TiffRgbaPage[] = decodeTiffPages(bytes);
    check(
      `single page ${n + 1}: reader round-trip`,
      decodedSingle.length === 1 &&
        decodedSingle[0].width === PAGES[n].w
    );
  }

  console.log("── 7. TIFF compression=none path ──────────────────");
  {
    const none = new TiffBuilder({ compression: "none", dpi: 150 });
    none.addPage({ width: 16, height: 12, rgba: makePage(16, 12, 9) });
    const bytes = none.finish();
    const parsed = parseTiff(bytes);
    check(
      "none: Compression tag = 1",
      parsed.ifds[0].entries.get(259)?.value === 1
    );
    const decodedNone: TiffRgbaPage[] = decodeTiffPages(bytes);
    check("none: reader round-trip", decodedNone.length === 1);
  }

  /* ---------------- 8. rendered-pixel RAM budget (ENH-1) ---------------- */
  console.log("── 8. rendered-pixel RAM budget (ENH-1) ────────");
  check(
    "default cap is 250 MP (≈ 119 letter pages @150 DPI)",
    RENDER_PIXEL_BUDGET === 250_000_000
  );
  const budget = new RenderPixelBudget(1_000);
  check("page that fits is consumed", budget.tryConsume(600, 1) === true);
  check(
    "accumulation is exact",
    budget.consumed === 600 && budget.remaining === 400
  );
  check(
    "a page over the REMAINING budget is refused atomically",
    budget.tryConsume(401, 1) === false && budget.consumed === 600
  );
  check(
    "landing exactly on the cap still fits",
    budget.tryConsume(400, 1) === true && budget.remaining === 0
  );
  check(
    "zero/negative areas refused without consuming",
    !new RenderPixelBudget(100).tryConsume(0, 50) &&
      !new RenderPixelBudget(100).tryConsume(50, 0) &&
      !new RenderPixelBudget(100).tryConsume(-1, 5)
  );
  check(
    "a single monster page above the cap is refused (DPI 8 poster)",
    !new RenderPixelBudget(250_000_000).tryConsume(20_000, 20_000)
  );
  check(
    "letter @300 DPI pages fit ~29-30 times (the honest ceiling)",
    (() => {
      const b = new RenderPixelBudget();
      let fits = 0;
      while (b.tryConsume(2550, 3300)) fits += 1;
      return fits >= 29 && fits <= 30;
    })()
  );

  const budgetWorkerSrc = readFileSync("tools/pdf-to-images/worker.ts", "utf8");
  check(
    "shared worker imports the pixel budget",
    /import \{ RenderPixelBudget \} from "\.\.\/pdfjs-common\/pixel-budget"/.test(
      budgetWorkerSrc
    )
  );
  check(
    "budget is created once per run (accumulates across files)",
    /const budget = new RenderPixelBudget\(\);/.test(budgetWorkerSrc)
  );
  check(
    "the tryConsume refusal fires BEFORE the page render",
    /if \(!budget\.tryConsume\(width, height\)\)\s*\{[\s\S]*?tool\.errorRenderBudget[\s\S]*?\}[\s\S]*await page\.render/.test(
      budgetWorkerSrc
    )
  );
  check(
    "the shared check covers the TIFF branch too",
    budgetWorkerSrc.indexOf("budget.tryConsume") < budgetWorkerSrc.indexOf("if (isTiff)")
  );

  check(
    "tool.errorRenderBudget in en",
    typeof en.tool?.errorRenderBudget === "string" &&
      en.tool.errorRenderBudget.length > 10
  );
  check(
    "tool.errorRenderBudget in hi",
    typeof hi.tool?.errorRenderBudget === "string" &&
      hi.tool.errorRenderBudget.length > 10
  );

  /* ---------------- summary ---------------- */
  console.log("");
  console.log(
    `pdf-to-tiff/webp wiring smoke: ${passed} passed, ${failed} failed`
  );
  if (failures.length > 0) {
    console.log("FAILURES:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

void main();
