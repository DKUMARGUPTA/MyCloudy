/**
 * Smoke: ocr-pdf encrypted-input guard (FIX-1b / AUD-C bug #2).
 *
 * The bug: owner-restricted (empty user password) PDFs open silently in
 * pdf.js, but pdf-lib CANNOT decrypt — the searchable-mode pass-through
 * copied still-encrypted content streams into a fresh document that has no
 * /Encrypt dictionary, silently corrupting every passed-through page.
 *
 * The fix: a STRUCTURAL trailer probe (pdf-lib ignoreEncryption load +
 * isEncrypted) refuses every mode with tool.errorEncrypted before any
 * pdf.js / pass-through work runs.
 *
 * This drives the REAL worker through a self-shimmed globalThis (the
 * smoke-pdf-to-pdfa recipe): the encrypted refusal fires before pdf.js or
 * tesseract load, so no canvas/OCR machinery is needed under bun. The
 * plain-fixture drive at the end passes the guard and then dies later, at
 * bun's pdf.js asset import — proving the refusal is what changed, and
 * that the probe does not false-positive on literal "/Encrypt" text.
 *
 * Run: bun scripts/smoke-ocr-encrypted.ts
 */
import { inflateSync } from "node:zlib";
import { PDFDocument as CantooDoc } from "@cantoo/pdf-lib";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  StandardFonts,
} from "pdf-lib";
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

/** repair-pdf's raw sniff shape — used here only to show it would fire. */
const TRAILER_SNIFF_RE = /\/Encrypt[ \t\r\n\f\x00]+[0-9]+[ \t\r\n\f\x00]+[0-9]+[ \t\r\n\f\x00]+R/;
const FILTER_SNIFF_RE = /\/Filter[ \t\r\n\f\x00]*\/Standard(?![a-zA-Z])/;

/** First content stream of a page (raw stored bytes, pre-inflate). */
const pageContentBytes = (
  doc: PDFDocument,
  pageIndex: number
): Uint8Array => {
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
  return streams[0]!.contents;
};

