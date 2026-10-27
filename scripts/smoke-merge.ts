/**
 * Smoke test: merge-pdf worker (R6-b).
 *
 * merge-pdf had NO smoke of its own — this wires the REAL worker up the
 * house way (self/postMessage shim, web-optimize/sign recipe) and locks:
 *   1. wiring: TOOL_CONFIGS + registry entry, worker module self-registers
 *   2. happy path: 2 files → exactly ONE result, "-merged.pdf" name,
 *      honest detail.files/pages
 *   3. blankBetween separator page (2 + 1 + 1 blank = 4)
 *   4. per-file range spec via fileId map (parsePageSpec integration)
 *   5. encrypted input (real AES-256 @cantoo bytes, structural probe) →
 *      exactly ONE error, code tool.errorEncrypted, detail = file NAME,
 *      no result — the R6-b honesty fix (the toast must name the file)
 *   6. invalid page range → tool.errorInvalidPages with the file name
 *   7. outputName override + unsafe-char sanitisation
 *   8. i18n: every code the worker can post exists in en + hi
 *
 * Run: bun scripts/smoke-merge.ts
 */
import { readFileSync } from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { listPages, parsePdf } from "../src/lib/own/pdf";
import type { PdfObj } from "../src/lib/own/pdf";
import { TOOL_CONFIGS } from "../src/lib/tools/configs";
import { ALL_TOOLS } from "../src/lib/tools/registry";
import type {
  WorkerRunRequest,
  WorkerResponse,
} from "../src/lib/workers/protocol";

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

const read = (rel: string): string => readFileSync(`/home/z/my-project/${rel}`, "utf8");

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

/**
 * Fixture with REAL per-page content — every page draws its own "Page N"
 * text, so byte-level content-identity checks are non-vacuous (the P6-c
 * lesson: a fixture without content makes every identity check pass
 * while proving nothing).
 */
async function makePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i += 1) {
    const page = doc.addPage([300, 400]);
    page.drawText(`Page ${i + 1}`, { x: 24, y: 200, size: 18, font });
  }
  return doc.save({ useObjectStreams: false });
}

async function makeEncryptedPdf(): Promise<Uint8Array> {
  const { PDFDocument: CantooDoc } = await import("@cantoo/pdf-lib");
  const doc = await CantooDoc.create();
  doc.addPage([300, 300]);
  doc.encrypt({ userPassword: "secret", algorithm: "AES-256" });
  return doc.save({ useObjectStreams: false });
}

/* ------------------------------------------------------------------ */
/* worker drive (self-shim)                                            */
/* ------------------------------------------------------------------ */

const workerGlobal = globalThis as unknown as {
  postMessage: (msg: unknown) => void;
  onmessage: ((event: { data: WorkerRunRequest }) => void) | null;
};
const inbox: (WorkerResponse & { runId?: number })[] = [];
workerGlobal.postMessage = (msg: unknown): void => {
  inbox.push(msg as WorkerResponse & { runId?: number });
};
(globalThis as unknown as Record<string, unknown>).self = workerGlobal;
await import("../tools/merge-pdf/worker");

