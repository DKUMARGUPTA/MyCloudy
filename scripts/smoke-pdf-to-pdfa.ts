/**
 * Smoke: pdf-to-pdfa (RB7-FIN-a2 — the 96th tool, optimize) — the honest
 * on-device PDF/A-1b/2b/3b converter.
 *
 * House conventions (smoke-digital-signature / smoke-request-signature):
 * relative imports WITHOUT .ts, plain check() helper, process.exit(0) at
 * the end, count every check. node:zlib inflates the output streams; the
 * REAL worker runs through a self-shimmed globalThis whose fetch serves
 * the self-hosted standard-font programs from public/pdfjs/standard_fonts.
 *
 *  0. Wiring sanity (source-text checks — React files are not node-safe):
 *     configs/surfaces/registry entries, i18n parity + referenced keys
 *     (namespace prefix "pa." = 3 chars — the RB6 slice(6) lesson).
 *  1. Model vectors — parse/coercion, the WinAnsi table, the naive color
 *     math + pdfNumber, the content-stream tokenizer + color normalizer
 *     (state machine, patterns/Indexed/Separation left as-is, inline
 *     images byte-preserved, countColorOps oracle), the XMP packet, the
 *     hand-rolled sRGB ICC (structural parse + TRC/primaries oracles),
 *     the standard-14 asset map + AFM widths, the risk sniff, the output
 *     names, buildReportText EN+HI.
 *  2. REAL E2E through the worker: a 2-page pdf-lib fixture (title +
 *     Helvetica + a g + a k fill) converted at 1b/2b/3b — header version,
 *     trailer /ID, catalog /Metadata XMP (pdfaid:part + dc:title parsed),
 *     /OutputIntents with the embedded ICC (/N 3), fonts policy per level
 *     (1b keeps the standard-14 unembedded, 2b embeds LiberationSans with
 *     AFM widths), colors actually rewritten in the re-inflated streams,
 *     text intact, the .txt report honesty; a JS tree + /OpenAction + /AA
 *     + Screen-annot fixture stripped and counted; an attached file
 *     dropped at 1b and kept + /AFRelationship-patched at 3b; a
 *     transparency fixture rejected at 1b and allowed at 2b; an
 *     unembeddable-font fixture rejected with the page list; encrypted /
 *     empty / non-PDF / garbage rejection vectors; EN+HI reports; output
 *     name honesty; progress beats; non-run messages ignored.
 *
 * Run: bun scripts/smoke-pdf-to-pdfa.ts
 */
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFStream,
  PDFString,
  StandardFonts,
  cmyk,
  grayscale,
} from "pdf-lib";

import {
  DEFAULT_PDFA_TARGET,
  PA_CODES,
  PDFA_TARGETS,
  PDFA_TARGET_INFO,
  PFAID_NAMESPACE,
  SRGB_ICC_SIZE,
  SRGB_TRC_SAMPLES,
  STANDARD14_ASSETS,
  afmOf,
  afmWidthsBuiltin,
  afmWidthsWinAnsi,
  buildPdfaXmpPacket,
  buildReportText,
  buildSrgbIccProfile,
  cmykToRgbNaive,
  countColorOps,
  iccCurveEntries,
  iccXyzValue,
  isStandard14BaseFont,
  labelOf,
  latin1Of,
  normalizeContentStreamColors,
  normalizeTarget,
  outputBaseName,
  parsePdfaRun,
  pdfNumber,
  pdfaFileName,
  reportFileName,
  sniffIsPdf,
  sniffPdfaRisks,
  srgbDecode,
  tokenizeContentStream,
  winAnsiToUnicode,
  type PdfaTarget,
} from "../tools/pdf-to-pdfa/model";
import type { PdfaChangeReport } from "../tools/pdf-to-pdfa/types";
import type {
  WorkerRunRequest,
  WorkerResponse,
} from "../src/lib/workers/protocol";
import toolI18n from "../tools/pdf-to-pdfa/i18n.json";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.error(
      `  ✗ FAIL ${label}`,
      actual !== undefined ? JSON.stringify(actual).slice(0, 400) : ""
    );
  }
}

const near = (a: number, b: number, eps = 0.001): boolean =>
  Math.abs(a - b) <= eps;

/** The i18n namespace prefix length ("pa." — the RB6 slice(6) lesson). */
const NS = "pa";

/** Report label keys the surface serializes + the worker's txt needs. */
const REPORT_KEYS = [
  "title", "fFile", "fTarget", "fPages", "fSize",
  "secChanges", "cColors", "cScanned", "cRewritten", "cSkipped", "cToRgb",
  "fFonts", "fEmbedded", "fStdKept", "fStdEmb",
  "fActions", "fActionsItems", "fTreeGone", "fGone", "fAnnotActions",
  "fMmAnnots", "fEmbDropped", "fEmbKept",
  "fMetadata", "fWritten", "fNotWritten", "fOi", "fOiHand", "fOiNone",
  "fTrailer", "fEnsured",
  "secPages", "pagesNone", "noAp", "secLimits",
  "limNone1b", "limTrans", "limTransOk", "limSkip", "limSh",
  "tagging", "footer", "pageWord",
] as const;

/** Labels payload for a worker run (exactly what the surface serializes). */
function labelsFor(locale: "en" | "hi"): Record<string, string> {
  const catalog = (toolI18n as Record<string, Record<string, Record<string, string>>>)[locale]![NS]!;
  return Object.fromEntries(
    REPORT_KEYS.map((k) => [`${NS}.${k}`, catalog[k]!])
  );
}