async function main(): Promise<void> {
  /* ---- fixtures ------------------------------------------------------ */
  const typedPlain = await (async () => {
    const doc = await CantooDoc.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([595.28, 841.89]);
    page.drawText("Owner restricted typed page 9350 rupees.", {
      x: 50,
      y: 760,
      size: 14,
      font,
    });
    return new Uint8Array(await doc.save({ useObjectStreams: false }));
  })();

  /** Owner-restricted: empty user password — pdf.js opens it silently. */
  const encryptOwnerOnly = async (
    bytes: Uint8Array
  ): Promise<Uint8Array> => {
    const doc = await CantooDoc.load(bytes);
    await doc.encrypt({
      userPassword: "",
      ownerPassword: "owner-secret-9",
      permissions: {
        printing: "highResolution",
        copying: false,
        modifying: false,
      },
    });
    return new Uint8Array(await doc.save({ useObjectStreams: false }));
  };

  const ownerOnly = await encryptOwnerOnly(typedPlain);

  // Pure-scan shape: a page with no selectable text, owner-restricted too.
  const ownerOnlyScan = await (async () => {
    const doc = await CantooDoc.create();
    const page = doc.addPage([595.28, 841.89]);
    page.drawRectangle({ x: 40, y: 40, width: 500, height: 700 });
    return encryptOwnerOnly(
      new Uint8Array(await doc.save({ useObjectStreams: false }))
    );
  })();

  // User-password-locked (the shape pdf.js refuses outright).
  const userLocked = await (async () => {
    const doc = await CantooDoc.load(typedPlain);
    await doc.encrypt({ userPassword: "secret", algorithm: "AES-256" });
    return new Uint8Array(await doc.save({ useObjectStreams: false }));
  })();

  // Decoy: PLAIN pdf whose UNCOMPRESSED content stream literally says
  // "/Encrypt 26 0 R" + "/Filter /Standard" — a raw-bytes sniff (the
  // repair-pdf pattern applied naively) would refuse this honest file.
  const decoy = await (async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    const streamDict = PDFDict.withContext(doc.context);
    const content = new TextEncoder().encode(
      "BT /F1 10 Tf 20 280 Td (trailer: /Encrypt 26 0 R /Filter /Standard) Tj ET"
    );
    const contents = doc.context.register(
      PDFRawStream.of(streamDict, content)
    );
    page.node.set(PDFName.of("Contents"), contents);
    page.node.set(
      PDFName.of("Resources"),
      doc.context.obj({
        Font: {
          F1: {
            Type: PDFName.of("Font"),
            Subtype: PDFName.of("Type1"),
            BaseFont: PDFName.of("Helvetica"),
          },
        },
      })
    );
    return new Uint8Array(await doc.save({ useObjectStreams: false }));
  })();

  /* ---- fixture sanity + the pre-fix corruption, demonstrated ---------- */
  console.log("── 1. fixtures + the corruption we now refuse ──────────");
  {
    const latin = new TextDecoder("latin1").decode(ownerOnly);
    check(
      "fixture: owner-only bytes carry /Encrypt (trailer ref)",
      TRAILER_SNIFF_RE.test(latin)
    );
    const probe = await PDFDocument.load(ownerOnly, {
      ignoreEncryption: true,
    });
    check(
      "fixture: pdf-lib structural probe reports isEncrypted",
      probe.isEncrypted === true
    );

    // The old pass-through, replayed: copy the still-encrypted page into a
    // fresh doc and save — the output has no /Encrypt and its content
    // stream is ciphertext that no longer inflates. That is the file
    // readers cannot open; the guard refuses to ever emit it.
    const victim = await PDFDocument.create();
    const [copied] = await victim.copyPages(probe, [0]);
    victim.addPage(copied);
    const outBytes = new Uint8Array(await victim.save());
    const outLatin = new TextDecoder("latin1").decode(outBytes);
    check(
      "corruption demo: the pass-through re-save LOST the /Encrypt dict",
      !TRAILER_SNIFF_RE.test(outLatin)
    );
    let ciphertext = false;
    try {
      inflateSync(pageContentBytes(await PDFDocument.load(outBytes), 0));
    } catch {
      ciphertext = true;
    }
    check(
      "corruption demo: the reloaded output's content stream no longer inflates (ciphertext)",
      ciphertext
    );

    const decoyLatin = new TextDecoder("latin1").decode(decoy);
    check(
      "decoy: literal /Encrypt text present — a raw sniff WOULD fire",
      TRAILER_SNIFF_RE.test(decoyLatin) && FILTER_SNIFF_RE.test(decoyLatin)
    );
    const decoyProbe = await PDFDocument.load(decoy);
    check(
      "decoy: the structural probe does NOT flag it",
      decoyProbe.isEncrypted === false
    );
  }

  /* ---- the real worker, driven ---------------------------------------- */
  console.log("── 2. REAL worker drives (shimmed self) ─────────────────");
  {
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
    await import("../tools/ocr-pdf/worker");
    check(
      "worker: module loaded, onmessage registered",
      typeof workerGlobal.onmessage === "function"
    );

    const drive = async (
      runId: number,
      options: Record<string, string | number | boolean>,
      fileBytes: Uint8Array,
      fileName: string
    ): Promise<WorkerResponse> => {
      const before = messages.length;
      workerGlobal.onmessage!({
        data: {
          type: "run",
          runId,
          toolId: "ocr-pdf",
          options,
          files: [new File([fileBytes as BlobPart], fileName)],
        } as WorkerRunRequest,
      });
      const deadline = Date.now() + 30_000;
      for (;;) {
        if (
          messages
            .slice(before)
            .some(
              (m) =>
                m.runId === runId && (m.type === "result" || m.type === "error")
            )
        ) {
          break;
        }
        if (Date.now() > deadline) {
          throw new Error(`worker run ${runId} did not finish`);
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      return messages
        .slice(before)
        .find(
          (m) =>
            m.runId === runId && (m.type === "result" || m.type === "error")
        )!;
    };

    const searchable: Record<string, string | number | boolean> = {
      languages: "eng",
      dpi: "150",
      output: "searchable",
      pages: "all",
      skipText: true,
      pageMarks: true,
    };
    const textMode = { ...searchable, output: "text" };
    const isEncryptedRefusal = (m: WorkerResponse): boolean =>
      m.type === "error" && m.code === "tool.errorEncrypted";

    // 1. THE AUD-C REPRO: owner-restricted + selectable text + searchable
    //    mode — the exact input that used to emit corrupted pages.
    const r1 = await drive(1, searchable, ownerOnly, "owner-only.pdf");
    check(
      "worker: owner-only typed + searchable → tool.errorEncrypted (was: silent corruption)",
      isEncryptedRefusal(r1),
      r1
    );

    // 2. Text mode — same refusal, no pdf-lib output ever written.
    const r2 = await drive(2, textMode, ownerOnly, "owner-only.pdf");
    check(
      "worker: owner-only + text mode → same refusal",
      isEncryptedRefusal(r2),
      r2
    );

    // 3. Pure-scan hybrid shape (no selectable text) — refused before the
    //    srcDoc/pass-through decision is even reached.
    const r3 = await drive(3, searchable, ownerOnlyScan, "scan.pdf");
    check(
      "worker: owner-only pure-scan shape → same refusal",
      isEncryptedRefusal(r3),
      r3
    );

    // 4. User-password-locked — was already refused (pdf.js PasswordException
    //    → catch); now the guard catches it first, same code.
    const r4 = await drive(4, searchable, userLocked, "user-locked.pdf");
    check(
      "worker: user-password locked → same refusal",
      isEncryptedRefusal(r4),
      r4
    );

    // 5. The decoy: guard must NOT fire. In bun the run then dies at the
    //    self-hosted pdf.js asset import (no /pdfjs in this process) — any
    //    error EXCEPT tool.errorEncrypted proves the run got past the guard.
    const r5 = await drive(5, searchable, decoy, "decoy.pdf");
    check(
      "worker: decoy (literal /Encrypt text) NOT refused as encrypted — run proceeded past the guard",
      r5.type === "error" && r5.code !== "tool.errorEncrypted",
      r5
    );

    // 6. Non-run messages are ignored.
    const before = messages.length;
    workerGlobal.onmessage!({ data: { type: "nonsense" } as never });
    await new Promise((r) => setTimeout(r, 25));
    check(
      "worker: non-run message ignored (no new worker responses)",
      messages.length === before
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error("failed:", failures);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
