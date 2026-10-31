/**
 * Smoke: R50 tool batch (bates-numbering / add-stamps / background-color /
 * remove-blank-pages / alternate-merge / add-page-labels) — the REAL
 * workers through a self-shimmed globalThis (postMessage capture +
 * onmessage dispatch, the smoke-split convention). pdf-lib is the DEV
 * ORACLE only (fixtures + output verification); the tools run 100% on
 * our own engine.
 *
 *  0. Wiring sanity: registry entries + configs + seo + i18n present.
 *  1. bates-numbering: prefix/padding/start stamps (hex Tj scan);
 *     page-range subset; Devanagari refusal.
 *  2. add-stamps: APPROVED hex scan; empty custom refusal.
 *  3. background-color: yellow fill ops behind; bad-hex refusal.
 *  4. remove-blank-pages: blank/text mix → 3 kept; q/Q-only page =
 *     blank; no-blank refusal; all-blank refusal.
 *  5. alternate-merge: interleave order via unique widths; append vs
 *     blank-pad tails; lead=second.
 *  6. add-page-labels: catalog /PageLabels Nums (S/St/P) via pdf-lib.
 *
 * Run: bun scripts/smoke-r50-tools.ts
 */
import { readFileSync } from "node:fs";

import {
  PDFDocument,
  PDFName,
  StandardFonts,
  rgb,
  pushGraphicsState,
  popGraphicsState,
} from "pdf-lib";

import type {
  WorkerRunRequest,
  WorkerResponse,
} from "../src/lib/workers/protocol";

type RunEnd = Extract<WorkerResponse, { type: "result" | "error" }>;

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
      actual !== undefined ? JSON.stringify(actual).slice(0, 300) : ""
    );
  }
}

function near(a: number, b: number, eps = 0.5): boolean {
  return Math.abs(a - b) < eps;
}

/* ── Fixtures ── */

/** 5 pages, unique width 100×(i+1), height 200, every page has text. */
async function buildTextFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 5; i += 1) {
    const page = doc.addPage([100 * (i + 1), 200]);
    page.drawText(`PAGE ${i + 1}`, {
      x: 20,
      y: 100,
      size: 24,
      font,
      color: rgb(0.1, 0.1, 0.4),
    });
  }
  return doc.save({ useObjectStreams: false });
}

/** 5 pages: text, blank, text, q/Q-only (state, no marks), text. */
async function buildBlankMixFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 5; i += 1) {
    const page = doc.addPage([100 * (i + 1), 200]);
    if (i === 1 || i === 3) {
      if (i === 3) {
        // "q Q" only — graphics state, zero marks: must count as blank.
        page.pushOperators(pushGraphicsState(), popGraphicsState());
      }
      continue;
    }
    page.drawText(`PAGE ${i + 1}`, {
      x: 20,
      y: 100,
      size: 24,
      font,
      color: rgb(0, 0, 0),
    });
  }
  return doc.save({ useObjectStreams: false });
}

/** All-blank: 3 pages, no marks anywhere. */
async function buildAllBlankFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i += 1) {
    doc.addPage([300, 400]);
  }
  return doc.save({ useObjectStreams: false });
}

/** A: 3 pages widths 100/300/500. B: 3 pages widths 220/240/260. */
async function buildTwoFixtures(): Promise<[Uint8Array, Uint8Array]> {
  const make = async (widths: number[]): Promise<Uint8Array> => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const w of widths) {
      const page = doc.addPage([w, 200]);
      page.drawText("X", { x: 10, y: 10, size: 12, font });
    }
    return doc.save({ useObjectStreams: false });
  };
  return [await make([100, 300, 500]), await make([220, 240, 260])];
}

/* ── Verification helpers ── */

async function pageWidths(bytes: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(bytes.slice());
  return doc.getPages().map((p) => p.getSize().width);
}

/** WinAnsi text as the own-engine writes it: <hex> Tj (lowercase hex). */
function hexOf(text: string): string {
  return Array.from(text, (ch) =>
    (ch.charCodeAt(0) & 0xff).toString(16).padStart(2, "0")
  ).join("");
}

