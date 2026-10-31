/**
 * Smoke: R52 tool batch — P1-c output pack (pdfs-to-zip / rotate-custom /
 * view-metadata / change-permissions).
 *
 * The REAL workers through a self-shimmed globalThis (postMessage capture +
 * onmessage dispatch, the smoke-split convention). pdf-lib is the DEV ORACLE
 * only (fixtures + output verification); the tools run 100% on our own
 * engine.
 *
 *  0. Wiring sanity: registry entries + configs + seo + i18n present;
 *     tool counts 120 total / 117 live / 3 deferred.
 *  1. pdfs-to-zip: store + deflate roundtrips (own unzipSync oracle,
 *     byte-identical payloads), duplicate-name dedupe, single-file and
 *     non-PDF refusals.
 *  2. rotate-custom: exact AABB sizes for 90°/45°/30°/composed /Rotate 90+5°
 *     (pdf-lib reload), page-subset copy keeps annotations, rotated pages
 *     drop them (honest), angle-0 refusal.
 *  3. view-metadata: TXT report carries Info fields + page sizes; JSON
 *     parses with pageCount + pages; per-page switch; encrypted input is
 *     reported honestly.
 *  4. change-permissions: output opens with NO password but refuses a plain
 *     parse; /P equals permissionsR3 of the request (both algorithms);
 *     owner-password path; short/non-latin owner-password refusals;
 *     already-encrypted refusal; assembly bit lands.
 *
 * Run: bun scripts/smoke-r52-tools.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  PDFDocument,
  PDFName,
  PDFArray,
  StandardFonts,
  degrees,
  rgb,
} from "pdf-lib";

import { unzipSync } from "../src/lib/own/zip";
import { permissionsR3 } from "../src/lib/own/pdf";
import { lockPdf } from "../tools/lock-common/security";
import {
  normalizeAngle,
  rotatedBounds,
} from "../tools/rotate-custom/worker-lib";

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
      actual !== undefined ? JSON.stringify(actual).slice(0, 300) : "",
    );
  }
}

function near(a: number, b: number, eps = 0.5): boolean {
  return Math.abs(a - b) < eps;
}

async function endText(end: RunEnd): Promise<string> {
  if (end.type !== "result") {
    throw new Error(`expected result, got ${end.type} ${end.code ?? ""}`);
  }
  const blob = end.outputs[0]!.blob as unknown as Blob;
  return await blob.text();
}

async function endBytes(end: RunEnd): Promise<Uint8Array> {
  if (end.type !== "result") {
    throw new Error(`expected result, got ${end.type} ${end.code ?? ""}`);
  }
  const blob = end.outputs[0]!.blob as unknown as Blob;
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

/* ── Fixtures ── */

/** 2 pages 400×300 with text; page 1 carries a Link annotation. */
async function buildRotateFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([400, 300]);
  p1.drawText("PAGE ONE", { x: 20, y: 150, size: 24, font, color: rgb(0.8, 0.1, 0.1) });
  const annot = doc.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [50, 240, 320, 280],
    Border: [0, 0, 1],
    C: [0, 0, 1],
    A: { Type: "Action", S: "URI", URI: "https://example.com/rotate" },
  });
  const annotRef = doc.context.register(annot);
  p1.node.set(PDFName.of("Annots"), doc.context.obj([annotRef]));
  const p2 = doc.addPage([400, 300]);
  p2.drawText("PAGE TWO", { x: 20, y: 150, size: 24, font, color: rgb(0.1, 0.1, 0.8) });
  return doc.save({ useObjectStreams: false });
}

/** 1 page 400×300 with /Rotate 90 already set. */
async function buildPreRotatedFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 300]);
  page.setRotation(degrees(90));
  page.drawText("PRE-ROTATED", { x: 20, y: 150, size: 24, font });
  return doc.save({ useObjectStreams: false });
}

/** 1 page with full Info (title/author/subject/keywords/creator/producer + dates). */
async function buildMetaFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText("META FIXTURE", { x: 50, y: 700, size: 18, font });
  doc.setTitle("Quarterly Report Q3");
  doc.setAuthor("Deepak Kumar");
  doc.setSubject("Financial summary");
  doc.setKeywords(["report", "finance", "q3"]);
  doc.setCreator("DocoPDF test harness");
  doc.setProducer("pdf-lib fixture");
  doc.setCreationDate(new Date("2026-10-31T10:20:30Z"));
  doc.setModificationDate(new Date("2026-10-31T11:20:30Z"));
  return doc.save({ useObjectStreams: false });
}

