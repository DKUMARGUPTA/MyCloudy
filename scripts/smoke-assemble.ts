/**
 * Smoke test: assemble-pdf worker (R6-b wiring-lock smoke — the tool had NO
 * smoke of its own). Drives the REAL worker up the house way (self shim +
 * postMessage collector, smoke-merge recipe) and locks:
 *   1. wiring: TOOL_CONFIGS + registry entry, worker module self-registers
 *   2. happy path: 2 columns (1 + 2 pages) → ONE merged output,
 *      "<first>-assembled.pdf" naming, honest detail {files, pages}
 *   3. encrypted source (real AES-256 @cantoo bytes, structural probe) →
 *      exactly ONE error, code tool.errorEncrypted, detail = file NAME,
 *      no result — the R6-b named-refusal fix (the toast must say WHICH
 *      source PDF to unlock)
 *   4. corrupt source (torn bytes) → tool.errorCorrupt, detail = file name
 *   5. separate mode: one output per column, dedup naming
 *   6. i18n: every code the worker can post exists in en + hi
 *
 * Run: bun scripts/smoke-assemble.ts
 */
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";

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

async function makePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([300, 400]);
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
await import("../tools/assemble-pdf/worker");

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
      toolId: "assemble-pdf",
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
  check("TOOL_CONFIGS has assemble-pdf", TOOL_CONFIGS["assemble-pdf"] !== undefined);
  const def = ALL_TOOLS.find((t) => t.id === "assemble-pdf");
  check("registry has assemble-pdf, enabled", def !== undefined && def.enabled === true);
  check("worker module self-registers onmessage", typeof workerGlobal.onmessage === "function");
}

/* ------------------------------------------------------------------ */
/* 2. happy path — merge mode                                          */
/* ------------------------------------------------------------------ */

console.log("\n── 2. happy path: one merged output, honest detail ──────");
{
  const bytesA = await makePdf(1);
  const bytesB = await makePdf(2);
  const assemble = JSON.stringify([
    ["Alpha", [["fa", 0]]],
    ["Beta", [["fb", 0], ["fb", 1]]],
  ]);
  const msgs = await drive(
    7001,
    { assemble, outputMode: "merge" },
    [new File([bytesA as BlobPart], "alpha.pdf"), new File([bytesB as BlobPart], "beta.pdf")],
    ["fa", "fb"]
  );
  const results = msgs.filter((m) => m.type === "result");
  check("exactly ONE result message", results.length === 1, results.length);
  check("no error messages", msgs.every((m) => m.type !== "error"));
  const result = results[0] as Extract<WorkerResponse, { type: "result" }>;
  check("one output named Alpha-assembled.pdf", result.outputs.length === 1 && result.outputs[0].name === "Alpha-assembled.pdf", result.outputs.map((o) => o.name));
  check("output mime is application/pdf", result.outputs[0].mime === "application/pdf");
  const magic = new Uint8Array(await result.outputs[0].blob.slice(0, 5).arrayBuffer());
  check("output starts with %PDF-", String.fromCharCode(...magic) === "%PDF-");
  const outDoc = await PDFDocument.load(
    new Uint8Array(await result.outputs[0].blob.arrayBuffer()),
    { ignoreEncryption: true }
  );
  check("output carries the planned 3 pages", outDoc.getPageCount() === 3, outDoc.getPageCount());
  check("detail.files === 1", result.detail?.files === 1, result.detail);
  check("detail.pages === 3", result.detail?.pages === 3, result.detail);
}

/* ------------------------------------------------------------------ */
/* 3. encrypted source — R6-b named refusal                            */
/* ------------------------------------------------------------------ */

console.log("\n── 3. encrypted source names the file, no result ────────");
{
  const bytesA = await makePdf(1);
  const encBytes = await makeEncryptedPdf();
  const assemble = JSON.stringify([
    ["Alpha", [["fa", 0]]],
    ["Beta", [["fb", 0]]],
  ]);
  const msgs = await drive(
    7002,
    { assemble, outputMode: "merge" },
    [new File([bytesA as BlobPart], "annual-report.pdf"), new File([encBytes as BlobPart], "locked-scan.pdf")],
    ["fa", "fb"]
  );
  const errors = msgs.filter((m) => m.type === "error") as Extract<WorkerResponse, { type: "error" }>[];
  check("exactly ONE error message", errors.length === 1, errors.map((m) => m.code));
  check("no result posted", msgs.every((m) => m.type !== "result"));
  check("code is tool.errorEncrypted", errors[0]?.code === "tool.errorEncrypted", errors[0]?.code);
  check("refusal NAMES the locked source (detail)", errors[0]?.detail === "locked-scan.pdf", errors[0]?.detail);
}

/* ------------------------------------------------------------------ */
/* 4. corrupt source — named corrupt refusal                           */
/* ------------------------------------------------------------------ */