function containsText(bytes: Uint8Array, text: string): boolean {
  const raw = new TextDecoder("latin1").decode(bytes);
  return raw.includes(hexOf(text));
}

/** Concatenated page content bytes — handles /Contents as a single
 * stream OR an array of streams (the own-engine "behind" layer extends
 * the array, so array is the common case for stamped output). */
async function pageContentRaw(
  bytes: Uint8Array,
  pageIndex: number
): Promise<string> {
  const doc = await PDFDocument.load(bytes.slice());
  const page = doc.getPage(pageIndex);
  const contents = page.node.Contents();
  if (contents === undefined) return "";
  const resolved = doc.context.lookup(contents);
  if (resolved === undefined) return "";
  const streamBytes = (stream: unknown): string => {
    const b = (stream as unknown as { contents?: Uint8Array }).contents;
    if (b === undefined) return "";
    return new TextDecoder("latin1").decode(b as unknown as Uint8Array);
  };
  if ((resolved as unknown as { size?: unknown }).size !== undefined) {
    // PDFArray of streams (pdf-lib `.size` is a METHOD)
    const arr = resolved as unknown as {
      size: () => number;
      get: (i: number) => unknown;
    };
    const count = arr.size();
    let out = "";
    for (let i = 0; i < count; i += 1) {
      const s = doc.context.lookup(arr.get(i) as never);
      out += streamBytes(s);
    }
    return out;
  }
  return streamBytes(resolved);
}

async function pageContainsText(
  bytes: Uint8Array,
  pageIndex: number,
  text: string
): Promise<boolean> {
  return (await pageContentRaw(bytes, pageIndex)).includes(hexOf(text));
}

/** True when the page content stream carries a `rg` fill of these channels. */
async function pageHasFillColor(
  bytes: Uint8Array,
  pageIndex: number,
  r: number,
  g: number,
  b: number
): Promise<boolean> {
  const raw = await pageContentRaw(bytes, pageIndex);
  // Engine number serialization: up to 10 fraction digits, zeros trimmed.
  const fmt = (v: number) =>
    v.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  const needle = `${fmt(r)} ${fmt(g)} ${fmt(b)} rg`;
  return raw.includes(needle);
}

/* ── Self-shimmed worker driver (smoke-split convention) ── */
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

const loaded: Record<string, boolean> = {};
async function loadWorker(path: string): Promise<void> {
  if (loaded[path]) return;
  await import(`../tools/${path}/worker`);
  loaded[path] = true;
}

type DriveOptions = Record<string, string | number | boolean>;

interface DriveFile {
  name: string;
  bytes: Uint8Array;
}

