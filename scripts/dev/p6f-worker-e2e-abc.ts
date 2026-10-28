/**
 * P6-f dev-time worker E2E harness — runs the REAL worker modules (imported
 * as plain modules; their `self.onmessage` registration is invoked directly)
 * with real File objects, then byte-verifies the outputs with our parser +
 * pdf-lib (oracle). Latin paths must go through OUR engine; the Devanagari
 * seam stays on the untouched pdf-lib path (browser-only, fetches /fonts).
 *
 * Run: bun scripts/dev/p6f-worker-e2e.ts
 */

import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { listPages, parsePdf } from "../../src/lib/own/pdf";
import { crc32 } from "../../src/lib/own/zip";

interface Collected {
  kind: "result" | "error";
  code?: string;
  outputs?: Array<{ name: string; blob: Blob }>;
  progresses: number[];
}

async function driveWorker(
  modulePath: string,
  request: Record<string, unknown>
): Promise<Collected> {
  const responses: Array<Record<string, unknown>> = [];
  const g = globalThis as unknown as { postMessage?: (r: unknown) => void };
  g.postMessage = (r: unknown) => {
    responses.push(r as Record<string, unknown>);
  };
  (globalThis as unknown as { self: unknown }).self = globalThis;
  const mod = (await import(modulePath)) as {
    onmessage?: (e: { data: unknown }) => void;
  };
  const handler =
    mod.onmessage ??
    (globalThis as unknown as { onmessage?: (e: { data: unknown }) => void }).onmessage;
  if (!handler) throw new Error(`no onmessage in ${modulePath}`);
  handler({ data: request });
  const terminal = await new Promise<Record<string, unknown>>((done) => {
    const tick = (): void => {
      const t = responses.find((r) => r.type === "result" || r.type === "error");
      if (t) done(t);
      else setTimeout(tick, 25);
    };
    tick();
  });
  const progresses = responses
    .filter((r) => r.type === "progress")
    .map((r) => r.pct as number);
  return {
    kind: terminal.type as "result" | "error",
    code: terminal.code as string | undefined,
    outputs: terminal.outputs as Collected["outputs"],
    progresses,
  };
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** Concatenate every content stream of a page (decoded latin1). */
function pageContentText(bytes: Uint8Array, pageIndex: number): string {
  const doc = parsePdf(bytes);
  const page = listPages(doc)[pageIndex]!;
  const contents = page.dict.get("Contents");
  const items = contents?.k === "arr" ? contents.items : contents ? [contents] : [];
  let out = "";
  for (const item of items) {
    if (item.k !== "ref") continue;
    const obj = doc.getObject(item.num);
    if (obj?.k === "stream") out += new TextDecoder("latin1").decode(obj.raw);
  }
  return out;
}

function hex(s: string): string {
  return [...s].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

let pass = 0;
const failures: string[] = [];
function ok(cond: boolean, label: string): void {
  if (cond) {
    pass++;
    console.log(`  ok  ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}`);
  }
}
function eq(got: unknown, want: unknown, label: string): void {
  ok(got === want, `${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

async function main(): Promise<void> {
  // Shared 3-page fixture with distinct page text.
  const libDoc = await PDFDocument.create();
  const helv = await libDoc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++) {
    const page = libDoc.addPage([400, 500]);
    page.drawText(`BASE-PAGE-${i + 1}`, { x: 30, y: 250, font: helv, size: 16 });
  }
  const baseBytes = new Uint8Array(await libDoc.save());
  const basePart = baseBytes.buffer as ArrayBuffer;
  const baseFile = new File([basePart], "p6f-fixture.pdf", {
    type: "application/pdf",
  });

  console.log("== A. add-page-numbers (own engine) ==");
  {
    const res = await driveWorker(
      "../../tools/add-page-numbers/worker.ts",
      {
        type: "run",
        runId: 1,
        toolId: "add-page-numbers",
        options: {},
        files: [baseFile],
      }
    );
    ok(res.kind === "result", "pn: result (not error)");
    if (res.kind === "result" && res.outputs) {
      const out = await bytesOf(res.outputs[0]!.blob);
      ok(
        res.outputs[0]!.name === "p6f-fixture-numbered.pdf",
        `pn: output name (${res.outputs[0]!.name})`
      );
      const back = parsePdf(out);
      eq(listPages(back).length, 3, "pn: 3 pages");
      const c0 = pageContentText(out, 0);
      const c1 = pageContentText(out, 1);
      ok(
        c0.includes("<31> Tj") || c0.includes("<31>Tj"),
        "pn: page 1 stamp hex 31 present"
      );
      ok(
        c1.includes("<32> Tj") || c1.includes("<32>Tj"),
        "pn: page 2 stamp hex 32 present"
      );
      // Existing content: the source fixture's stream is Flate-compressed by
      // pdf-lib — compare the RAW BYTES of the non-ours /Contents entries.
      {
        const src = parsePdf(baseBytes);
        const srcPage = listPages(src)[0]!;
        const srcStreamRef = srcPage.dict.get("Contents");
        const srcStream =
          srcStreamRef?.k === "ref" ? src.getObject(srcStreamRef.num) : undefined;
        const outPage = listPages(back)[0]!;
        const oc = outPage.dict.get("Contents");
        if (oc?.k === "arr" && srcStream?.k === "stream") {
          const kept = oc.items.find((it) => it.k === "ref");
          const keptStream =
            kept?.k === "ref" ? back.getObject(kept.num) : undefined;
          ok(
            keptStream?.k === "stream" &&
              keptStream.raw.length === srcStream.raw.length &&
              keptStream.raw.every((b, i) => b === srcStream.raw[i]),
            "pn: existing content stream byte-identical"
          );
        }
      }
      const res0 = listPages(back)[0]!.dict.get("Resources");
      const resMap = res0?.k === "dict" ? res0.m : undefined;
      const fb = resMap?.get("Font");
      const fMap = fb?.k === "dict" ? fb.m : undefined;
      eq(fMap?.has("F1"), true, "pn: our F1 font in resources");
      const lib = await PDFDocument.load(out);
      eq(lib.getPageCount(), 3, "pn: pdf-lib oracle reload");
      writeFileSync("/tmp/p6f-pn-output.pdf", out);
      ok(res.progresses.length >= 3, `pn: progress events (${res.progresses.length})`);
    }
  }

  console.log("== B. add-header-footer (own engine) ==");
  {
    const res = await driveWorker(
      "../../tools/add-header-footer/worker.ts",
      {
        type: "run",
        runId: 2,
        toolId: "add-header-footer",
        options: {
          hfHeaderLeft: "QUARTERLY REPORT",
          hfFooterRight: "Page {page}",
        },
        files: [new File([new Uint8Array(baseBytes).buffer as ArrayBuffer], "annual.pdf", { type: "application/pdf" })],
      }
    );
    ok(res.kind === "result", "hf: result");
    if (res.kind === "result" && res.outputs) {
      const out = await bytesOf(res.outputs[0]!.blob);
      eq(
        res.outputs[0]!.name,
        "annual-header-footer.pdf",
        "hf: output name"
      );
      const c0 = pageContentText(out, 0);
      ok(
        c0.includes(`<${hex("QUARTERLY REPORT")}> Tj`) ||
          c0.includes(`<${hex("QUARTERLY REPORT")}>Tj`),
        "hf: header text stamped (hex)"
      );
      ok(
        c0.includes(`<${hex("Page 1")}> Tj`) || c0.includes(`<${hex("Page 1")}>Tj`),
        "hf: footer {page} variable resolved"
      );
      const c2 = pageContentText(out, 2);
      ok(
        c2.includes(`<${hex("Page 3")}> Tj`) || c2.includes(`<${hex("Page 3")}>Tj`),
        "hf: per-page counter"
      );
      const lib = await PDFDocument.load(out);
      eq(lib.getPageCount(), 3, "hf: pdf-lib oracle reload");
    }
  }

  console.log("== C. add-watermark text (own engine, behind + opacity) ==");
  {
    const res = await driveWorker(
      "../../tools/add-watermark/worker.ts",
      {
        type: "run",
        runId: 3,
        toolId: "add-watermark",
        options: {
          wmType: "text",
          text: "CONFIDENTIAL",
          position: "center",
          rotation: 45,
          opacity: 0.35,
          behind: true,
        },
        files: [new File([new Uint8Array(baseBytes).buffer as ArrayBuffer], "secret.pdf", { type: "application/pdf" })],
      }
    );
    ok(res.kind === "result", "wm: result");
    if (res.kind === "result" && res.outputs) {
      const out = await bytesOf(res.outputs[0]!.blob);
      eq(res.outputs[0]!.name, "secret-watermarked.pdf", "wm: output name");
      const doc = parsePdf(out);
      const page = listPages(doc)[0]!;
      const contents = page.dict.get("Contents");
      ok(contents?.k === "arr", "wm: contents array");
      if (contents?.k === "arr") {
        eq(contents.items.length, 2, "wm: two streams");
        // BEHIND: ours FIRST.
        const first = contents.items[0]!;
        const stream = first.k === "ref" ? doc.getObject(first.num) : undefined;
        const body = stream?.k === "stream"
          ? new TextDecoder("latin1").decode(stream.raw)
          : "";
        ok(
          body.includes(`<${hex("CONFIDENTIAL")}> Tj`) ||
            body.includes(`<${hex("CONFIDENTIAL")}>Tj`),
          "wm: text hex in the FIRST stream (behind)"
        );
        ok(
          body.includes("0.862745098 0.1490196078 0.1490196078 rg"),
          "wm: default #DC2626 color scaled EXACTLY once (0..1)"
        );
        ok(/\/GS\d+ gs/.test(body), "wm: opacity ExtGState applied");
      }
      const lib = await PDFDocument.load(out);
      eq(lib.getPageCount(), 3, "wm: pdf-lib oracle reload");
    }
  }

  }

main().catch((err) => {
  console.error("E2E CRASH:", err);
  process.exit(1);
});
