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
import { PDFDict, PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import pako from "pako";
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

  console.log("== D. add-watermark logo PNG (own engine) ==");
  {
    const png = makePng([
      [200, 30, 30, 255], [30, 200, 30, 255],
      [30, 30, 200, 120], [200, 200, 30, 120],
    ]);
    const res = await driveWorker(
      "../../tools/add-watermark/worker.ts",
      {
        type: "run",
        runId: 4,
        toolId: "add-watermark",
        options: { wmType: "image", logoScale: 40 },
        files: [new File([new Uint8Array(baseBytes).buffer as ArrayBuffer], "branded.pdf", { type: "application/pdf" })],
        assets: [new File([png.buffer as ArrayBuffer], "logo.png", { type: "image/png" })],
      }
    );
    ok(res.kind === "result", `wm-logo: result (code=${res.code ?? "n/a"})`);
    if (res.kind === "result" && res.outputs) {
      const out = await bytesOf(res.outputs[0]!.blob);
      const doc = parsePdf(out);
      const page = listPages(doc)[0]!;
      const resObj = page.dict.get("Resources");
      const resMap = resObj?.k === "dict" ? resObj.m : undefined;
      const xob = resMap?.get("XObject");
      const xMap = xob?.k === "dict" ? xob.m : undefined;
      const key = xMap?.keys().next().value as string | undefined;
      ok(key !== undefined, "wm-logo: /XObject present");
      const ref = key ? xMap?.get(key) : undefined;
      const img = ref?.k === "ref" ? doc.getObject(ref.num) : undefined;
      ok(img?.k === "stream", "wm-logo: image stream");
      if (img?.k === "stream") {
        eq((img.m.get("Width") as { n: number } | undefined)?.n, 2, "wm-logo: width 2");
        eq((img.m.get("Height") as { n: number } | undefined)?.n, 2, "wm-logo: height 2");
        eq(
          (img.m.get("ColorSpace") as { v: string } | undefined)?.v,
          "DeviceRGB",
          "wm-logo: DeviceRGB"
        );
        ok(img.m.has("SMask"), "wm-logo: alpha SMask present");
      }
      const lib = await PDFDocument.load(out);
      eq(lib.getPageCount(), 3, "wm-logo: pdf-lib oracle reload");
    }
  }

  console.log("== E. error vectors through the REAL workers ==");
  {
    const encrypted = encryptedFixture();
    const res = await driveWorker(
      "../../tools/add-page-numbers/worker.ts",
      {
        type: "run",
        runId: 5,
        toolId: "add-page-numbers",
        options: {},
        files: [new File([new Uint8Array(encrypted).buffer as ArrayBuffer], "locked.pdf", { type: "application/pdf" })],
      }
    );
    eq(res.kind === "error" ? res.code : "none", "tool.errorEncrypted", "pn: encrypted refusal");
    const corrupt = new Uint8Array([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0xff, 0xff,
    ]);
    const res2 = await driveWorker(
      "../../tools/add-watermark/worker.ts",
      {
        type: "run",
        runId: 6,
        toolId: "add-watermark",
        options: { wmType: "text", text: "X" },
        files: [new File([new Uint8Array(corrupt).buffer as ArrayBuffer], "broken.pdf", { type: "application/pdf" })],
      }
    );
    eq(res2.kind === "error" ? res2.code : "none", "tool.errorCorrupt", "wm: corrupt refusal");
    const res3 = await driveWorker(
      "../../tools/add-watermark/worker.ts",
      {
        type: "run",
        runId: 7,
        toolId: "add-watermark",
        options: { wmType: "image", logoScale: 40 },
        files: [new File([new Uint8Array(baseBytes).buffer as ArrayBuffer], "x.pdf", { type: "application/pdf" })],
      }
    );
    eq(
      res3.kind === "error" ? res3.code : "none",
      "tool.errorWatermarkLogoMissing",
      "wm: logo missing refusal"
    );
  }

  console.log("== F. Devanagari through the REAL workers (P6-g own engine) ==");
  {
    // Stub fetch so loadDevanagariBytes() serves the local TTF in-bun.
    const realFetch = globalThis.fetch;
    const devaFont = new Uint8Array(
      await (await import("node:fs/promises")).readFile(
        "/home/z/my-project/public/fonts/NotoSansDevanagari-Regular.ttf",
      ),
    );
    (globalThis as unknown as { fetch: typeof fetch }).fetch = ((
      input: RequestInfo | URL,
    ) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("NotoSansDevanagari")) {
        return Promise.resolve(
          new Response(devaFont.buffer as ArrayBuffer, {
            status: 200,
            headers: { "content-type": "font/ttf" },
          }),
        );
      }
      return realFetch(input as RequestInfo);
    }) as typeof fetch;

    // F.1 watermark with Hindi text
    {
      const res = await driveWorker("../../tools/add-watermark/worker.ts", {
        type: "run",
        runId: 7,
        toolId: "add-watermark",
        options: {
          wmType: "text",
          text: "\u0939\u093f\u0902\u0926\u0940",
          position: "center",
          rotation: 0,
          opacity: 0.35,
          behind: false,
        },
        files: [
          new File([new Uint8Array(baseBytes).buffer as ArrayBuffer], "deva.pdf", {
            type: "application/pdf",
          }),
        ],
      });
      ok(res.kind === "result", `wm-deva: result (code=${res.code ?? "n/a"})`);
      if (res.kind === "result" && res.outputs) {
        const out = await bytesOf(res.outputs[0]!.blob);
        const doc = parsePdf(out);
        const page = listPages(doc)[0]!;
        // /Font in Resources with a Type0 → Identity-H embedded font
        const resObj = page.dict.get("Resources");
        const resMap = resObj?.k === "dict" ? resObj.m : undefined;
        const fonts = resMap?.get("Font");
        ok(fonts?.k === "dict", "wm-deva: /Font present");
        // oracle reload + embedded font structure
        const lib = await PDFDocument.load(out);
        eq(lib.getPageCount(), 3, "wm-deva: pdf-lib oracle reload");
        const objs = [...lib.context.enumerateIndirectObjects()];
        const type0Entry = objs.find(
          ([, o]) =>
            o instanceof PDFDict &&
            String((o as unknown as { get(k: unknown): unknown }).get(PDFName.of("Subtype"))) === "/Type0",
        );
        const type0 = type0Entry?.[1] as unknown as { get(k: unknown): unknown } | undefined;
        ok(!!type0, "wm-deva: Type0 font embedded");
        if (type0) {
          eq(
            String(type0.get(PDFName.of("Encoding"))),
            "/Identity-H",
            "wm-deva: Identity-H",
          );
          const toUni = lib.context.lookup(
            type0.get(PDFName.of("ToUnicode")),
          ) as unknown as { contents: Uint8Array };
          const cmapText = Buffer.from(pako.inflate(toUni.contents)).toString("latin1");
          // reconstruct from the page stamp hex
          const text = pageContentText(out, 0);
          const hexM = /<([0-9a-fA-F]+)> Tj/.exec(text);
          ok(!!hexM, "wm-deva: stamp Tj found");
          const hex = hexM?.[1] ?? "";
          const bfChars = [...cmapText.matchAll(/<([0-9a-fA-F]{4})> <([0-9a-fA-F]*)>/g)];
          let reconstructed = "";
          for (let i = 0; i + 4 <= hex.length; i += 4) {
            const sidHex = hex.slice(i, i + 4).toLowerCase();
            const entry = bfChars.find(([, sid]) => sid.toLowerCase() === sidHex);
            const cpsHex = entry?.[2] ?? "";
            for (let j = 0; j + 4 <= cpsHex.length; j += 4) {
              reconstructed += String.fromCharCode(parseInt(cpsHex.slice(j, j + 4), 16));
            }
          }
          // pdf-lib's own ToUnicode round-trip reconstructs the VISUAL glyph
          // order (the ि reordering) — proven identical on the oracle output
          // at dev time. Check the glyph-content multiset (same class as
          // pdf-lib), not the logical order.
          const original = "\u0939\u093f\u0902\u0926\u0940";
          const sortCps = (t: string): string =>
            [...t].map((c) => c.codePointAt(0)!.toString(16)).sort().join(",");
          eq(sortCps(reconstructed), sortCps(original), `wm-deva: ToUnicode round-trip multiset (${reconstructed} = pdf-lib's visual-order class)`);
        }
      }
    }

    // F.2 page numbers with Hindi digits
    {
      const res = await driveWorker("../../tools/add-page-numbers/worker.ts", {
        type: "run",
        runId: 8,
        toolId: "add-page-numbers",
        options: { format: "plain", hindiDigits: true, position: "bottom-center", size: 12 },
        files: [
          new File([new Uint8Array(baseBytes).buffer as ArrayBuffer], "ank.pdf", {
            type: "application/pdf",
          }),
        ],
      });
      ok(res.kind === "result", `pn-deva: result (code=${res.code ?? "n/a"})`);
      if (res.kind === "result" && res.outputs) {
        const out = await bytesOf(res.outputs[0]!.blob);
        const lib = await PDFDocument.load(out);
        eq(lib.getPageCount(), 3, "pn-deva: pdf-lib oracle reload");
        const text1 = pageContentText(out, 0);
        ok(/\/[A-Za-z]\d+ 12 Tf/.test(text1), "pn-deva: Tf present");
        const hexM = /<([0-9a-fA-F]+)> Tj/.exec(text1);
        ok(!!hexM, "pn-deva: Hindi digit Tj present");
      }
    }

    (globalThis as unknown as { fetch: typeof fetch }).fetch = realFetch;
  }

  console.log(`\np6f-worker-e2e: ${pass} passed, ${failures.length} failed`);
  // The imported worker chain keeps an invisible handle alive in bun
  // (import-time side effects); the verdict is complete here, so exit
  // explicitly — the exit code still reflects the failures.
  process.exit(failures.length > 0 ? 1 : 0);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