async function drive(
  path: string,
  runId: number,
  files: DriveFile[],
  options: DriveOptions
): Promise<RunEnd> {
  await loadWorker(path);
  const before = messages.length;
  workerGlobal.onmessage!({
    data: {
      type: "run",
      runId,
      toolId: path,
      options,
      files: files.map(
        (f) =>
          new File([f.bytes as BlobPart], f.name, { type: "application/pdf" })
      ),
    } as WorkerRunRequest,
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    const hit = messages
      .slice(before)
      .find((m) => m.runId === runId && (m.type === "result" || m.type === "error"));
    if (hit) return hit as RunEnd;
    if (Date.now() > deadline) {
      throw new Error(`worker ${path} timed out`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function endBytes(end: RunEnd): Promise<Uint8Array> {
  if (end.type !== "result") {
    throw new Error(`expected result, got ${end.type} ${end.code ?? ""}`);
  }
  const blob = end.outputs[0].blob as unknown as Blob;
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

/* ================================================================== */
console.log("── 0. Wiring sanity ──────────────────────────────────");
/* ================================================================== */
{
  const registry = readFileSync("src/lib/tools/registry.ts", "utf8");
  const configs = readFileSync("src/lib/tools/configs.ts", "utf8");
  const seo = readFileSync("src/lib/seo/tool-seo.ts", "utf8");
  const en = readFileSync("src/i18n/en.json", "utf8");
  const hi = readFileSync("src/i18n/hi.json", "utf8");
  const ids = [
    "bates-numbering",
    "add-stamps",
    "background-color",
    "remove-blank-pages",
    "alternate-merge",
    "add-page-labels",
  ];
  for (const id of ids) {
    check(`registry def: ${id}`, registry.includes(`id: "${id}"`));
    check(`configs map: ${id}`, configs.includes(id));
    check(`seo curated: ${id}`, seo.includes(`"${id}": {`));
  }
  for (const key of [
    "errorCustomTextEmpty",
    "errorBadHex",
    "errorNeedTwoFiles",
    "errorNoBlankFound",
    "errorAllBlank",
  ]) {
    check(
      `i18n tool.${key} (en+hi)`,
      en.includes(key) && hi.includes(key)
    );
  }
}

const textFixture = await buildTextFixture();
const blankMix = await buildBlankMixFixture();
const allBlank = await buildAllBlankFixture();
const [fixA, fixB] = await buildTwoFixtures();

/* ================================================================== */
console.log("── 1. bates-numbering ────────────────────────────────");
/* ================================================================== */
{
  const end = await drive("bates-numbering", 10, [
    { name: "doc.pdf", bytes: textFixture },
  ], {
    prefix: "DOC-",
    startNumber: 1,
    digits: "6",
    position: "bottom-right",
    size: 9,
    pages: "all",
  });
  check("result", end.type === "result", end);
  const bytes = await endBytes(end);
  const widths = await pageWidths(bytes);
  check("5 pages kept", widths.length === 5, widths.length);
  check(
    "widths unchanged",
    widths.every((w, i) => near(w, 100 * (i + 1))),
    widths
  );
  check("first stamp DOC-000001", containsText(bytes, "DOC-000001"));
  check("last stamp DOC-000005", containsText(bytes, "DOC-000005"));

  const end2 = await drive("bates-numbering", 11, [
    { name: "doc.pdf", bytes: textFixture },
  ], {
    prefix: "CASE-",
    startNumber: 42,
    digits: "4",
    position: "top-left",
    size: 12,
    pages: "2-3",
  });
  check("subset result", end2.type === "result", end2);
  const bytes2 = await endBytes(end2);
  check("CASE-0042 on page 2", await pageContainsText(bytes2, 1, "CASE-0042"));
  check("CASE-0043 on page 3", await pageContainsText(bytes2, 2, "CASE-0043"));
  check(
    "no stamp on page 1",
    !(await pageContainsText(bytes2, 0, "CASE-0042"))
  );
  check("no CASE on page 4", !(await pageContainsText(bytes2, 3, "CASE-")));

  const end3 = await drive("bates-numbering", 12, [
    { name: "doc.pdf", bytes: textFixture },
  ], {
    prefix: "डॉक",
    startNumber: 1,
    digits: "6",
    position: "bottom-right",
    size: 9,
    pages: "all",
  });
  check(
    "Devanagari prefix refused",
    end3.type === "error" && end3.code === "tool.errorWatermarkChars",
    end3
  );
}

/* ================================================================== */
console.log("── 2. add-stamps ─────────────────────────────────────");
/* ================================================================== */
{
  const end = await drive("add-stamps", 20, [
    { name: "doc.pdf", bytes: textFixture },
  ], {
    text: "APPROVED",
    position: "bottom-right",
    color: "red",
    size: 36,
    opacity: 25,
    rotate: "-45",
    pages: "all",
  });
  check("result", end.type === "result", end);
  const bytes = await endBytes(end);
  check("APPROVED stamped", containsText(bytes, "APPROVED"));
  const widths = await pageWidths(bytes);
  check("5 pages kept", widths.length === 5, widths.length);

  const end2 = await drive("add-stamps", 21, [
    { name: "doc.pdf", bytes: textFixture },
  ], {
    text: "custom",
    customText: "   ",
    position: "center",
    color: "green",
    size: 24,
    opacity: 50,
    rotate: "0",
    pages: "all",
  });
  check(
    "empty custom refused",
    end2.type === "error" && end2.code === "tool.errorCustomTextEmpty",
    end2
  );

  const end3 = await drive("add-stamps", 22, [
    { name: "doc.pdf", bytes: textFixture },
  ], {
    text: "custom",
    customText: "FINAL v2",
    position: "top-center",
    color: "black",
    size: 20,
    opacity: 80,
    rotate: "30",
    pages: "1",
  });
  check("custom result", end3.type === "result", end3);
  const bytes3 = await endBytes(end3);
  check("FINAL v2 on page 1", await pageContainsText(bytes3, 0, "FINAL v2"));
  check(
    "nothing on page 2",
    !(await pageContainsText(bytes3, 1, "FINAL v2"))
  );
}

/* ================================================================== */
console.log("── 3. background-color ────────────────────────────────");
/* ================================================================== */
{
  const end = await drive("background-color", 30, [
    { name: "doc.pdf", bytes: textFixture },
  ], {
    color: "yellow",
    opacity: 100,
    layer: "behind",
    pages: "all",
  });
  check("result", end.type === "result", end);
  const bytes = await endBytes(end);
  const widths = await pageWidths(bytes);
  check("5 pages kept", widths.length === 5, widths.length);
  check(
    "yellow fill on page 1",
    await pageHasFillColor(bytes, 0, 1, 0.95, 0.6)
  );
  check(
    "yellow fill on page 5",
    await pageHasFillColor(bytes, 4, 1, 0.95, 0.6)
  );

  const end2 = await drive("background-color", 31, [
    { name: "doc.pdf", bytes: textFixture },
  ], {
    color: "custom",
    hex: "GG1234",
    opacity: 100,
    layer: "behind",
    pages: "all",
  });
  check(
    "bad hex refused",
    end2.type === "error" && end2.code === "tool.errorBadHex",
    end2
  );

  const end3 = await drive("background-color", 32, [
    { name: "doc.pdf", bytes: textFixture },
  ], {
    color: "custom",
    hex: "1A73E8",
    opacity: 50,
    layer: "over",
    pages: "2-3",
  });
  check("custom hex result", end3.type === "result", end3);
  const bytes3 = await endBytes(end3);
  check(
    "custom fill on page 2",
    await pageHasFillColor(bytes3, 1, 0x1a / 255, 0x73 / 255, 0xe8 / 255)
  );
}

/* ================================================================== */
console.log("── 4. remove-blank-pages ──────────────────────────────");
/* ================================================================== */
{
  const end = await drive("remove-blank-pages", 40, [
    { name: "doc.pdf", bytes: blankMix },
  ], {});
  check("result", end.type === "result", end);
  const bytes = await endBytes(end);
  const widths = await pageWidths(bytes);
  check("3 pages kept", widths.length === 3, widths.length);
  check(
    "kept pages 1/3/5 (widths 100/300/500)",
    widths.length === 3 &&
      near(widths[0], 100) &&
      near(widths[1], 300) &&
      near(widths[2], 500),
    widths
  );
  check(
    "detail pages=3",
    end.type === "result" && (end.detail as { pages?: number }).pages === 3,
    end.detail
  );

  const end2 = await drive("remove-blank-pages", 41, [
    { name: "doc.pdf", bytes: textFixture },
  ], {});
  check(
    "no blanks → honest refusal",
    end2.type === "error" && end2.code === "tool.errorNoBlankFound",
    end2
  );

  const end3 = await drive("remove-blank-pages", 42, [
    { name: "doc.pdf", bytes: allBlank },
  ], {});
  check(
    "all blank → refused",
    end3.type === "error" && end3.code === "tool.errorAllBlank",
    end3
  );
}

/* ================================================================== */
console.log("── 5. alternate-merge ─────────────────────────────────");
/* ================================================================== */
{
  const a3 = fixA; // 100/300/500
  const b3 = fixB; // 220/240/260
  const a2 = await PDFDocument.load(a3.slice());
  await a2.removePage(2);
  const a2bytes = await a2.save({ useObjectStreams: false }); // 100/300

  const end = await drive("alternate-merge", 50, [
    { name: "fronts.pdf", bytes: a2bytes },
    { name: "backs.pdf", bytes: b3 },
  ], {
    lead: "first",
    tail: "append",
  });
  check("result", end.type === "result", end);
  const bytes = await endBytes(end);
  const widths = await pageWidths(bytes);
  check(
    "append weave [A,B,A,B,B]",
    widths.length === 5 &&
      near(widths[0], 100) &&
      near(widths[1], 220) &&
      near(widths[2], 300) &&
      near(widths[3], 240) &&
      near(widths[4], 260),
    widths
  );

  const end2 = await drive("alternate-merge", 51, [
    { name: "fronts.pdf", bytes: a2bytes },
    { name: "backs.pdf", bytes: b3 },
  ], {
    lead: "first",
    tail: "blank",
  });
  check("blankpad result", end2.type === "result", end2);
  const bytes2 = await endBytes(end2);
  const widths2 = await pageWidths(bytes2);
  check(
    "blank-pad weave [A,B,A,B,blank(B size),B]",
    widths2.length === 6 &&
      near(widths2[0], 100) &&
      near(widths2[1], 220) &&
      near(widths2[2], 300) &&
      near(widths2[3], 240) &&
      near(widths2[4], 240) &&
      near(widths2[5], 260),
    widths2
  );

  const end3 = await drive("alternate-merge", 52, [
    { name: "fronts.pdf", bytes: a2bytes },
    { name: "backs.pdf", bytes: b3 },
  ], {
    lead: "second",
    tail: "append",
  });
  check("lead=second result", end3.type === "result", end3);
  const bytes3 = await endBytes(end3);
  const widths3 = await pageWidths(bytes3);
  check(
    "second leads [B,A,B,A,B]",
    widths3.length === 5 &&
      near(widths3[0], 220) &&
      near(widths3[1], 100) &&
      near(widths3[2], 240) &&
      near(widths3[3], 300) &&
      near(widths3[4], 260),
    widths3
  );

  const end4 = await drive("alternate-merge", 53, [
    { name: "only-one.pdf", bytes: a2bytes },
  ], {
    lead: "first",
    tail: "append",
  });
  check(
    "one file → refusal",
    end4.type === "error" && end4.code === "tool.errorNeedTwoFiles",
    end4
  );
}

/* ================================================================== */
console.log("── 6. add-page-labels ─────────────────────────────────");
/* ================================================================== */
{
  const end = await drive("add-page-labels", 60, [
    { name: "doc.pdf", bytes: textFixture },
  ], {
    scheme: "r",
    prefix: "Page ",
    startNumber: 5,
  });
  check("result", end.type === "result", end);
  const bytes = await endBytes(end);
  const doc = await PDFDocument.load(bytes.slice());
  check("5 pages kept", doc.getPageCount() === 5, doc.getPageCount());
  const labels = doc.catalog.get(PDFName.of("PageLabels"));
  check("catalog has PageLabels", labels !== undefined);
  if (labels !== undefined) {
    const labelsDict = doc.context.lookup(labels) as unknown as {
      get: (k: unknown) => unknown;
    };
    const numsRaw = labelsDict.get(PDFName.of("Nums"));
    const numsArr = doc.context.lookup(numsRaw as never) as unknown as {
      size?: () => number;
      get: (i: number) => unknown;
    };
    check(
      "Nums is an array of 2",
      numsArr !== undefined &&
        typeof numsArr.size === "function" &&
        numsArr.size() === 2,
      numsArr?.size?.()
    );
    if (numsArr !== undefined && typeof numsArr.size === "function") {
      const firstIdx = doc.context.lookup(numsArr.get(0) as never) as unknown as {
        asNumber?: () => number;
      };
      check(
        "Nums[0] = 0",
        firstIdx?.asNumber !== undefined && firstIdx.asNumber() === 0
      );
      const labelRaw = numsArr.get(1);
      const labelDict = doc.context.lookup(labelRaw as never) as unknown as {
        get?: (k: unknown) => unknown;
      };
      check("label dict readable", labelDict?.get !== undefined);
      if (labelDict?.get !== undefined) {
        const sRaw = labelDict.get(PDFName.of("S"));
        const s = doc.context.lookup(sRaw as never) as unknown as {
          asString?: () => string;
        };
        check(
          "S = r",
          s?.asString !== undefined &&
            s.asString().replace(/^\//, "") === "r",
          s?.asString?.()
        );
        const stRaw = labelDict.get(PDFName.of("St"));
        const st = doc.context.lookup(stRaw as never) as unknown as {
          asNumber?: () => number;
        };
        check(
          "St = 5",
          st?.asNumber !== undefined && st.asNumber() === 5,
          st?.asNumber?.()
        );
        const pRaw = labelDict.get(PDFName.of("P"));
        check("P present", pRaw !== undefined);
        if (pRaw !== undefined) {
          const pStr = doc.context.lookup(pRaw as never) as unknown as {
            decodeText?: () => string;
          };
          check(
            'P = "Page "',
            pStr?.decodeText !== undefined &&
              pStr.decodeText() === "Page ",
            pStr?.decodeText?.()
          );
        }
      }
    }
  }

  const end2 = await drive("add-page-labels", 61, [
    { name: "doc.pdf", bytes: textFixture },
  ], {
    scheme: "D",
    prefix: "",
    startNumber: 1,
  });
  check("plain result", end2.type === "result", end2);
  const bytes2 = await endBytes(end2);
  const doc2 = await PDFDocument.load(bytes2.slice());
  const labels2 = doc2.catalog.get(PDFName.of("PageLabels"));
  check("catalog has PageLabels (D)", labels2 !== undefined);
  if (labels2 !== undefined) {
    const labelsDict2 = doc2.context.lookup(labels2) as unknown as {
      get: (k: unknown) => unknown;
    };
    const nums2Raw = labelsDict2.get(PDFName.of("Nums"));
    const numsArr2 = doc2.context.lookup(nums2Raw as never) as unknown as {
      size?: () => number;
      get: (i: number) => unknown;
    };
    check(
      "Nums is an array of 2 (D)",
      numsArr2 !== undefined &&
        typeof numsArr2.size === "function" &&
        numsArr2.size() === 2,
      numsArr2?.size?.()
    );
    if (numsArr2 !== undefined && typeof numsArr2.size === "function") {
      const labelDict2 = doc2.context.lookup(numsArr2.get(1) as never) as unknown as {
        get?: (k: unknown) => unknown;
      };
      if (labelDict2?.get !== undefined) {
        const s2Raw = labelDict2.get(PDFName.of("S"));
        const s2 = doc2.context.lookup(s2Raw as never) as unknown as {
          asString?: () => string;
        };
        check(
          "S = D",
          s2?.asString !== undefined &&
            s2.asString().replace(/^\//, "") === "D",
          s2?.asString?.()
        );
        const st2Raw = labelDict2.get(PDFName.of("St"));
        const st2 = doc2.context.lookup(st2Raw as never) as unknown as {
          asNumber?: () => number;
        };
        check(
          "St = 1",
          st2?.asNumber !== undefined && st2.asNumber() === 1,
          st2?.asNumber?.()
        );
        check("no P when empty", labelDict2.get(PDFName.of("P")) === undefined);
      }
    }
  }

  const end3 = await drive("add-page-labels", 62, [
    { name: "doc.pdf", bytes: textFixture },
  ], {
    scheme: "r",
    prefix: "पृष्ठ",
    startNumber: 1,
  });
  check(
    "Devanagari prefix refused",
    end3.type === "error" && end3.code === "tool.errorWatermarkChars",
    end3
  );
}

/* ── Summary ── */
console.log("");
console.log(`R50 smoke: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("FAILED:", failures);
  process.exit(1);
}