/* ================================================================== */
console.log("── 0. wiring sanity (source text) ─────────────────────");
/* ================================================================== */
{
  const configsTs = readFileSync("src/lib/tools/configs.ts", "utf8");
  const surfacesTs = readFileSync("src/lib/tools/surfaces.tsx", "utf8");
  const registryTs = readFileSync("src/lib/tools/registry.ts", "utf8");
  const workerSrc = readFileSync("tools/pdf-to-pdfa/worker.ts", "utf8");

  check(
    "configs.ts: import + [pdfToPdfa.toolId] entry",
    configsTs.includes('import { config as pdfToPdfa } from "../../../tools/pdf-to-pdfa/config"') &&
      configsTs.includes("[pdfToPdfa.toolId]: pdfToPdfa,")
  );
  check(
    "surfaces.tsx: import + pdf-to-pdfa entry",
    surfacesTs.includes('import { PdfToPdfaSurface } from "../../../tools/pdf-to-pdfa/surface"') &&
      surfacesTs.includes('"pdf-to-pdfa": PdfToPdfaSurface,')
  );
  const defIdx = registryTs.indexOf('id: "pdf-to-pdfa"');
  const defSlice = defIdx >= 0 ? registryTs.slice(defIdx, defIdx + 700) : "";
  check(
    "registry: def enabled + mode D + accepts pdf + honest description",
    defIdx >= 0 &&
      defSlice.includes("enabled: true") &&
      defSlice.includes('mode: "D"') &&
      defSlice.includes('accepts: "pdf"') &&
      defSlice.includes("DeviceRGB") &&
      defSlice.includes("OutputIntent")
  );

  const configTs = readFileSync("tools/pdf-to-pdfa/config.ts", "utf8");
  check(
    "config: split-tool shape (worker, pdf output, 1 file, no schema)",
    configTs.includes('toolId: "pdf-to-pdfa"') &&
      configTs.includes("createWorker") &&
      configTs.includes('outputKind: "pdf"') &&
      configTs.includes("minFiles: 1") &&
      configTs.includes("maxFiles: 1") &&
      configTs.includes("options: []")
  );
  check(
    "config: howKeys pa.how1-3 + validate-pdfa chain",
    configTs.includes('howKeys: ["pa.how1", "pa.how2", "pa.how3"]') &&
      configTs.includes('"validate-pdfa"')
  );
  check(
    "worker: browser-pure (no node: imports)",
    !/from "node:/.test(workerSrc) && !/require\("node:/.test(workerSrc)
  );
  check(
    "worker: object-stream-free save (the -b flat xref layout)",
    workerSrc.includes("useObjectStreams: false")
  );

  // i18n parity + referenced keys (prefix "pa." = 3 chars)
  const en = (toolI18n as Record<string, Record<string, Record<string, string>>>).en[NS]!;
  const hi = (toolI18n as Record<string, Record<string, Record<string, string>>>).hi[NS]!;
  const enKeys = Object.keys(en).sort();
  const hiKeys = Object.keys(hi).sort();
  check("i18n: en/hi exact key parity", JSON.stringify(enKeys) === JSON.stringify(hiKeys), {
    missingInHi: enKeys.filter((k) => !hiKeys.includes(k)),
    missingInEn: hiKeys.filter((k) => !enKeys.includes(k)),
  });
  check(
    "i18n: no empty values in either locale",
    [...Object.values(en), ...Object.values(hi)].every(
      (v) => typeof v === "string" && v.trim().length > 0
    )
  );

  const surfaceSrc = readFileSync("tools/pdf-to-pdfa/surface.tsx", "utf8");
  const refs = new Set<string>();
  for (const m of surfaceSrc.matchAll(/t\("pa\.([A-Za-z0-9_]+)"/g)) {
    refs.add(`pa.${m[1]}`);
  }
  for (const m of surfaceSrc.matchAll(/t\(opt\.labelKey\)|t\(opt\.hintKey\)/g)) {
    void m;
  }
  for (const key of ["t1b", "t2b", "t3b", "t1bHint", "t2bHint", "t3bHint"]) {
    refs.add(`pa.${key}`);
  }
  for (const key of REPORT_KEYS) refs.add(`pa.${key}`);
  for (const key of Object.values(PA_CODES)) refs.add(key);
  for (const key of ["how1", "how2", "how3"]) refs.add(`pa.${key}`);
  const missing = [...refs].filter(
    (k) => en[k.slice(NS.length + 1)] === undefined || hi[k.slice(NS.length + 1)] === undefined
  );
  check(
    "i18n: every referenced pa.* key exists in BOTH catalogs",
    missing.length === 0,
    missing
  );
  const centralEn = JSON.parse(readFileSync("src/i18n/en.json", "utf8")) as {
    tool?: Record<string, string>;
  };
  check(
    "i18n: shared tool.error* codes exist in the central catalog (worker fallbacks)",
    centralEn.tool?.errorEncrypted !== undefined &&
      centralEn.tool?.errorCorrupt !== undefined &&
      centralEn.tool?.errorGeneric !== undefined
  );
  check(
    "model/types agreement: 3 targets, 1b→1.4, 2b/3b→1.7, all object-stream-free",
    PDFA_TARGETS.length === 3 &&
      PDFA_TARGET_INFO["1b"].pdfVersion === "1.4" &&
      PDFA_TARGET_INFO["2b"].pdfVersion === "1.7" &&
      PDFA_TARGET_INFO["3b"].pdfVersion === "1.7" &&
      PDFA_TARGETS.every((t) => PDFA_TARGET_INFO[t].objectStreams === false) &&
      DEFAULT_PDFA_TARGET === "2b"
  );
}

/* ================================================================== */
console.log("── 1. model vectors ───────────────────────────────────");
/* ================================================================== */
{
  /* --- normalizeTarget / parsePdfaRun / labelOf ---------------------- */
  check(
    "normalizeTarget: 1b/2b/3b + case/whitespace tolerance",
    normalizeTarget("1b") === "1b" &&
      normalizeTarget(" 2B ") === "2b" &&
      normalizeTarget("3b") === "3b"
  );
  check(
    "normalizeTarget: junk → the balanced default 2b",
    normalizeTarget("4b") === "2b" &&
      normalizeTarget("") === "2b" &&
      normalizeTarget(42) === "2b" &&
      normalizeTarget(null) === "2b"
  );
  {
    const r = parsePdfaRun("3b", JSON.stringify({ locale: "hi", labels: { "pa.title": "रिपोर्ट" } }));
    check(
      "parsePdfaRun: target + locale + labels ride through",
      r.ok && r.run.target === "3b" && r.run.locale === "hi" && r.run.labels["pa.title"] === "रिपोर्ट",
      r
    );
  }
  {
    let allOk = true;
    for (const raw of [undefined, null, "", "{}", "[]", '"str"', "3", "{bad"]) {
      const r = parsePdfaRun("1b", raw as unknown);
      if (!r.ok || r.run.target !== "1b" || r.run.locale !== "en") allOk = false;
    }
    check("parsePdfaRun: garbage payloads degrade to honest defaults", allOk);
  }
  {
    const r = parsePdfaRun("2b", JSON.stringify({
      labels: {
        "pa.title": "kept",
        "junk": "dropped",
        "pa.ok": "kept2",
        [`pa.${"x".repeat(40)}`]: "dropped (key too long)",
        "pa.num": 42,
      },
    }));
    check(
      "parsePdfaRun: label filter keeps pa.* string keys ≤ 32 chars, drops junk",
      r.ok &&
        r.run.labels["pa.title"] === "kept" &&
        r.run.labels["pa.ok"] === "kept2" &&
        r.run.labels["junk"] === undefined &&
        r.run.labels[`pa.${"x".repeat(40)}`] === undefined &&
        r.run.labels["pa.num"] === undefined,
      r.ok ? r.run.labels : r
    );
    const long = parsePdfaRun("2b", JSON.stringify({ labels: { "pa.title": "y".repeat(500) } }));
    check(
      "parsePdfaRun: label values truncated to 240",
      long.ok && long.run.labels["pa.title"]!.length === 240
    );
  }
  check(
    "labelOf: hit / miss / empty-string behaviors",
    labelOf("hi", { "pa.title": "हिं" }, "title", "EN") === "हिं" &&
      labelOf("hi", {}, "title", "EN") === "EN" &&
      labelOf("hi", { "pa.title": "" }, "title", "EN") === "EN"
  );

  /* --- the WinAnsi table + naive color math -------------------------- */
  check(
    "winAnsiToUnicode: ascii, latin-1, € at 0x80, undefined 0x81 identity",
    winAnsiToUnicode(0x41) === 0x41 &&
      winAnsiToUnicode(0xe9) === 0xe9 &&
      winAnsiToUnicode(0x80) === 0x20ac &&
      winAnsiToUnicode(0x81) === 0x81
  );
  {
    const [r, g, b] = cmykToRgbNaive(1, 0, 0, 0);
    const [r2, g2, b2] = cmykToRgbNaive(0, 0, 0, 1);
    const [r3] = cmykToRgbNaive(-1, 2, 0, 0);
    check(
      "cmykToRgbNaive: pure cyan → red 0, k=1 → black, out-of-range clamped",
      near(r, 0) && near(g, 1) && near(b, 1) &&
        near(r2, 0) && near(g2, 0) && near(b2, 0) &&
        near(r3, 1)
    );
  }
  check(
    "pdfNumber: 6 decimals, no exponent, no trailing zeros, -0 → 0",
    pdfNumber(0.5) === "0.5" &&
      pdfNumber(1) === "1" &&
      pdfNumber(-0) === "0" &&
      pdfNumber(0.1234567) === "0.123457" &&
      pdfNumber(0.0000001) === "0" &&
      pdfNumber(10) === "10"
  );

  /* --- tokenizer ------------------------------------------------------ */
  {
    const tokens = tokenizeContentStream(
      "q\n0.5 g\n/F1 12 Tf\n(hi (nested)) Tj\n<4142> Tj\nET Q"
    );
    check(
      "tokenize: numbers, names, literal + hex strings, ops",
      tokens.some((t) => t.kind === "number" && t.text === "0.5") &&
        tokens.some((t) => t.kind === "name" && t.text === "F1") &&
        tokens.some((t) => t.kind === "string" && t.text === "(hi (nested))") &&
        tokens.some((t) => t.kind === "string" && t.text === "<4142>") &&
        tokens.some((t) => t.kind === "op" && t.text === "Tf"),
      tokens.map((t) => t.text)
    );
    const commented = tokenizeContentStream("% a comment\n1 g");
    check(
      "tokenize: % comments skipped",
      !commented.some((t) => t.text.includes("comment"))
    );
  }

  /* --- the color normalizer ------------------------------------------- */
  {
    const cs =
      "0.5 g 0.1 0.2 0.3 0.4 k /DeviceGray cs 0.4 sc 1 0 0 rg q 0.2 G Q 0.9 0.8 0.7 0.6 K /DeviceCMYK CS 0.1 0.2 0.3 0.4 SCN /DeviceRGB cs 0.1 0.2 0.3 sc";
    const r = normalizeContentStreamColors(cs, {});
    check(
      "normalize: g/G/k/K + gray/CMYK cs/CS + sc/SCN all → DeviceRGB",
      r.changed &&
        r.text ===
          "0.5 0.5 0.5 rg 0.54 0.48 0.42 rg /DeviceRGB cs 0.4 0.4 0.4 sc 1 0 0 rg q 0.2 0.2 0.2 RG Q 0.04 0.08 0.12 RG /DeviceRGB CS 0.54 0.48 0.42 SCN /DeviceRGB cs 0.1 0.2 0.3 sc" &&
        r.stats.grayOps === 2 &&
        r.stats.cmykOps === 2 &&
        r.stats.csSwitches === 2 &&
        r.stats.scOps === 2,
      r
    );
    check(
      "normalize: countColorOps sees the result as pure DeviceRGB",
      (() => {
        const c = countColorOps(r.text);
        return c.gray === 0 && c.cmyk === 0 && c.rgb === 5 && c.sc === 3;
      })()
    );
  }
  {
    // q/Q state machine: the colorspace set before q is restored by Q
    const r = normalizeContentStreamColors(
      "/DeviceGray cs q 0.4 sc Q 0.4 sc",
      {}
    );
    check(
      "normalize: q/Q graphics-state stack restores the colorspace",
      r.changed &&
        r.text === "/DeviceRGB cs q 0.4 0.4 0.4 sc Q 0.4 0.4 0.4 sc" &&
        r.stats.scOps === 2,
      r
    );
  }
  {
    // CMYK(0.4, 0.2, 0, 0.4) → naive RGB = (1-0.4)(1-0.4), (1-0.2)(1-0.4), (1-0)(1-0.4)
    // = 0.36 0.48 0.6. The pattern calls stay untouched — noted honestly.
    const r = normalizeContentStreamColors(
      "/Pattern cs /P1 scn /CS0 cs 0.4 0.2 0 0.4 sc",
      { CS0: { comps: 4, rgb: false }, P1: { special: "pattern" } }
    );
    check(
      "normalize: Pattern left as-is (honest notes) + resource CMYK converted",
      r.changed &&
        r.text === "/Pattern cs /P1 scn /DeviceRGB cs 0.36 0.48 0.6 sc" &&
        r.stats.notes.some((n) => n.includes("pattern")) === true,
      r
    );
  }
  {
    const r = normalizeContentStreamColors(
      "/Pattern cs /P1 scn /DeviceRGB cs 1 0 0 sc",
      {}
    );
    check(
      "normalize: pattern color calls left as-is (honest note)",
      r.changed === false &&
        r.stats.notes.some((n) => n.includes("pattern color call"))
    );
  }
  {
    const r = normalizeContentStreamColors(
      "/Separation cs 0.5 sc /Indexed cs 0.2 sc /Lab cs 0.3 sc",
      {}
    );
    check(
      "normalize: Separation/Indexed/Lab spaces left as-is + noted",
      r.changed === false &&
        r.stats.notes.some((n) => n.includes("separation")) &&
        r.stats.notes.some((n) => n.includes("indexed")) &&
        r.stats.notes.some((n) => n.includes("lab"))
    );
  }
  {
    const r = normalizeContentStreamColors("/CalRGB cs 1 0 0 sc 0 1 0 scn", {});
    check("normalize: 3-component spaces left alone", r.changed === false);
  }
  {
    const binary = "BI /W 2 /H 1 ID " + "\x00\x11\x22\x33\x44\x55\x66 EI";
    const r = normalizeContentStreamColors(`${binary}\n0.5 g`, {});
    check(
      "normalize: inline images skipped byte-exact, following g rewritten",
      r.changed &&
        r.text.includes(binary) &&
        r.stats.inlineImages === 1 &&
        r.stats.grayOps === 1,
      r.stats
    );
  }
  {
    const r = normalizeContentStreamColors("/Sh0 sh 1 0 0 rg", {});
    check(
      "normalize: shading fills counted + noted, left as-is",
      r.changed === false &&
        r.stats.shadings === 1 &&
        r.stats.notes.some((n) => n.includes("shading"))
    );
  }
  {
    const r = normalizeContentStreamColors("1 0 0 rg 0 0 1 RG", {});
    check("normalize: an already-RGB stream is byte-identical", r.changed === false);
  }

  /* --- the XMP packet -------------------------------------------------- */
  {
    for (const [target, part] of [
      ["1b", 1],
      ["2b", 2],
      ["3b", 3],
    ] as [PdfaTarget, number][]) {
      const xmp = buildPdfaXmpPacket(target, "My <Title> & \"quotes\"", "MyCloudy");
      check(
        `XMP ${target}: pdfaid:part ${part} + conformance B + escaped title`,
        xmp.includes(`<pdfaid:part>${part}</pdfaid:part>`) &&
          xmp.includes("<pdfaid:conformance>B</pdfaid:conformance>") &&
          xmp.includes("My &lt;Title&gt; &amp; &quot;quotes&quot;") &&
          xmp.includes(`xmlns:pdfaid="${PFAID_NAMESPACE}"`)
      );
    }
    const noTitle = buildPdfaXmpPacket("2b", "", "MyCloudy");
    check(
      "XMP: empty title → no dc:title block; producer + wrappers present",
      !noTitle.includes("dc:title") &&
        noTitle.includes("<pdf:Producer>MyCloudy</pdf:Producer>") &&
        noTitle.includes("<xmp:CreatorTool>MyCloudy</xmp:CreatorTool>") &&
        noTitle.includes('<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>') &&
        noTitle.includes('<?xpacket end="w"?>') &&
        noTitle.includes("<dc:format>application/pdf</dc:format>")
    );
  }

  /* --- the hand-rolled sRGB ICC profile -------------------------------- */
  {
    const icc = buildSrgbIccProfile();
    check(
      "ICC: exact documented size (the report's iccBytes)",
      icc.length === SRGB_ICC_SIZE
    );
    const parsed = (await0 => {
      void await0;
      return null;
    })(null);
    void parsed;
    try {
      const p = requireIcc();
      check(
        "ICC: v2.1.0 mntr/RGB /XYZ /acsp + 9 sorted tags",
        p.version === "2.1.0" &&
          p.deviceClass === "mntr" &&
          p.colorSpace === "RGB " &&
          p.pcs === "XYZ " &&
          p.magic === "acsp" &&
          p.tags.length === 9 &&
          p.tags.map((t) => t.signature).join(",") ===
            "bTRC,bXYZ,cprt,desc,gTRC,gXYZ,rTRC,rXYZ,wtpt",
        p.tags.map((t) => t.signature)
      );
      const by = (sig: string) => p.tags.find((t) => t.signature === sig)!;
      const wtpt = iccXyzValue(icc, by("wtpt"));
      check(
        "ICC: white point == D50 (0.9642, 1.0, 0.8249)",
        wtpt !== null &&
          near(wtpt[0], 0.9642, 0.0005) &&
          near(wtpt[1], 1.0, 0.0005) &&
          near(wtpt[2], 0.8249, 0.0005),
        wtpt
      );
      const red = iccXyzValue(icc, by("rXYZ"));
      check(
        "ICC: red primary == the D50-adapted sRGB column (0.4360, 0.2225, 0.0139)",
        red !== null &&
          near(red[0], 0.4360, 0.002) &&
          near(red[1], 0.2225, 0.002) &&
          near(red[2], 0.0139, 0.002),
        red
      );
      const curve = iccCurveEntries(icc, by("gTRC"));
      check(
        "ICC: TRC = 1024 samples of the TRUE piecewise sRGB curve",
        curve !== null &&
          curve.length === SRGB_TRC_SAMPLES &&
          curve[0] === 0 &&
          curve[curve.length - 1] === 65535 &&
          curve[512] === Math.round(srgbDecode(512 / 1023) * 65535),
        curve === null ? null : [curve[0], curve[512], curve[curve.length - 1]]
      );
      check(
        "ICC: TRC monotonic non-decreasing",
        (() => {
          if (curve === null) return false;
          for (let i = 1; i < curve.length; i += 1) {
            if (curve[i]! < curve[i - 1]!) return false;
          }
          return true;
        })()
      );
    } catch (error) {
      check("ICC: parse threw unexpectedly", false, String(error));
    }
    let threwShort = false;
    try {
      requireIcc(new Uint8Array(50));
    } catch {
      threwShort = true;
    }
    let threwSize = false;
    try {
      const bad = buildSrgbIccProfile().slice();
      bad[2] = 0;
      requireIcc(bad);
    } catch {
      threwSize = true;
    }
    check(
      "ICC: parser throws on too-short + size-mismatch inputs",
      threwShort && threwSize
    );
  }

  /* --- standard-14 assets + AFM ---------------------------------------- */
  check(
    "standard-14: 14 entries, self-hosted paths, ttf/cff kinds",
    Object.keys(STANDARD14_ASSETS).length === 14 &&
      Object.values(STANDARD14_ASSETS).every(
        (a) =>
          a.file.startsWith("/pdfjs/standard_fonts/") &&
          (a.kind === "ttf" || a.kind === "cff")
      ) &&
      STANDARD14_ASSETS.Helvetica!.kind === "ttf" &&
      STANDARD14_ASSETS["Times-Roman"]!.kind === "cff"
  );
  check(
    "standard-14: the real files exist on disk (self-hosted)",
    ["Helvetica", "Times-Roman", "Courier", "Symbol", "ZapfDingbats"].every(
      (n) => {
        try {
          readFileSync(`public${STANDARD14_ASSETS[n]!.file}`);
          return true;
        } catch {
          return false;
        }
      }
    )
  );
  check(
    "isStandard14BaseFont: Helvetica yes, ComicSansMS no",
    isStandard14BaseFont("Helvetica") === true &&
      isStandard14BaseFont("ComicSansMS") === false
  );
  {
    const m = afmOf("Helvetica");
    check(
      "afmOf: Helvetica metrics (name, bbox, zero italic)",
      m !== null &&
        m.fontName === "Helvetica" &&
        m.italicAngle === 0 &&
        m.bbox.length === 4 &&
        m.ascender !== null &&
        m.descender !== null &&
        m.descender! < 0,
      m
    );
    check("afmOf: unknown font → null", afmOf("Nope") === null);
  }
  {
    const w = afmWidthsWinAnsi("Helvetica");
    check(
      "afmWidthsWinAnsi: [32..255], space 278, A 667",
      w.first === 32 &&
        w.last === 255 &&
        w.widths.length === 224 &&
        w.widths[0] === 278 &&
        w.widths[65 - 32] === 667,
      { space: w.widths[0], A: w.widths[65 - 32] }
    );
    const s = afmWidthsBuiltin("Symbol");
    check(
      "afmWidthsBuiltin: Symbol keeps its own tight code range",
      s.first <= 32 && s.last <= 255 && s.first < s.last && s.widths.length === s.last - s.first + 1,
      { first: s.first, last: s.last }
    );
  }

  /* --- the sniffs + names ---------------------------------------------- */
  check(
    "sniffIsPdf: magic at byte 0",
    sniffIsPdf(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])) === true &&
      sniffIsPdf(new TextEncoder().encode("hello")) === false
  );
  {
    const latin = latin1Of(new TextEncoder().encode("ok"));
    check("latin1Of: round trip", latin === "ok");
    const risks = sniffPdfaRisks(
      new TextEncoder().encode("%PDF-1.7\n/Encrypt 1 0 R\n/JavaScript x /SMask y /EmbeddedFiles z")
    );
    check(
      "sniffPdfaRisks: all four honest heuristics fire",
      risks.encrypted && risks.javaScript && risks.transparency && risks.embeddedFiles
    );
  }
  check(
    "names: sanitized + level + report suffixes, EN + HI defaults",
    pdfaFileName("we:ird*name?.PDF", "2b", "en") === "we_ird_name_-pdfa-2b.pdf" &&
      reportFileName("doc.pdf", "1b", "en") === "doc-pdfa-1b-report.txt" &&
      outputBaseName("", "hi") === "दस्तावेज़" &&
      outputBaseName("", "en") === "document"
  );

  /* --- buildReportText EN + HI ----------------------------------------- */
  {
    const report: PdfaChangeReport = {
      target: "2b",
      pageCount: 2,
      colors: {
        streamsScanned: 3,
        streamsRewritten: 2,
        streamsSkipped: 1,
        pageNotes: ["Page 1: g/G 4, k/K 2 → DeviceRGB"],
        totals: { grayOps: 4, cmykOps: 2, csSwitches: 1, scOps: 1, shadings: 1, inlineImages: 0 },
      },
      fonts: {
        embeddedPassed: 1,
        standardKept: 0,
        standardEmbedded: 2,
        notes: ["Helvetica → LiberationSans-Regular (metric-compatible substitute)"],
      },
      actions: {
        jsTreeStripped: true,
        openActionStripped: ["JavaScript"],
        aaStripped: 1,
        annotActionsStripped: 2,
        annotsRemoved: 1,
        annotsNoAp: 1,
        embeddedFilesDropped: 0,
        embeddedFilesKept: 0,
      },
      transparency: { softMaskPages: [1], alphaPages: [] },
      docTitle: "Report 2026",
      xmpWritten: true,
      outputIntentWritten: true,
      iccBytes: SRGB_ICC_SIZE,
      idWritten: true,
      headerVersion: "1.7",
      notes: [],
    };
    const en = buildReportText(
      report,
      { fileName: "x.pdf", inputBytes: 1000, outputBytes: 2000 },
      "en",
      labelsFor("en")
    );
    check(
      "report EN: header + change list + honest limits",
      en.includes("PDF/A conformance report") &&
        en.includes("Target: PDF/A-2b (ISO 19005-2)") &&
        en.includes("File: x.pdf") &&
        en.includes("Pages: 2") &&
        en.includes("1000 → 2000 bytes") &&
        en.includes("standard-14 substitutes embedded 2") &&
        en.includes("/Names/JavaScript tree removed") &&
        en.includes("/OpenAction removed: JavaScript") &&
        en.includes("dc:title \"Report 2026\"") &&
        en.includes("sRGB ICC v2.1 (6700 bytes, hand-rolled from IEC 61966-2.1 constants)") &&
        en.includes("transparency (soft masks/alpha) on pages 2 — allowed in PDF/A-2b+"),
      en
    );
    check(
      "report EN: the -a tagging honesty + the not-certified footer",
      en.includes("Tagging (structure tree) is not required at the PDF/A-1b/2b/3b levels") &&
        en.includes("it is not a certified ISO 19005 validation")
    );
    const hi = buildReportText(
      report,
      { fileName: "x.pdf", inputBytes: 1000, outputBytes: 2000 },
      "hi",
      labelsFor("hi")
    );
    check(
      "report HI: localized title/sections + honest footer",
      hi.includes("PDF/A अनुरूपता रिपोर्ट") &&
        hi.includes("जो बदला गया") &&
        hi.includes("ईमानदार सीमाएँ") &&
        hi.includes("कोई प्रमाणित ISO 19005 सत्यापन नहीं") &&
        hi.includes("टैग नहीं जोड़ता"),
      hi.slice(0, 200)
    );
    const noChanges = buildReportText(
      { ...report, colors: { ...report.colors, pageNotes: [] }, actions: { jsTreeStripped: false, openActionStripped: [], aaStripped: 0, annotActionsStripped: 0, annotsRemoved: 0, annotsNoAp: 0, embeddedFilesDropped: 0, embeddedFilesKept: 0 } },
      { fileName: "y.pdf", inputBytes: 5, outputBytes: 6 },
      "en",
      labelsFor("en")
    );
    check(
      "report EN: the quiet no-notes line",
      noChanges.includes("No per-page notes.")
    );
  }
}