/** 1 page, nothing else (for the permissions runs). */
async function buildPlainFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 400]).drawText("PLAIN", { x: 20, y: 200, size: 20, font });
  return doc.save({ useObjectStreams: false });
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

/* ================================================================== */
console.log("── 0. Wiring sanity ──────────────────────────────────");
/* ================================================================== */
{
  const registry = readFileSync("src/lib/tools/registry.ts", "utf8");
  const configs = readFileSync("src/lib/tools/configs.ts", "utf8");
  const seo = readFileSync("src/lib/seo/tool-seo.ts", "utf8");
  const en = JSON.parse(readFileSync("src/i18n/en.json", "utf8"));
  const hi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8"));
  const ids = [
    "pdfs-to-zip",
    "rotate-custom",
    "view-metadata",
    "change-permissions",
  ];
  for (const id of ids) {
    check(`registry def: ${id}`, registry.includes(`id: "${id}"`));
    check(`configs map: ${id}`, configs.includes(id));
    check(`seo curated: ${id}`, seo.includes(`"${id}": {`));
  }
  for (const key of [
    "errorPageTooLarge",
    "errorOwnerPwShort",
    "errorPwChars",
    "errorNeedTwoFiles",
    "errorNothingToDo",
    "errorAlreadyEncrypted",
    "errorEncrypted",
    "errorCorrupt",
    "errorInvalidPages",
    "errorGeneric",
  ]) {
    check(
      `i18n: tool.${key} in en + hi`,
      en.tool?.[key] !== undefined && hi.tool?.[key] !== undefined,
    );
  }

  // Worker discipline: own engine only (no pdf-lib imports).
  for (const name of ids) {
    const src = readFileSync(join(import.meta.dir, `../tools/${name}/worker.ts`), "utf8");
    check(
      `${name}/worker.ts imports no pdf-lib (own engine only)`,
      !/(from\s+["'](?:@cantoo\/)?pdf-lib["']|import\(["'](?:@cantoo\/)?pdf-lib["']\))/.test(src),
    );
  }

  const { ALL_TOOLS } = await import("../src/lib/tools/registry");
  const live = ALL_TOOLS.filter((t) => t.enabled).length;
  const deferred = ALL_TOOLS.filter((t) => !t.enabled).map((t) => t.id);
  check(
    "tool counts: 127 total / 126 live / 1 deferred AI",
    ALL_TOOLS.length === 127 &&
      live === 126 &&
      JSON.stringify(deferred) ===
        JSON.stringify(["translate-pdf"]),
    { total: ALL_TOOLS.length, live, deferred },
  );
}

/* ================================================================== */
console.log("── 1. pdfs-to-zip ─────────────────────────────────────");
/* ================================================================== */
{
  const a = await buildPlainFixture();
  const b = await buildRotateFixture();
  const c = await buildMetaFixture();

  // Store roundtrip: 3 distinct names, byte-identical payloads.
  const store = await drive("pdfs-to-zip", 101, [
    { name: "alpha.pdf", bytes: a },
    { name: "beta.pdf", bytes: b },
    { name: "gamma.pdf", bytes: c },
  ], { compression: "store" });
  check("store: result arrives", store.type === "result", store);
  if (store.type === "result") {
    check("store: output is a .zip named after the first file", store.outputs[0]!.name === "alpha-batch.zip", store.outputs[0]!.name);
    const zipped = await endBytes(store);
    const entries = unzipSync(zipped);
    const names = Object.keys(entries).sort();
    check(
      "store: all 3 entries present",
      JSON.stringify(names) === JSON.stringify(["alpha.pdf", "beta.pdf", "gamma.pdf"]),
      names,
    );
    check(
      "store: payloads byte-identical",
      entries["alpha.pdf"] !== undefined && a.every((byte, i) => byte === entries["alpha.pdf"]![i]) &&
        entries["beta.pdf"] !== undefined && b.every((byte, i) => byte === entries["beta.pdf"]![i]) &&
        entries["gamma.pdf"] !== undefined && c.every((byte, i) => byte === entries["gamma.pdf"]![i]),
    );
    // STORE method: each entry's LOCAL header (sig + name match) says
    // method 0. Naive byte-walking misaligns when PDF payload data itself
    // contains "PK\x03\x04", so locate headers by signature + exact name
    // and cross-check nameLen.
    let allStored = true;
    for (const name of ["alpha.pdf", "beta.pdf", "gamma.pdf"]) {
      const nameBytes = new TextEncoder().encode(name);
      let index = -1;
      for (let i = 0; i + 30 + nameBytes.length <= zipped.length; i += 1) {
        if (
          zipped[i] === 0x50 && zipped[i + 1] === 0x4b &&
          zipped[i + 2] === 0x03 && zipped[i + 3] === 0x04 &&
          zipped[i + 26] === nameBytes.length &&
          nameBytes.every((b, j) => zipped[i + 30 + j] === b)
        ) {
          index = i;
          break;
        }
      }
      const method =
        index >= 0 ? zipped[index + 8]! | (zipped[index + 9]! << 8) : -1;
      if (method !== 0) allStored = false;
    }
    check("store: every local header says method 0 (STORE)", allStored);
  }

  // Deflate roundtrip.
  const defl = await drive("pdfs-to-zip", 102, [
    { name: "one.pdf", bytes: a },
    { name: "two.pdf", bytes: b },
  ], { compression: "deflate" });
  check("deflate: result arrives", defl.type === "result", defl);
  if (defl.type === "result") {
    const entries = unzipSync(await endBytes(defl));
    check(
      "deflate: payloads byte-identical",
      entries["one.pdf"] !== undefined && a.every((byte, i) => byte === entries["one.pdf"]![i]),
    );
  }

  // Duplicate names dedupe.
  const dup = await drive("pdfs-to-zip", 103, [
    { name: "same.pdf", bytes: a },
    { name: "same.pdf", bytes: b },
    { name: "other.pdf", bytes: c },
  ], { compression: "store" });
  check("dedupe: result arrives", dup.type === "result", dup);
  if (dup.type === "result") {
    const entries = unzipSync(await endBytes(dup));
    const names = Object.keys(entries).sort();
    check(
      "dedupe: same.pdf + same-2.pdf + other.pdf",
      JSON.stringify(names) === JSON.stringify(["other.pdf", "same-2.pdf", "same.pdf"]),
      names,
    );
    check(
      "dedupe: first keeps original bytes, second its own",
      entries["same.pdf"] !== undefined && a.every((byte, i) => byte === entries["same.pdf"]![i]) &&
        entries["same-2.pdf"] !== undefined && b.every((byte, i) => byte === entries["same-2.pdf"]![i]),
    );
  }

  // Refusals.
  const one = await drive("pdfs-to-zip", 104, [{ name: "solo.pdf", bytes: a }], {});
  check("one file → errorNeedTwoFiles", one.type === "error" && one.code === "tool.errorNeedTwoFiles", one);
  const notPdf = await drive("pdfs-to-zip", 105, [
    { name: "a.pdf", bytes: a },
    { name: "b.pdf", bytes: new TextEncoder().encode("this is not a pdf at all") },
  ], {});
  check("non-PDF member → errorCorrupt with detail", notPdf.type === "error" && notPdf.code === "tool.errorCorrupt" && notPdf.detail === "b.pdf", notPdf);
}

/* ================================================================== */
console.log("── 2. rotate-custom ───────────────────────────────────");
/* ================================================================== */
{
  // Pure math first (the AABB anchor).
  const b90 = rotatedBounds(400, 300, 90);
  check("bounds 90°: 300 × 400 exact", near(b90.width, 300, 1e-6) && near(b90.height, 400, 1e-6), b90);
  const b45 = rotatedBounds(400, 300, 45);
  check(
    "bounds 45°: 494.975 square-ish",
    near(b45.width, 494.9747, 0.01) && near(b45.height, 494.9747, 0.01),
    b45,
  );
  check("normalizeAngle: 270 → -90", normalizeAngle(270) === -90, normalizeAngle(270));
  check("normalizeAngle: -190 → 170", normalizeAngle(-190) === 170, normalizeAngle(-190));

  // 90° on ALL pages of a 2-page 400×300 doc.
  const fixture = await buildRotateFixture();
  const rot90 = await drive("rotate-custom", 201, [{ name: "doc.pdf", bytes: fixture }], {
    angle: 90,
    pages: "all",
  });
  check("90°: result arrives", rot90.type === "result", rot90);
  if (rot90.type === "result") {
    const reloaded = await PDFDocument.load(await endBytes(rot90), { updateMetadata: false });
    check("90°: 2 pages", reloaded.getPageCount() === 2, reloaded.getPageCount());
    const sizes = reloaded.getPages().map((p) => p.getSize());
    check(
      "90°: both pages 300 × 400 exact",
      sizes.every((s) => Math.abs(s.width - 300) < 1e-6 && Math.abs(s.height - 400) < 1e-6),
      sizes,
    );
    check(
      "90°: rotated pages have no /Rotate flag (baked into the matrix)",
      reloaded.getPages().every((p) => p.getRotation().angle === 0),
      reloaded.getPages().map((p) => p.getRotation().angle),
    );
    const annots = reloaded.getPages().map(
      (p) => p.node.lookupMaybe(PDFName.of("Annots"), PDFArray)?.size() ?? 0,
    );
    check(
      "90°: annotations dropped on rotated pages (honest embed parity)",
      annots.every((n) => n === 0),
      annots,
    );
  }

  // Subset: rotate ONLY page 2 → page 1 keeps annotation + size.
  const subset = await drive("rotate-custom", 202, [{ name: "doc.pdf", bytes: fixture }], {
    angle: 45,
    pages: "2",
  });
  check("subset: result arrives", subset.type === "result", subset);
  if (subset.type === "result") {
    const reloaded = await PDFDocument.load(await endBytes(subset), { updateMetadata: false });
    const sizes = reloaded.getPages().map((p) => p.getSize());
    check(
      "subset: page 1 untouched 400 × 300",
      Math.abs(sizes[0]!.width - 400) < 1e-6 && Math.abs(sizes[0]!.height - 300) < 1e-6,
      sizes[0],
    );
    check(
      "subset: page 2 is the 45° bounding box (~494.97)",
      near(sizes[1]!.width, 494.9747, 0.3) && near(sizes[1]!.height, 494.9747, 0.3),
      sizes[1],
    );
    const annots1 = reloaded.getPage(0).node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    check(
      "subset: page 1 Link annotation survives the copy",
      annots1 !== undefined && annots1.size() === 1,
      annots1?.size(),
    );
  }

  // Composed: source /Rotate 90 + angle 5 → φ = 95.
  const pre = await buildPreRotatedFixture();
  const comp = await drive("rotate-custom", 203, [{ name: "pre.pdf", bytes: pre }], {
    angle: 5,
    pages: "all",
  });
  check("composed: result arrives", comp.type === "result", comp);
  if (comp.type === "result") {
    const reloaded = await PDFDocument.load(await endBytes(comp), { updateMetadata: false });
    const s = reloaded.getPage(0).getSize();
    // φ=95: W = 400·|cos95| + 300·|sin95| = 333.72; H = 400·|sin95| + 300·|cos95| = 424.63.
    check(
      "composed: /Rotate 90 + 5° → 333.72 × 424.63",
      near(s.width, 333.7205, 0.3) && near(s.height, 424.6252, 0.3),
      s,
    );
  }

  // Angle 0 → honest refusal.
  const zero = await drive("rotate-custom", 204, [{ name: "doc.pdf", bytes: fixture }], {
    angle: 0,
    pages: "all",
  });
  check("angle 0 → errorNothingToDo", zero.type === "error" && zero.code === "tool.errorNothingToDo", zero);

  // 30° all pages (a third angle family: non-special, non-square result).
  const rot30 = await drive("rotate-custom", 205, [{ name: "doc.pdf", bytes: fixture }], {
    angle: 30,
    pages: "all",
  });
  check("30°: result arrives", rot30.type === "result", rot30);
  if (rot30.type === "result") {
    const reloaded = await PDFDocument.load(await endBytes(rot30), { updateMetadata: false });
    const s = reloaded.getPage(0).getSize();
    check(
      "30°: 496.41 × 459.81",
      near(s.width, 496.4102, 0.3) && near(s.height, 459.8076, 0.3),
      s,
    );
  }
}

/* ================================================================== */
console.log("── 3. view-metadata ───────────────────────────────────");
/* ================================================================== */
{
  const fixture = await buildMetaFixture();

  const txt = await drive("view-metadata", 301, [{ name: "report.pdf", bytes: fixture }], {
    format: "txt",
    includePages: true,
  });
  check("txt: result arrives", txt.type === "result", txt);
  if (txt.type === "result") {
    check("txt: output named report-metadata.txt", txt.outputs[0]!.name === "report-metadata.txt", txt.outputs[0]!.name);
    const text = await endText(txt);
    check("txt: title", text.includes("Quarterly Report Q3"));
    check("txt: author", text.includes("Deepak Kumar"));
    check("txt: subject", text.includes("Financial summary"));
    check("txt: keywords (pdf-lib joins with spaces)", text.includes("report finance q3"));
    check("txt: producer", text.includes("pdf-lib fixture"));
    check("txt: created date parsed", text.includes("2026-10-31"));
    check("txt: page count", text.includes("1") && text.includes("595.3") || text.includes("595.28"));
    check("txt: encrypted = No", /Encrypted\s+No/.test(text));
    check("txt: per-page section present", text.includes("EVERY PAGE"));
    check("txt: mm conversion present", text.includes("mm"));
  }

  const json = await drive("view-metadata", 302, [{ name: "report.pdf", bytes: fixture }], {
    format: "json",
    includePages: true,
  });
  check("json: result arrives", json.type === "result", json);
  if (json.type === "result") {
    check("json: output is .json", json.outputs[0]!.name === "report-metadata.json", json.outputs[0]!.name);
    const parsed = JSON.parse(await endText(json)) as {
      pageCount: number;
      pages?: { page: number; rotation: number }[];
      documentInfo?: { title?: string };
    };
    check("json: pageCount = 1", parsed.pageCount === 1, parsed.pageCount);
    check("json: pages array with rotation", parsed.pages?.[0]?.rotation === 0, parsed.pages);
    check("json: documentInfo.title", parsed.documentInfo?.title === "Quarterly Report Q3");
  }

  const noPages = await drive("view-metadata", 303, [{ name: "report.pdf", bytes: fixture }], {
    format: "txt",
    includePages: false,
  });
  if (noPages.type === "result") {
    const text = await endText(noPages);
    check("txt: per-page section omitted when switched off", !text.includes("EVERY PAGE"));
  } else {
    check("txt: includePages=false run succeeds", false, noPages);
  }

  // Encrypted input: honest report, not an error.
  const plain = await buildPlainFixture();
  const locked = (await lockPdf(plain, {
    userPw: "open123",
    ownerPw: "",
    alg: "aes256",
    permissions: {
      printing: true,
      copying: false,
      modifying: false,
      annotating: true,
      fillingForms: true,
      contentAccessibility: true,
    },
  })).bytes;
  const enc = await drive("view-metadata", 304, [{ name: "secret.pdf", bytes: locked }], {
    format: "txt",
    includePages: true,
  });
  check("encrypted: still a result (inspector, not a parser)", enc.type === "result", enc);
  if (enc.type === "result") {
    const text = await endText(enc);
    check("encrypted: report says Yes", /Encrypted\s+Yes/.test(text));
    check("encrypted: honest note about the password", text.includes("without the password"));
  }
}

/* ================================================================== */
console.log("── 4. change-permissions ──────────────────────────────");
/* ================================================================== */
{
  const plain = await buildPlainFixture();
  const { parsePdf, openEncrypted } = await import("../src/lib/own/pdf");

  const request = {
    ownerPassword: "owner-secret-9",
    algorithm: "aes256",
    permPrinting: "notAllowed",
    permCopy: false,
    permModify: false,
    permAnnotate: false,
    permForms: false,
    permAccess: true,
    permAssemble: false,
  };
  const expectedP = permissionsR3({
    printing: false,
    copying: false,
    modifying: false,
    annotating: false,
    fillingForms: false,
    contentAccessibility: true,
    documentAssembly: false,
  });

  const run1 = await drive("change-permissions", 401, [{ name: "doc.pdf", bytes: plain }], request);
  check("aes256: result arrives", run1.type === "result", run1);
  if (run1.type === "result") {
    check("aes256: output named doc-restricted.pdf", run1.outputs[0]!.name === "doc-restricted.pdf", run1.outputs[0]!.name);
    const bytes = await endBytes(run1);
    // Perm-only guarantee: plain parse refuses, empty-password open succeeds.
    let parseRefused = false;
    try {
      parsePdf(bytes);
    } catch {
      parseRefused = true;
    }
    check("aes256: plain parse refuses (encrypted)", parseRefused);
    const opened = openEncrypted(bytes, "");
    check("aes256: opens with NO password", opened.kind === "ok", opened.kind);
    const text = new TextDecoder("latin1").decode(bytes);
    const m = text.match(/\/P\s+(-?\d+)/);
    check("aes256: /P flag present", m !== null, text.slice(0, 0));
    check(
      "aes256: /P equals permissionsR3 of the request",
      m !== null && Number(m[1]) === expectedP,
      { written: m?.[1], expected: expectedP },
    );
    check("aes256: 1 page survives", run1.detail?.pages === 1, run1.detail);
  }

  // AES-128 path + owner password set.
  const run2 = await drive("change-permissions", 402, [{ name: "doc.pdf", bytes: plain }], {
    ...request,
    ownerPassword: "owner-secret-9",
    algorithm: "aes128",
    permPrinting: "lowResolution",
    permCopy: true,
    permAssemble: true,
  });
  check("aes128: result arrives", run2.type === "result", run2);
  if (run2.type === "result") {
    const bytes = await endBytes(run2);
    const openedEmpty = openEncrypted(bytes, "");
    check("aes128: still opens with NO password", openedEmpty.kind === "ok", openedEmpty.kind);
    const openedOwner = openEncrypted(bytes, "owner-secret-9");
    check("aes128: owner password also opens", openedOwner.kind === "ok", openedOwner.kind);
    const expected128 = permissionsR3({
      printing: "lowResolution",
      copying: true,
      modifying: false,
      annotating: false,
      fillingForms: false,
      contentAccessibility: true,
      documentAssembly: true,
    });
    const text = new TextDecoder("latin1").decode(bytes);
    const m = text.match(/\/P\s+(-?\d+)/);
    check(
      "aes128: /P equals permissionsR3 (low-res print + assembly bit)",
      m !== null && Number(m[1]) === expected128,
      { written: m?.[1], expected: expected128 },
    );
  }

  // Refusals.
  const noOwner = await drive("change-permissions", 407, [{ name: "doc.pdf", bytes: plain }], {
    ...request,
    ownerPassword: "",
  });
  check("empty owner pw → errorNoPassword (required guard)", noOwner.type === "error" && noOwner.code === "tool.errorNoPassword", noOwner);

  const shortOwner = await drive("change-permissions", 403, [{ name: "doc.pdf", bytes: plain }], {
    ...request,
    ownerPassword: "abc",
  });
  check("3-char owner pw → errorOwnerPwShort", shortOwner.type === "error" && shortOwner.code === "tool.errorOwnerPwShort", shortOwner);

  const devanagariOwner = await drive("change-permissions", 404, [{ name: "doc.pdf", bytes: plain }], {
    ...request,
    ownerPassword: "ओनरपासवर्ड",
    algorithm: "aes128",
  });
  check("aes128 + Devanagari owner pw → errorPwChars", devanagariOwner.type === "error" && devanagariOwner.code === "tool.errorPwChars", devanagariOwner);

  // AES-256 + Devanagari owner pw: fine (UTF-8 hashing).
  const devOk = await drive("change-permissions", 405, [{ name: "doc.pdf", bytes: plain }], {
    ...request,
    ownerPassword: "ओनरपासवर्ड",
    algorithm: "aes256",
  });
  check("aes256 + Devanagari owner pw: accepted", devOk.type === "result", devOk);

  // Already-encrypted input.
  const locked = (await lockPdf(plain, {
    userPw: "open123",
    ownerPw: "",
    alg: "aes256",
    permissions: {
      printing: true,
      copying: false,
      modifying: false,
      annotating: true,
      fillingForms: true,
      contentAccessibility: true,
    },
  })).bytes;
  const already = await drive("change-permissions", 406, [{ name: "locked.pdf", bytes: locked }], request);
  check("already-encrypted → errorAlreadyEncrypted", already.type === "error" && already.code === "tool.errorAlreadyEncrypted", already);
}

console.log(
  `\nsmoke-r52-tools: ${pass}/${pass + fail} GREEN${fail > 0 ? ` (${fail} FAILED)` : ""}`,
);
if (failures.length > 0) {
  console.error("failed:", failures);
}
process.exit(fail > 0 ? 1 : 0);