function makePng(pixels: Array<[number, number, number, number]>): Uint8Array {
  const raw: number[] = [];
  for (let y = 0; y < 2; y++) {
    raw.push(0);
    for (let x = 0; x < 2; x++) {
      const p = pixels[y * 2 + x]!;
      raw.push(p[0], p[1], p[2], p[3]);
    }
  }
  const idat = deflateSync(new Uint8Array(raw));
  const parts: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const chunk = (type: string, data: number[]): void => {
    const len = data.length;
    parts.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
    for (const c of type) parts.push(c.charCodeAt(0));
    for (const b of data) parts.push(b & 0xff);
    const crcInput = new Uint8Array([
      ...[...type].map((c) => c.charCodeAt(0)),
      ...data,
    ]);
    const crc = crc32(crcInput);
    parts.push((crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff);
  };
  const ihdr = [0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0];
  chunk("IHDR", ihdr);
  chunk("IDAT", [...idat]);
  chunk("IEND", []);
  return new Uint8Array(parts);
}

/** Minimal /Encrypt-flagged PDF (refuses without a password). */
function encryptedFixture(): Uint8Array {
  const enc = new TextEncoder();
  return enc.encode(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` +
      `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n` +
      `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n` +
      `4 0 obj\n<< /Filter /Standard /V 1 /R 2 /O (x) /U (y) /P -1 >>\nendobj\n` +
      `xref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n` +
      `0000000062 00000 n \n0000000119 00000 n \n0000000184 00000 n \n` +
      `trailer\n<< /Size 5 /Root 1 0 R /Encrypt 4 0 R /ID [<a><b>] >>\n` +
      `startxref\n248\n%%EOF\n`
  );
}

main().catch((err) => {
  console.error("E2E CRASH:", err);
  process.exit(1);
});