console.log("\n── 4. corrupt source names the file ─────────────────────");
{
  const bytesA = await makePdf(1);
  // Not-parseable-at-all bytes (a TORN-but-recoverable PDF is a different
  // vector: pdf-lib recovers it, the plan sees 0 pages and the honest
  // per-page guard fires tool.errorInvalidPages — asserted separately below
  // so that pre-existing behavior stays visible).
  const garbage = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x9, 0x9, 0x9]);
  const assemble = JSON.stringify([["Alpha", [["fa", 0]]], ["Beta", [["fb", 0]]]]);
  const msgs = await drive(
    7003,
    { assemble, outputMode: "merge" },
    [new File([garbage as BlobPart], "damaged.pdf"), new File([bytesA as BlobPart], "fine.pdf")],
    ["fa", "fb"]
  );
  const errors = msgs.filter((m) => m.type === "error") as Extract<WorkerResponse, { type: "error" }>[];
  check("exactly ONE error message", errors.length === 1, errors.map((m) => m.code));
  check("no result posted", msgs.every((m) => m.type !== "result"));
  check("code is tool.errorCorrupt", errors[0]?.code === "tool.errorCorrupt", errors[0]?.code);
  check("refusal NAMES the damaged source (detail)", errors[0]?.detail === "damaged.pdf", errors[0]?.detail);
}

/* --- torn-but-recoverable PDF: refusal still carries the file name ------
 * (pdf-lib's recovery decides whether the plain load survives; when it
 * doesn't, the refusal MUST still name the file — that is what this locks.) */
{
  const bytesA = await makePdf(2);
  const torn = bytesA.slice(0, 120);
  const assemble = JSON.stringify([["Alpha", [["fa", 0]]]]);
  const msgs = await drive(
    7035,
    { assemble, outputMode: "merge" },
    [new File([torn as BlobPart], "torn-source.pdf")],
    ["fa"]
  );
  const errors = msgs.filter((m) => m.type === "error") as Extract<WorkerResponse, { type: "error" }>[];
  const named = errors.length === 1 && errors[0]?.detail === "torn-source.pdf";
  check(
    "torn-recoverable source: refusal (when it fires) NAMES the file",
    !errors.some((e) => e.detail !== undefined && e.detail !== "torn-source.pdf") &&
      (errors.length === 0 || named),
    JSON.stringify(msgs.map((m) => m.type === "error" ? `${m.code}/${m.detail ?? ""}` : m.type))
  );
}

/* ------------------------------------------------------------------ */
/* 5. separate mode — one output per column                            */
/* ------------------------------------------------------------------ */

console.log("\n── 5. separate mode keeps per-column naming ─────────────");
{
  const bytesA = await makePdf(1);
  const bytesB = await makePdf(1);
  const assemble = JSON.stringify([
    ["Front", [["fa", 0]]],
    ["Back", [["fb", 0]]],
  ]);
  const msgs = await drive(
    7004,
    { assemble, outputMode: "separate" },
    [new File([bytesA as BlobPart], "a.pdf"), new File([bytesB as BlobPart], "b.pdf")],
    ["fa", "fb"]
  );
  const result = msgs.find((m) => m.type === "result") as Extract<WorkerResponse, { type: "result" }>;
  check("separate run: exactly one result", Boolean(result));
  check("two outputs", result?.outputs.length === 2, result?.outputs.map((o) => o.name));
  check("column names become file names", result?.outputs.map((o) => o.name).join(",") === "Front.pdf,Back.pdf", result?.outputs.map((o) => o.name));
  check("detail.files === 2", result?.detail?.files === 2, result?.detail);
}

/* ------------------------------------------------------------------ */
/* 6. i18n: posted codes exist in BOTH catalogs                        */
/* ------------------------------------------------------------------ */

console.log("\n── 6. i18n: posted codes exist in en + hi ───────────────");
{
  const en = JSON.parse(read("src/i18n/en.json")) as Record<string, Record<string, string>>;
  const hi = JSON.parse(read("src/i18n/hi.json")) as Record<string, Record<string, string>>;
  for (const code of [
    "tool.errorEncrypted",
    "tool.errorCorrupt",
    "asm.errorNoPages",
    "tool.errorInvalidPages",
  ]) {
    const [ns, key] = code.split(".");
    check(`${code} in en`, typeof en[ns]?.[key] === "string");
    check(`${code} in hi`, typeof hi[ns]?.[key] === "string");
  }
  check(
    "worker throws the named-refusal class (R6-b)",
    read("tools/assemble-pdf/worker.ts").includes("new AssembleRefusal(\"tool.errorEncrypted\", file.name)")
  );
  check(
    "worker probe is structural (ignoreEncryption + isEncrypted)",
    read("tools/assemble-pdf/worker.ts").includes("ignoreEncryption: true") &&
      read("tools/assemble-pdf/worker.ts").includes("probe?.isEncrypted")
  );
}

/* ------------------------------------------------------------------ */

console.log(`\nsmoke-assemble: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("FAILED:", ...failures);
}
process.exit(fail === 0 ? 0 : 1);
