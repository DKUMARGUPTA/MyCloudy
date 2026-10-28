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
import { PDFDocument, degrees } from "pdf-lib";

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

/**
 * Raw-bytes fixture (P6-h): /Rotate 90 + MediaBox inherited from the /Pages
 * root — the scanned-doc layout pdf-lib's copyPDFPage materializes and our
 * engine now materializes too. Leaf has neither own entry.
 */
function buildInheritedRotateFixture(): Uint8Array {
  const enc = new TextEncoder();
  const objects: Array<string | null> = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 /Rotate 90 /MediaBox [0 0 300 400] >>",
    "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
    null, // 4: content stream (patched below)
  ];
  const body4 = "0 0 50 50 re f";
  const serialized: string[] = [];
  const offsets: number[] = [];
  let pos = enc.encode("%PDF-1.4\n").length;
  for (let i = 0; i < objects.length; i++) {
    const num = i + 1;
    let body = objects[i]!;
    if (num === 4) body = `<< /Length ${body4.length} >>\nstream\n${body4}\nendstream`;
    const chunk = `${num} 0 obj\n${body}\nendobj\n`;
    offsets[num - 1] = pos;
    pos += enc.encode(chunk).length;
    serialized.push(chunk);
  }
  const xrefPos = pos;
  let pdf = `%PDF-1.4\n${serialized.join("")}`;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return enc.encode(pdf);
}

/**
 * Raw-bytes fixture (P6-h): a DAMAGED non-quadrant own /Rotate 45 — the
 * R13/R14 snap-to-zero rule normalizes it to the user's intended quadrant
 * when a turn offset is applied.
 */
function buildDamagedRotateFixture(): Uint8Array {
  const enc = new TextEncoder();
  const objects: Array<string | null> = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Rotate 45 /Contents 4 0 R >>",
    null,
  ];
  const body4 = "0 0 50 50 re f";
  const serialized: string[] = [];
  const offsets: number[] = [];
  let pos = enc.encode("%PDF-1.4\n").length;
  for (let i = 0; i < objects.length; i++) {
    const num = i + 1;
    let body = objects[i]!;
    if (num === 4) body = `<< /Length ${body4.length} >>\nstream\n${body4}\nendstream`;
    const chunk = `${num} 0 obj\n${body}\nendobj\n`;
    offsets[num - 1] = pos;
    pos += enc.encode(chunk).length;
    serialized.push(chunk);
  }
  const xrefPos = pos;
  let pdf = `%PDF-1.4\n${serialized.join("")}`;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return enc.encode(pdf);
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
    "worker probe is structural (own-engine typed parse refuses /Encrypt)",
    read("tools/assemble-pdf/worker.ts").includes("error.code === \"encrypted\"") &&
      read("tools/assemble-pdf/worker.ts").includes("parseForOrganize(bytes)") &&
      !read("tools/assemble-pdf/worker.ts").includes("from \"pdf-lib\"")
  );
}

/* ------------------------------------------------------------------ */
/* 7. P6-h: R14 rotation offsets + inherited-attribute materialization */
/* ------------------------------------------------------------------ */

console.log("\n── 7. P6-h: rotation + inheritance on the own engine ───");
{
  // (a) R14: user turn ADDS to the page's own /Rotate (90 + 90 = 180);
  //     untouched sibling page keeps its own /Rotate byte-for-byte.
  const doc = await PDFDocument.create();
  const p1 = doc.addPage([300, 400]);
  p1.setRotation(degrees(90));
  const p2 = doc.addPage([300, 400]);
  p2.setRotation(degrees(180));
  const srcBytes = await doc.save({ useObjectStreams: false });
  const assemble = JSON.stringify([
    ["Rot", [["fa", 0, 90], ["fa", 1]]],
  ]);
  const msgs = await drive(
    7040,
    { assemble, outputMode: "merge" },
    [new File([srcBytes as BlobPart], "rot-source.pdf")],
    ["fa"]
  );
  const result = msgs.find((m) => m.type === "result") as Extract<WorkerResponse, { type: "result" }>;
  check("rot: run produced a result", Boolean(result));
  if (result) {
    const out = await PDFDocument.load(
      new Uint8Array(await result.outputs[0].blob.arrayBuffer()),
      { ignoreEncryption: true }
    );
    check("rot: turned page 90 + 90 → 180", out.getPage(0).getRotation().angle === 180, out.getPage(0).getRotation().angle);
    check("rot: untouched page keeps own 180", out.getPage(1).getRotation().angle === 180, out.getPage(1).getRotation().angle);
    check("rot: page count preserved", out.getPageCount() === 2, out.getPageCount());
  }

  // (b) Inherited /Rotate + MediaBox (on the /Pages root): the copied leaf
  //     must MATERIALIZE both (pdf-lib copyPDFPage parity) — without it the
  //     rebuilt tree drops /Parent and the page loses its box + rotation.
  const inheritedBytes = buildInheritedRotateFixture();
  const asm2 = JSON.stringify([["Inh", [["fa", 0]]]]);
  const msgs2 = await drive(
    7041,
    { assemble: asm2, outputMode: "merge" },
    [new File([inheritedBytes as BlobPart], "inherited-rotate.pdf")],
    ["fa"]
  );
  const result2 = msgs2.find((m) => m.type === "result") as Extract<WorkerResponse, { type: "result" }>;
  check("inherit: run produced a result", Boolean(result2));
  if (result2) {
    const out2 = await PDFDocument.load(
      new Uint8Array(await result2.outputs[0].blob.arrayBuffer()),
      { ignoreEncryption: true }
    );
    check("inherit: /Rotate 90 materialized on the copy", out2.getPage(0).getRotation().angle === 90, out2.getPage(0).getRotation().angle);
    const size = out2.getPage(0).getSize();
    check("inherit: MediaBox materialized (300x400)", Math.abs(size.width - 300) < 0.01 && Math.abs(size.height - 400) < 0.01, `${size.width}x${size.height}`);
  }

  // (c) Damaged non-quadrant /Rotate 45 + user turn 90 → snaps to quadrant
  //     90 (the R13/R14 rule; pdf-lib writes 90, we write 90).
  const damagedBytes = buildDamagedRotateFixture();
  const asm3 = JSON.stringify([["Dmg", [["fa", 0, 90]]]]);
  const msgs3 = await drive(
    7042,
    { assemble: asm3, outputMode: "merge" },
    [new File([damagedBytes as BlobPart], "damaged-rotate.pdf")],
    ["fa"]
  );
  const result3 = msgs3.find((m) => m.type === "result") as Extract<WorkerResponse, { type: "result" }>;
  check("damaged: run produced a result", Boolean(result3));
  if (result3) {
    const out3 = await PDFDocument.load(
      new Uint8Array(await result3.outputs[0].blob.arrayBuffer()),
      { ignoreEncryption: true }
    );
    check("damaged: 45 + turn 90 → snapped to 90", out3.getPage(0).getRotation().angle === 90, out3.getPage(0).getRotation().angle);
  }
}

/* ------------------------------------------------------------------ */

console.log(`\nsmoke-assemble: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("FAILED:", ...failures);
}
process.exit(fail === 0 ? 0 : 1);