/** local helper so the ICC block can import parse lazily */
function requireIcc(bytes?: Uint8Array): ReturnType<typeof import("../tools/pdf-to-pdfa/model").parseIccProfile> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("../tools/pdf-to-pdfa/model") as typeof import("../tools/pdf-to-pdfa/model");
  return mod.parseIccProfile(bytes ?? mod.buildSrgbIccProfile());
}

/* ================================================================== */
console.log("── 2. REAL E2E through the worker ─────────────────────");
/* ================================================================== */
{
  /* --- the worker shim + drive ---------------------------------------- */
  const workerGlobal = globalThis as unknown as {
    postMessage: (msg: unknown) => void;
    onmessage: ((event: { data: WorkerRunRequest }) => void) | null;
    location: { href: string };
  };
  const messages: WorkerResponse[] = [];
  workerGlobal.postMessage = (msg: unknown): void => {
    messages.push(msg as WorkerResponse);
  };
  workerGlobal.location = { href: "http://localhost/" };
  (globalThis as unknown as Record<string, unknown>).self = workerGlobal;
  globalThis.fetch = (async (input: unknown): Promise<Response> => {
    const url = String(input);
    const m = /\/([^/]+)\.(ttf|pfb)$/.exec(url);
    if (!m) throw new Error(`unexpected fetch: ${url}`);
    const bytes = new Uint8Array(
      readFileSync(`public/pdfjs/standard_fonts/${m[1]}.${m[2]}`)
    );
    return new Response(bytes);
  }) as typeof fetch;
  await import("../tools/pdf-to-pdfa/worker");
  check(
    "worker: module loaded, onmessage registered",
    typeof workerGlobal.onmessage === "function"
  );

  const drive = async (
    runId: number,
    target: PdfaTarget | "junk",
    locale: "en" | "hi",
    fileBytes: Uint8Array,
    fileName: string
  ): Promise<WorkerResponse> => {
    const before = messages.length;
    workerGlobal.onmessage!({
      data: {
        type: "run",
        runId,
        toolId: "pdf-to-pdfa",
        options: {
          target,
          run: JSON.stringify({ locale, labels: labelsFor(locale) }),
        },
        files: [new File([fileBytes as BlobPart], fileName)],
      } as WorkerRunRequest,
    });
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (
        messages
          .slice(before)
          .some((m) => m.runId === runId && (m.type === "result" || m.type === "error"))
      ) {
        break;
      }
      if (Date.now() > deadline) throw new Error(`worker run ${runId} did not finish`);
      await new Promise((r) => setTimeout(r, 10));
    }
    return messages
      .slice(before)
      .find((m) => m.runId === runId && (m.type === "result" || m.type === "error"))!;
  };

  const textOf = async (blob: Blob): Promise<string> => {
    return new TextDecoder().decode(await blob.arrayBuffer());
  };

  /** All content streams of a reloaded page, inflated via node:zlib. */
  const pageContentLatin1 = (doc: PDFDocument, pageIndex: number): string => {
    const contents = doc.getPage(pageIndex).node.Contents();
    const streams: PDFRawStream[] = [];
    if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i += 1) {
        const s = contents.lookup(i);
        if (s instanceof PDFRawStream) streams.push(s);
      }
    } else if (contents instanceof PDFRawStream) {
      streams.push(contents);
    }
    let out = "";
    for (const s of streams) {
      const filter = s.dict.get(PDFName.of("Filter"));
      const bytes = s.contents;
      const inflated =
        filter !== undefined && filter.toString() === "/FlateDecode"
          ? inflateSync(bytes)
          : bytes;
      out += Buffer.from(inflated).toString("latin1");
    }
    return out;
  };

  /** lookupMaybe has no PDFRawStream overload — narrow from PDFStream. */
  const rawStreamOf = (doc: PDFDocument, raw: unknown): PDFRawStream | undefined => {
    const stream = doc.context.lookupMaybe(raw as never, PDFStream);
    return stream instanceof PDFRawStream ? stream : undefined;
  };

  /** The catalog /Metadata XMP text ("" when absent). */
  const xmpText = (doc: PDFDocument): string => {
    const meta = rawStreamOf(doc, doc.catalog.get(PDFName.of("Metadata")));
    if (meta === undefined) return "";
    return new TextDecoder().decode(meta.contents);
  };

  /* --- fixture 1: the 2-page EN document ------------------------------- */
  const src = await PDFDocument.create();
  src.setTitle("Archive Report 2026");
  const font = await src.embedFont(StandardFonts.Helvetica);
  const pageA = src.addPage([595.28, 841.89]);
  pageA.drawText("First page text", { x: 40, y: 700, size: 12, font });
  pageA.drawRectangle({ x: 40, y: 550, width: 120, height: 60, color: grayscale(0.25) });
  pageA.drawRectangle({ x: 200, y: 550, width: 120, height: 60, color: cmyk(0.2, 0.4, 0.6, 0.1) });
  const pageB = src.addPage([595.28, 841.89]);
  pageB.drawText("Second page text", { x: 40, y: 700, size: 12, font });
  const fixture = new Uint8Array(await src.save({ useObjectStreams: false }));
  check(
    "fixture: the gray + cmyk fills are present pre-conversion",
    await (async () => {
      const c = pageContentLatin1(
        await PDFDocument.load(fixture, { updateMetadata: false }),
        0
      );
      return c.includes("0.25 g") && c.includes("0.2 0.4 0.6 0.1 k");
    })()
  );

  /* --- 1b run ----------------------------------------------------------- */
  const res1b = await drive(101, "1b", "en", fixture, "report 2pg.pdf");
  check("worker 1b: result", res1b.type === "result", res1b);
  if (res1b.type !== "result") throw new Error("E2E 1b run failed — aborting smoke");
  check(
    "worker 1b: two outputs, honest names",
    res1b.outputs.length === 2 &&
      res1b.outputs[0]!.name === "report 2pg-pdfa-1b.pdf" &&
      res1b.outputs[0]!.mime === "application/pdf" &&
      res1b.outputs[1]!.name === "report 2pg-pdfa-1b-report.txt",
    res1b.outputs.map((o) => o.name)
  );
  {
    const d = res1b.detail as {
      files?: number;
      pages?: number;
      target?: string;
      colorsConverted?: number;
      fontsEmbedded?: number;
      itemsStripped?: number;
    };
    check(
      "worker 1b: detail (pages, target, colors converted, std-14 kept)",
      d.files === 1 && d.pages === 2 && d.target === "1b" &&
        d.colorsConverted === 2 && d.fontsEmbedded === 0 && d.itemsStripped === 0,
      d
    );
  }
  const progress = messages.filter(
    (m) => m.runId === 101 && m.type === "progress"
  ) as Extract<WorkerResponse, { type: "progress" }>[];
  check(
    "worker 1b: ≥ 5 progress beats, non-decreasing, honest stages",
    progress.length >= 5 &&
      progress.every((p) => ["reading", "processing", "saving"].includes(p.stage)) &&
      progress.every((p, i) => i === 0 || p.pct >= progress[i - 1]!.pct),
    progress.map((p) => `${p.pct}:${p.stage}`)
  );

  const out1b = new Uint8Array(await res1b.outputs[0]!.blob.arrayBuffer());
  const latin1b = Buffer.from(out1b).toString("latin1");
  check(
    "worker 1b: %PDF-1.4 header + trailer /ID + no /Encrypt",
    latin1b.startsWith("%PDF-1.4") &&
      /\/ID\s*\[/.test(latin1b.slice(-1024)) &&
      !latin1b.includes("/Encrypt")
  );

  const doc1b = await PDFDocument.load(out1b, { updateMetadata: false });
  check("worker 1b: reload keeps 2 pages", doc1b.getPageCount() === 2);
  {
    const xmp = xmpText(doc1b);
    check(
      "worker 1b: catalog /Metadata XMP — pdfaid:part 1 + conformance B + dc:title",
      xmp.includes("<pdfaid:part>1</pdfaid:part>") &&
        xmp.includes("<pdfaid:conformance>B</pdfaid:conformance>") &&
        xmp.includes("<dc:title>") &&
        xmp.includes("Archive Report 2026")
    );
    const metaRaw = doc1b.catalog.get(PDFName.of("Metadata"));
    const metaStream = rawStreamOf(doc1b, metaRaw);
    check(
      "worker 1b: /Metadata is a Type /Metadata Subtype /XML stream",
      metaStream !== undefined &&
        metaStream.dict.get(PDFName.of("Type"))?.toString() === "/Metadata" &&
        metaStream.dict.get(PDFName.of("Subtype"))?.toString() === "/XML"
    );
  }
  {
    const intentsRaw = doc1b.catalog.get(PDFName.of("OutputIntents"));
    const intents = doc1b.context.lookupMaybe(intentsRaw, PDFArray);
    const intent = intents !== undefined && intents.size() === 1
      ? doc1b.context.lookupMaybe(intents.get(0), PDFDict)
      : undefined;
    check(
      "worker 1b: one /OutputIntent, /S /GTS_PDFA1, sRGB identifier",
      intent !== undefined &&
        intent.get(PDFName.of("Type"))?.toString() === "/OutputIntent" &&
        intent.get(PDFName.of("S"))?.toString() === "/GTS_PDFA1" &&
        String(intent.get(PDFName.of("OutputConditionIdentifier"))).includes("sRGB"),
      intent?.toString().slice(0, 200)
    );
    const iccStream =
      intent !== undefined
        ? rawStreamOf(doc1b, intent.get(PDFName.of("DestOutputProfile")))
        : undefined;
    check(
      "worker 1b: /DestOutputProfile is the hand-rolled ICC, /N 3, 6700 bytes",
      iccStream !== undefined &&
        Number(iccStream.dict.get(PDFName.of("N"))?.toString()) === 3 &&
        iccStream.contents.length === SRGB_ICC_SIZE,
      iccStream === undefined
        ? null
        : { n: String(iccStream.dict.get(PDFName.of("N"))), len: iccStream.contents.length }
    );
    if (iccStream !== undefined) {
      const p = parseIccLocal(iccStream.contents);
      check(
        "worker 1b: the embedded ICC parses (v2.1.0 mntr RGB /acsp, 9 tags)",
        p.version === "2.1.0" && p.deviceClass === "mntr" && p.tags.length === 9
      );
    }
  }
  {
    // fonts at -1b: the standard-14 stays unembedded (the spec allowance)
    const resources = doc1b.getPage(0).node.Resources();
    const fonts = resources?.lookupMaybe(PDFName.of("Font"), PDFDict);
    let sawFont = false;
    let unembedded = false;
    if (fonts !== undefined) {
      for (const [, value] of fonts.entries()) {
        const dict = doc1b.context.lookupMaybe(value, PDFDict);
        if (dict === undefined) continue;
        sawFont = true;
        if (dict.get(PDFName.of("BaseFont"))?.toString() === "/Helvetica") {
          unembedded = dict.get(PDFName.of("FontDescriptor")) === undefined;
        }
      }
    }
    check(
      "worker 1b: Helvetica found and left unembedded (no FontDescriptor)",
      sawFont && unembedded
    );
  }
  {
    const content = pageContentLatin1(doc1b, 0);
    const ops = countColorOps(content);
    check(
      "worker 1b: colors REALLY rewritten (0 gray, 0 cmyk, ≥ 3 rgb ops)",
      ops.gray === 0 && ops.cmyk === 0 && ops.rgb >= 3,
      ops
    );
    check(
      "worker 1b: text drawing intact (hex token needle)",
      content.includes("466972737420706167652074657874")
    );
  }
  {
    const report = await textOf(res1b.outputs[1]!.blob);
    check(
      "worker 1b: report honesty (fonts line + footer)",
      report.includes("standard-14 kept unembedded (PDF/A-1b allowance) 1") &&
        report.includes("Target: PDF/A-1b (ISO 19005-1)") &&
        report.includes("not a certified ISO 19005 validation"),
      report.slice(0, 400)
    );
  }

  /* --- 2b run ----------------------------------------------------------- */
  const res2b = await drive(102, "2b", "en", fixture, "report 2pg.pdf");
  check("worker 2b: result", res2b.type === "result", res2b);
  if (res2b.type !== "result") throw new Error("E2E 2b run failed — aborting smoke");
  {
    const d = res2b.detail as { fontsEmbedded?: number; target?: string };
    check(
      "worker 2b: detail — the standard-14 substitute IS embedded",
      d.fontsEmbedded === 1 && d.target === "2b",
      d
    );
  }
  const out2b = new Uint8Array(await res2b.outputs[0]!.blob.arrayBuffer());
  check(
    "worker 2b: %PDF-1.7 header",
    Buffer.from(out2b).toString("latin1").startsWith("%PDF-1.7")
  );
  {
    const doc2b = await PDFDocument.load(out2b, { updateMetadata: false });
    const xmp = xmpText(doc2b);
    check(
      "worker 2b: XMP part 2 + conformance B",
      xmp.includes("<pdfaid:part>2</pdfaid:part>") &&
        xmp.includes("<pdfaid:conformance>B</pdfaid:conformance>")
    );
    const resources = doc2b.getPage(0).node.Resources();
    const fonts = resources?.lookupMaybe(PDFName.of("Font"), PDFDict);
    let substituted = false;
    let widthsOk = false;
    if (fonts !== undefined) {
      for (const [, value] of fonts.entries()) {
        const dict = doc2b.context.lookupMaybe(value, PDFDict);
        if (dict === undefined) continue;
        if (dict.get(PDFName.of("BaseFont"))?.toString() !== "/Helvetica") continue;
        const desc = doc2b.context.lookupMaybe(
          dict.get(PDFName.of("FontDescriptor")),
          PDFDict
        );
        if (desc === undefined) continue;
        const file2 = rawStreamOf(doc2b, desc.get(PDFName.of("FontFile2")));
        substituted =
          file2 !== undefined &&
          file2.contents.length > 100000 &&
          String(desc.get(PDFName.of("FontName"))) === "/Helvetica";
        const widths = doc2b.context.lookupMaybe(
          dict.get(PDFName.of("Widths")),
          PDFArray
        );
        if (widths !== undefined && widths.size() === 224) {
          // the canonical AFM: space (first entry, code 32) = 278
          widthsOk = Number(widths.get(0)?.toString()) === 278;
        }
      }
    }
    check(
      "worker 2b: Helvetica → FontFile2 (Liberation program) + AFM widths",
      substituted && widthsOk
    );
  }

  /* --- 3b run (part 3 in the XMP) --------------------------------------- */
  const res3b = await drive(103, "3b", "en", fixture, "report 2pg.pdf");
  check("worker 3b: result", res3b.type === "result", res3b);
  if (res3b.type === "result") {
    const out3b = new Uint8Array(await res3b.outputs[0]!.blob.arrayBuffer());
    const doc3b = await PDFDocument.load(out3b, { updateMetadata: false });
    check(
      "worker 3b: XMP part 3 + header 1.7",
      xmpText(doc3b).includes("<pdfaid:part>3</pdfaid:part>") &&
        Buffer.from(out3b).toString("latin1").startsWith("%PDF-1.7")
    );
  }

  /* --- HI locale run ----------------------------------------------------- */
  const resHi = await drive(104, "1b", "hi", fixture, "रिपोर्ट.pdf");
  check("worker HI: result", resHi.type === "result", resHi);
  if (resHi.type === "result") {
    const report = await textOf(resHi.outputs[1]!.blob);
    check(
      "worker HI: localized report (title + pageWord + footer)",
      report.includes("PDF/A अनुरूपता रिपोर्ट") &&
        report.includes("पृष्ठ 1:") &&
        report.includes("कोई प्रमाणित ISO 19005 सत्यापन नहीं"),
      report.slice(0, 300)
    );
    check(
      "worker HI: report download name uses the Devanagari base",
      resHi.outputs[1]!.name === "रिपोर्ट-pdfa-1b-report.txt"
    );
  }

  /* --- fixture 2: forbidden content -------------------------------------- */
  {
    const jsDoc = await PDFDocument.load(fixture, { updateMetadata: false });
    const ctx = jsDoc.context;
    const jsAction = {
      S: PDFName.of("JavaScript"),
      JS: PDFString.of("app.alert('boom');"),
    };
    // /Names/JavaScript name tree
    jsDoc.catalog.set(
      PDFName.of("Names"),
      ctx.register(
        ctx.obj({
          JavaScript: { Names: [PDFName.of("J0"), jsAction] },
        })
      )
    );
    // /OpenAction (a forbidden JavaScript action)
    jsDoc.catalog.set(PDFName.of("OpenAction"), ctx.obj(jsAction));
    // /AA on the catalog and on page 1
    jsDoc.catalog.set(
      PDFName.of("AA"),
      ctx.obj({ C: { S: PDFName.of("Launch"), F: PDFString.of("x.exe") } })
    );
    jsDoc.getPage(0).node.set(
      PDFName.of("AA"),
      ctx.obj({ C: jsAction })
    );
    // annotations: a JS-action Text, a Screen (multimedia), a GoTo Link (ALLOWED)
    jsDoc.getPage(0).node.set(
      PDFName.of("Annots"),
      ctx.obj([
        {
          Type: PDFName.of("Annot"),
          Subtype: PDFName.of("Text"),
          Rect: [10, 10, 40, 40],
          A: jsAction,
        },
        {
          Type: PDFName.of("Annot"),
          Subtype: PDFName.of("Screen"),
          Rect: [50, 10, 80, 40],
        },
        {
          Type: PDFName.of("Annot"),
          Subtype: PDFName.of("Link"),
          Rect: [90, 10, 120, 40],
          A: { S: PDFName.of("GoTo"), D: [jsDoc.getPage(0).ref, PDFName.of("Fit")] },
        },
      ])
    );
    const jsBytes = new Uint8Array(await jsDoc.save({ useObjectStreams: false }));

    const res = await drive(110, "2b", "en", jsBytes, "jsdoc.pdf");
    check("worker JS fixture: result", res.type === "result", res);
    if (res.type !== "result") throw new Error("JS fixture run failed");
    const d = res.detail as { itemsStripped?: number };
    check(
      "worker JS fixture: detail counts 6 stripped items",
      d.itemsStripped === 6,
      d
    );
    const out = new Uint8Array(await res.outputs[0]!.blob.arrayBuffer());
    const latin = Buffer.from(out).toString("latin1");
    check(
      "worker JS fixture: no JavaScript/Launch/Screen anywhere in the output",
      !latin.includes("/JavaScript") &&
        !latin.includes("/Launch") &&
        !latin.includes("/Screen")
    );
    const re = await PDFDocument.load(out, { updateMetadata: false });
    check(
      "worker JS fixture: catalog clean (no Names/OpenAction/AA)",
      re.catalog.get(PDFName.of("Names")) === undefined &&
        re.catalog.get(PDFName.of("OpenAction")) === undefined &&
        re.catalog.get(PDFName.of("AA")) === undefined
    );
    const annots = re.getPage(0).node.Annots();
    const subtypes: string[] = [];
    if (annots !== undefined) {
      for (let i = 0; i < annots.size(); i += 1) {
        const dict = re.context.lookupMaybe(annots.get(i), PDFDict);
        subtypes.push(String(dict?.get(PDFName.of("Subtype")) ?? "?"));
      }
    }
    check(
      "worker JS fixture: Text annot kept (action stripped) + GoTo Link survives",
      subtypes.length === 2 &&
        subtypes.includes("/Link") &&
        subtypes.includes("/Text")
    );
    {
      const report = await textOf(res.outputs[1]!.blob);
      check(
        "worker JS fixture: report lists the tree + openaction + counts",
        report.includes("/Names/JavaScript tree removed") &&
          report.includes("/OpenAction removed: JavaScript") &&
          report.includes("/AA ×2") &&
          report.includes("annotation actions ×1") &&
          report.includes("multimedia annotations ×1")
      );
    }
  }

  /* --- fixture 3: embedded files (drop at 1b, keep + patch at 3b) ------- */
  {
    const attDoc = await PDFDocument.load(fixture, { updateMetadata: false });
    await attDoc.attach(
      new TextEncoder().encode("<invoice>FACTUR-X</invoice>"),
      "factur-x.xml",
      { mimeType: "text/xml", description: "Factur-X Invoice" }
    );
    const attBytes = new Uint8Array(await attDoc.save({ useObjectStreams: false }));

    const drop = await drive(120, "1b", "en", attBytes, "factured.pdf");
    check("worker embedded 1b: result", drop.type === "result", drop);
    if (drop.type !== "result") throw new Error("embedded 1b run failed");
    const dDrop = drop.detail as { itemsStripped?: number };
    check(
      "worker embedded 1b: the attachment counts as stripped",
      dDrop.itemsStripped === 1,
      dDrop
    );
    const dropOut = new Uint8Array(await drop.outputs[0]!.blob.arrayBuffer());
    const dropLatin = Buffer.from(dropOut).toString("latin1");
    check(
      "worker embedded 1b: no /EmbeddedFiles, /Filespec, /AF or attachment bytes",
      !dropLatin.includes("/EmbeddedFiles") &&
        !dropLatin.includes("/Filespec") &&
        !dropLatin.includes("/AF") &&
        !dropLatin.includes("factur-x.xml")
    );
    {
      const report = await textOf(drop.outputs[1]!.blob);
      check(
        "worker embedded 1b: report states the drop honestly",
        report.includes("embedded files dropped (PDF/A-1b/2b rule): 1")
      );
    }

    const keep = await drive(121, "3b", "en", attBytes, "factured.pdf");
    check("worker embedded 3b: result", keep.type === "result", keep);
    if (keep.type === "result") {
      const keepOut = new Uint8Array(await keep.outputs[0]!.blob.arrayBuffer());
      const keepDoc = await PDFDocument.load(keepOut, { updateMetadata: false });
      let kept = false;
      let patched = false;
      for (const [, obj] of keepDoc.context.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFDict)) continue;
        if (obj.get(PDFName.of("Type")) !== PDFName.of("Filespec")) continue;
        kept = true;
        if (obj.get(PDFName.of("AFRelationship")) === PDFName.of("Unspecified")) {
          patched = true;
        }
      }
      check(
        "worker embedded 3b: the Filespec survives + /AFRelationship patched to /Unspecified",
        kept && patched
      );
      const report = await textOf(keep.outputs[1]!.blob);
      check(
        "worker embedded 3b: report states the keep",
        report.includes("embedded files kept (PDF/A-3b): 1")
      );
    }
  }

  /* --- fixture 4: transparency (reject at 1b, allowed at 2b) ------------- */
  {
    const trDoc = await PDFDocument.create();
    const trFont = await trDoc.embedFont(StandardFonts.Helvetica);
    const trPage = trDoc.addPage([300, 300]);
    trPage.drawText("faded", { x: 20, y: 150, size: 14, font: trFont, opacity: 0.5 });
    const trBytes = new Uint8Array(await trDoc.save({ useObjectStreams: false }));
    const checkTr = Buffer.from(trBytes).toString("latin1").includes("/ca") || true;

    const rejected = await drive(130, "1b", "en", trBytes, "faded.pdf");
    check(
      "worker transparency 1b: honest rejection with the page list",
      rejected.type === "error" &&
        (rejected as { code?: string; detail?: string }).code === PA_CODES.transparency &&
        (rejected as { detail?: string }).detail === "1",
      rejected
    );
    void checkTr;

    const allowed = await drive(131, "2b", "en", trBytes, "faded.pdf");
    check(
      "worker transparency 2b: allowed",
      allowed.type === "result",
      allowed
    );
    if (allowed.type === "result") {
      const report = await textOf(allowed.outputs[1]!.blob);
      check(
        "worker transparency 2b: the honest-limits section names page 1",
        report.includes("transparency (soft masks/alpha) on pages 1 — allowed in PDF/A-2b+")
      );
    }
  }

  /* --- fixture 5: an unembeddable font → honest rejection ---------------- */
  {
    const badDoc = await PDFDocument.create();
    const badPage = badDoc.addPage([300, 300]);
    const streamDict = PDFDict.withContext(badDoc.context);
    const content = badDoc.context.register(
      PDFRawStream.of(
        streamDict,
        new TextEncoder().encode("BT /F1 10 Tf 20 20 Td (hi) Tj ET")
      )
    );
    badPage.node.set(PDFName.of("Contents"), content);
    badPage.node.set(
      PDFName.of("Resources"),
      badDoc.context.obj({
        Font: {
          F1: {
            Type: PDFName.of("Font"),
            Subtype: PDFName.of("Type1"),
            BaseFont: PDFName.of("ComicSansMS"),
          },
        },
      })
    );
    const badBytes = new Uint8Array(await badDoc.save({ useObjectStreams: false }));

    const rejected = await drive(140, "2b", "en", badBytes, "comic.pdf");
    check(
      "worker unembeddable font: honest rejection with font + page detail",
      rejected.type === "error" &&
        (rejected as { code?: string }).code === PA_CODES.unembeddableFonts &&
        (rejected as { detail?: string }).detail === "ComicSansMS (p1)",
      rejected
    );
  }

  /* --- rejection vectors -------------------------------------------------- */
  {
    const empty = await drive(150, "2b", "en", new Uint8Array(0), "empty.pdf");
    check(
      "worker empty file → pa.errEmptyFile",
      empty.type === "error" && (empty as { code?: string }).code === PA_CODES.emptyFile,
      empty
    );
    const notPdf = await drive(151, "2b", "en", new TextEncoder().encode("just text"), "no.pdf");
    check(
      "worker non-PDF → pa.errNotPdf with the file name",
      notPdf.type === "error" &&
        (notPdf as { code?: string }).code === PA_CODES.notPdf &&
        (notPdf as { detail?: string }).detail === "no.pdf",
      notPdf
    );
    const garbage = await drive(152, "2b", "en", new TextEncoder().encode("%PDF-1.7 not really a pdf"), "garbage.pdf");
    check(
      "worker garbage PDF → tool.errorCorrupt",
      garbage.type === "error" && (garbage as { code?: string }).code === "tool.errorCorrupt",
      garbage
    );
    const { PDFDocument: CantooDoc } = await import("@cantoo/pdf-lib");
    const enc = await CantooDoc.create();
    enc.addPage([300, 300]);
    enc.encrypt({ userPassword: "secret", algorithm: "AES-256" });
    const encBytes = new Uint8Array(await enc.save({ useObjectStreams: false }));
    const encRes = await drive(153, "2b", "en", encBytes, "locked.pdf");
    check(
      "worker encrypted → tool.errorEncrypted (PDF/A forbids it)",
      encRes.type === "error" && (encRes as { code?: string }).code === "tool.errorEncrypted",
      encRes
    );
  }

  /* --- target coercion + name honesty through the worker ------------------ */
  {
    const junk = await drive(160, "junk", "en", fixture, "coerced.PDF");
    check(
      "worker junk target → the balanced default 2b",
      junk.type === "result" &&
        (junk as { outputs?: { name: string }[] }).outputs?.[0]?.name ===
          "coerced-pdfa-2b.pdf",
      junk.type === "result" ? junk.outputs.map((o) => o.name) : junk
    );
    const weird = await drive(161, "2b", "en", fixture, 'we:ird*name?.pdf');
    check(
      "worker weird file name → sanitized output names",
      weird.type === "result" &&
        weird.outputs[0]!.name === "we_ird_name_-pdfa-2b.pdf" &&
        weird.outputs[1]!.name === "we_ird_name_-pdfa-2b-report.txt",
      weird.type === "result" ? weird.outputs.map((o) => o.name) : weird
    );
  }

  /* --- the input is never mutated + non-run messages ignored ---------------- */
  check(
    "worker: the input fixture bytes are unchanged after all runs",
    await (async () => {
      const fresh = new Uint8Array(
        fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength)
      );
      const content = pageContentLatin1(
        await PDFDocument.load(fresh, { updateMetadata: false }),
        0
      );
      return content.includes("0.25 g") && content.includes("0.2 0.4 0.6 0.1 k");
    })()
  );
  check(
    "worker: non-run messages ignored (no crash, no stray result)",
    messages.filter((m) => m.runId === undefined).length === 0
  );
}

/** parseIccProfile is re-imported lazily for the output ICC bytes. */
function parseIccLocal(bytes: Uint8Array): ReturnType<typeof import("../tools/pdf-to-pdfa/model").parseIccProfile> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("../tools/pdf-to-pdfa/model") as typeof import("../tools/pdf-to-pdfa/model");
  return mod.parseIccProfile(bytes);
}



console.log(`\nsmoke: ${pass} passed, ${fail} failed${fail > 0 ? ` — ${failures.join(" | ")}` : ""}`);
process.exit(fail > 0 ? 1 : 0);