async function drive(
  runId: number,
  options: Record<string, unknown>,
  files: File[],
  fileIds?: string[]
): Promise<WorkerResponse[]> {
  const before = inbox.length;
  workerGlobal.onmessage!({
    data: {
      type: "run",
      runId,
      toolId: "merge-pdf",
      options: options as WorkerRunRequest["options"],
      files,
      fileIds,
    },
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const terminal = inbox
      .slice(before)
      .some((m) => m.type === "result" || m.type === "error");
    if (terminal) return inbox.slice(before);
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`worker run ${runId} did not finish`);
}

/* ------------------------------------------------------------------ */
/* 1. wiring                                                           */
/* ------------------------------------------------------------------ */

console.log("\n── 1. wiring ────────────────────────────────────────────");
{
  check("TOOL_CONFIGS has merge-pdf", TOOL_CONFIGS["merge-pdf"] !== undefined);
  const def = ALL_TOOLS.find((t) => t.id === "merge-pdf");
  check("registry has merge-pdf, enabled", def !== undefined && def.enabled === true);
  check("worker module self-registers onmessage", typeof workerGlobal.onmessage === "function");
}

/* ------------------------------------------------------------------ */
/* 2. happy path — 2 files, ONE result                                 */
/* ------------------------------------------------------------------ */

console.log("\n── 2. happy path: one result, honest detail ─────────────");
{
  const bytesA = await makePdf(2);
  const bytesB = await makePdf(1);
  const msgs = await drive(
    6101,
    {},
    [new File([bytesA as BlobPart], "alpha.pdf"), new File([bytesB as BlobPart], "beta.pdf")],
    ["fa", "fb"]
  );
  const results = msgs.filter((m) => m.type === "result");
  check("exactly ONE result message", results.length === 1, results.length);
  check("no error messages", msgs.every((m) => m.type !== "error"));
  const result = results[0] as Extract<WorkerResponse, { type: "result" }>;
  check("one output named alpha-merged.pdf", result.outputs.length === 1 && result.outputs[0].name === "alpha-merged.pdf", result.outputs.map((o) => o.name));
  check("output mime is application/pdf", result.outputs[0].mime === "application/pdf");
  const magic = new Uint8Array(await result.outputs[0].blob.slice(0, 5).arrayBuffer());
  check("output starts with %PDF-", String.fromCharCode(...magic) === "%PDF-");
  check("detail.files === 2", result.detail?.files === 2, result.detail);
  check("detail.pages === 3", result.detail?.pages === 3, result.detail);
}

/* ------------------------------------------------------------------ */
/* 3. blankBetween separator                                           */
/* ------------------------------------------------------------------ */

console.log("\n── 3. blankBetween adds one separator page ──────────────");
{
  const bytesA = await makePdf(2);
  const bytesB = await makePdf(1);
  const msgs = await drive(
    6102,
    { blankBetween: true },
    [new File([bytesA as BlobPart], "a.pdf"), new File([bytesB as BlobPart], "b.pdf")]
  );
  const result = msgs.find((m) => m.type === "result") as Extract<WorkerResponse, { type: "result" }>;
  check("blank run: exactly one result", Boolean(result));
  check("detail.pages === 4 (2 + blank + 1)", result?.detail?.pages === 4, result?.detail);
}

/* ------------------------------------------------------------------ */
/* 4. per-file range spec                                              */
/* ------------------------------------------------------------------ */

console.log("\n── 4. per-file range spec follows fileIds ───────────────");
{
  const bytesA = await makePdf(1);
  const bytesB = await makePdf(2);
  const msgs = await drive(
    6103,
    { fileRanges: JSON.stringify({ fb: "2" }) },
    [new File([bytesA as BlobPart], "a.pdf"), new File([bytesB as BlobPart], "b.pdf")],
    ["fa", "fb"]
  );
  const result = msgs.find((m) => m.type === "result") as Extract<WorkerResponse, { type: "result" }>;
  check("range run: exactly one result", Boolean(result));
  check("detail.pages === 2 (a all + b page 2 only)", result?.detail?.pages === 2, result?.detail);
}

/* ------------------------------------------------------------------ */
/* 5. encrypted input — honesty fix                                    */
/* ------------------------------------------------------------------ */

console.log("\n── 5. encrypted input names the file, no result ─────────");
{
  const bytesA = await makePdf(1);
  const encBytes = await makeEncryptedPdf();
  const msgs = await drive(
    6104,
    {},
    [new File([bytesA as BlobPart], "report.pdf"), new File([encBytes as BlobPart], "contract.pdf")],
    ["fa", "fb"]
  );
  const errors = msgs.filter((m) => m.type === "error") as Extract<WorkerResponse, { type: "error" }>[];
  check("exactly ONE error message", errors.length === 1, errors.map((m) => (m as { code?: string }).code));
  check("no result posted", msgs.every((m) => m.type !== "result"));
  const error = errors[0];
  check("code is tool.errorEncrypted", error?.code === "tool.errorEncrypted", error?.code);
  check("detail names the encrypted FILE", error?.detail === "contract.pdf", error?.detail);
  // progress must have stopped after the refusal (no page-copy churn)
  const lastProgress = [...msgs].reverse().find((m) => m.type === "progress") as
    | (Extract<WorkerResponse, { type: "progress" }> & { pct?: number })
    | undefined;
  check("refusal happens while still reading (early, honest)", (lastProgress?.pct ?? 0) < 60, lastProgress?.pct);
}

/* ------------------------------------------------------------------ */
/* 6. invalid page range                                               */
/* ------------------------------------------------------------------ */

console.log("\n── 6. invalid range keeps the file name ─────────────────");
{
  const bytesA = await makePdf(1);
  const msgs = await drive(
    6105,
    { fileRanges: JSON.stringify({ fa: "9-12" }) },
    [new File([bytesA as BlobPart], "a.pdf")],
    ["fa"]
  );
  const errors = msgs.filter((m) => m.type === "error") as Extract<WorkerResponse, { type: "error" }>[];
  check("invalid range: exactly ONE error", errors.length === 1, errors.length);
  check("code is tool.errorInvalidPages", errors[0]?.code === "tool.errorInvalidPages", errors[0]?.code);
  check("detail carries file + spec", typeof errors[0]?.detail === "string" && errors[0]!.detail!.includes("a.pdf") && errors[0]!.detail!.includes("9-12"), errors[0]?.detail);
}

/* ------------------------------------------------------------------ */
/* 7. outputName sanitisation                                          */
/* ------------------------------------------------------------------ */

console.log("\n── 7. outputName override + sanitisation ────────────────");
{
  const bytesA = await makePdf(1);
  const bytesB = await makePdf(1);
  const files = [new File([bytesA as BlobPart], "a.pdf"), new File([bytesB as BlobPart], "b.pdf")];
  const msgs1 = await drive(6106, { outputName: "My merged annual  report" }, files);
  const out1 = (msgs1.find((m) => m.type === "result") as Extract<WorkerResponse, { type: "result" }>)?.outputs[0];
  check("override keeps words, collapses spaces, adds .pdf", out1?.name === "My merged annual report.pdf", out1?.name);
  const msgs2 = await drive(6107, { outputName: "  " }, files);
  const out2 = (msgs2.find((m) => m.type === "result") as Extract<WorkerResponse, { type: "result" }>)?.outputs[0];
  check("blank override falls back to <base>-merged.pdf", out2?.name === "a-merged.pdf", out2?.name);
  const msgs3 = await drive(6108, { outputName: "bad/name\\here.pdf" }, files);
  const out3 = (msgs3.find((m) => m.type === "result") as Extract<WorkerResponse, { type: "result" }>)?.outputs[0];
  check("path separators stripped", out3?.name === "badnamehere.pdf", out3?.name);
}

/* ------------------------------------------------------------------ */
/* 8. i18n — every posted code exists in en + hi                       */
/* ------------------------------------------------------------------ */

console.log("\n── 8. i18n: posted codes exist in BOTH catalogs ─────────");
{
  const en = JSON.parse(read("src/i18n/en.json")) as { tool: Record<string, string> };
  const hi = JSON.parse(read("src/i18n/hi.json")) as { tool: Record<string, string> };
  const codes = ["tool.errorEncrypted", "tool.errorCorrupt", "tool.errorInvalidPages"];
  for (const code of codes) {
    check(`${code} in en`, typeof en.tool[code.split(".")[1]] === "string");
    check(`${code} in hi`, typeof hi.tool[code.split(".")[1]] === "string");
  }
  check(
    "tool.errorEncrypted carries {detail} in en",
    en.tool.errorEncrypted.includes("{detail}")
  );
  check(
    "tool.errorEncrypted carries {detail} in hi",
    hi.tool.errorEncrypted.includes("{detail}")
  );
  const workerSrc = read("tools/merge-pdf/worker.ts");
  check(
    "worker maps encrypted inputs to tool.errorEncrypted naming the file",
    workerSrc.includes("detail: file.name") &&
      workerSrc.includes('error.code === "encrypted"') &&
      workerSrc.includes('"tool.errorEncrypted"'),
  );
}

/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */

console.log("\n── 9. P6-d own-engine byte verification ──────────────────");
{
  // The merged output is verified BYTE-LEVEL with BOTH engines: our own
  // parser (structure + content identity against the sources) and pdf-lib
  // as the independent dev-time oracle. alpha "1-2" + blank + beta all →
  // 5 pages with exact content lineage.
  const bytesA = await makePdf(3);
  const bytesB = await makePdf(2);
  const msgs = await drive(
    6110,
    { blankBetween: true, fileRanges: JSON.stringify({ fa: "1-2" }) },
    [new File([bytesA as BlobPart], "alpha.pdf"), new File([bytesB as BlobPart], "beta.pdf")],
    ["fa", "fb"],
  );
  const result = msgs.find(
    (m) => m.type === "result",
  ) as Extract<WorkerResponse, { type: "result" }>;
  check("own-engine run: one result", Boolean(result));
  check(
    "own-engine run: detail.pages === 5 (2 + blank + 2)",
    result?.detail?.pages === 5,
    result?.detail,
  );
  const out = new Uint8Array(await result.outputs[0].blob.arrayBuffer());
  const pages = listPages(parsePdf(out));
  check("own parser: 5 output pages", pages.length === 5, pages.length);
  check(
    "own parser: separator is the pdf-lib-default A4 blank",
    JSON.stringify(pages[2]!.mediaBox) === "[0,0,595.28,841.89]",
    pages[2]!.mediaBox,
  );

  /** /Contents bytes for page i (ref | array-of-refs | direct stream). */
  const contentBytes = (
    doc: ReturnType<typeof parsePdf>,
    list: ReturnType<typeof listPages>,
    i: number,
  ): Uint8Array => {
    const value = list[i]!.dict.get("Contents");
    if (!value) return new Uint8Array(0);
    const readOne = (v: PdfObj): Uint8Array => {
      if (v.k === "stream") return v.raw;
      if (v.k !== "ref") return new Uint8Array(0);
      const s = doc.getObject(v.num);
      return s && s.k === "stream" ? s.raw : new Uint8Array(0);
    };
    if (value.k === "arr") {
      let total = 0;
      const parts = value.items.map(readOne);
      for (const p of parts) total += p.length;
      const joined = new Uint8Array(total);
      let at = 0;
      for (const p of parts) {
        joined.set(p, at);
        at += p.length;
      }
      return joined;
    }
    return readOne(value);
  };
  const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };

  const srcA = parsePdf(bytesA);
  const listA = listPages(srcA);
  const srcB = parsePdf(bytesB);
  const listB = listPages(srcB);
  const outDoc = parsePdf(out);
  const captured = [0, 1, 3, 4].map((i) => contentBytes(outDoc, pages, i));
  check(
    "non-vacuous: all four copied pages carry content bytes",
    captured.every((c) => c.length > 0),
    captured.map((c) => c.length),
  );
  check(
    "page 1 ≡ alpha source page 1 content",
    bytesEqual(captured[0]!, contentBytes(srcA, listA, 0)),
  );
  check(
    "page 2 ≡ alpha source page 2 content",
    bytesEqual(captured[1]!, contentBytes(srcA, listA, 1)),
  );
  check(
    "separator page has EMPTY content",
    contentBytes(outDoc, pages, 2).length === 0,
  );
  check(
    "page 4 ≡ beta source page 1 content",
    bytesEqual(captured[2]!, contentBytes(srcB, listB, 0)),
  );
  check(
    "page 5 ≡ beta source page 2 content",
    bytesEqual(captured[3]!, contentBytes(srcB, listB, 1)),
  );

  const lib = await PDFDocument.load(out);
  check("pdf-lib oracle: reloads 5 pages", lib.getPageCount() === 5);
  check(
    "pdf-lib oracle: separator page width is A4",
    Math.round(lib.getPage(2).getWidth()) === 595,
  );
  check(
    "pdf-lib oracle: first copied page width",
    Math.round(lib.getPage(0).getWidth()) === 300,
  );
}

console.log(`\nsmoke-merge: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("FAILED:", ...failures);
}
// Explicit exit (house convention, smoke-ocr-invoice-extract recipe): the
// worker import keeps async handles alive, so bun would never exit on its own.
process.exit(fail === 0 ? 0 : 1);
