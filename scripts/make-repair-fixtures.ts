/**
 * QA fixtures for repair-pdf (and its browser QA).
 *
 *   healthy.pdf      — 3-page pdf-lib doc, no damage          (expected: healthy)
 *   broken-xref.pdf  — the xref+trailer region replaced by
 *                      spaces; all objects intact              (rebuilt, 3 pages)
 *   truncated.pdf    — file cut mid-way, last page + xref gone (rebuilt, fewer
 *                      pages, page tree pruned)
 *   objstm-broken.pdf— saved WITH object streams, then the tail from the
 *                      /Type/XRef stream onwards is cut         (rebuilt, ObjStm
 *                      materialisation, 3 pages)
 *   encrypted.pdf    — AES-256 locked via @cantoo/pdf-lib      (refused)
 *   garbage.pdf      — not a PDF at all                        (refused)
 *
 * Run: bun scripts/make-repair-fixtures.ts
 */
import fs from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";

const OUT_DIR = "public/qa/repair-fixtures";

function latin1(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

function toBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

async function buildDoc(objectStreams: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= 3; p += 1) {
    const page = doc.addPage([380, 260]);
    page.drawText(`Repair fixture page ${p} of three`, {
      x: 24,
      y: 200,
      size: 14,
      font,
    });
  }
  return doc.save({ useObjectStreams: objectStreams });
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  /* ---------- healthy ---------- */
  const healthy = await buildDoc(false);
  fs.writeFileSync(path.join(OUT_DIR, "healthy.pdf"), healthy);

  /* ---------- broken-xref: every in-use xref offset → 9 ---------- */
  {
    const damaged = latin1(healthy).replace(
      /(\d{10}) 00000 n /g,
      "0000000009 00000 n "
    );
    fs.writeFileSync(path.join(OUT_DIR, "broken-xref.pdf"), toBytes(damaged));
  }

  /* ---------- broken-tail: destroy from the "xref" keyword onwards ---------- */
  {
    const text = latin1(healthy);
    const xrefIdx = text.lastIndexOf("\nxref");
    if (xrefIdx < 0) throw new Error("xref marker not found");
    const damaged =
      text.slice(0, xrefIdx + 1) + " ".repeat(text.length - xrefIdx - 1);
    fs.writeFileSync(path.join(OUT_DIR, "broken-tail.pdf"), toBytes(damaged));
  }

  /* ---------- truncated: cut mid-file (last page + xref lost) ---------- */
  {
    const text = latin1(healthy);
    const cut = Math.floor(text.length * 0.55);
    const truncated = text.slice(0, cut);
    fs.writeFileSync(
      path.join(OUT_DIR, "truncated.pdf"),
      toBytes(truncated)
    );
  }

  /* ---------- objstm-broken: cut from the /Type/XRef stream object ---------- */
  {
    const objstm = await buildDoc(true);
    const text = latin1(objstm);
    // The xref stream is the LAST object — find "/Type /XRef" and cut from
    // the "N 0 obj" that opens it.
    const xrefDict = text.indexOf("/Type /XRef");
    if (xrefDict < 0) throw new Error("XRef stream not found");
    // The xref stream is the LAST object — the last "N 0 obj" before
    // its /Type /XRef opens it.
    const before = text.slice(0, xrefDict);
    let objStart = -1;
    let objNumLen = 0;
    for (const m of before.matchAll(/(\d+)\s+0\s+obj\b/g)) {
      objStart = m.index;
      objNumLen = m[1].length;
    }
    if (objStart < 0) throw new Error("XRef object header not found");
    const cutAt = objStart + objNumLen;
    fs.writeFileSync(
      path.join(OUT_DIR, "objstm-broken.pdf"),
      toBytes(text.slice(0, cutAt))
    );
  }

  /* ---------- encrypted ---------- */
  {
    const doc = await PDFDocument.load(healthy, { updateMetadata: false });
    await doc.encrypt({
      userPassword: "docopdf-qa",
      ownerPassword: "docopdf-qa",
      algorithm: "AES-256",
    });
    fs.writeFileSync(path.join(OUT_DIR, "encrypted.pdf"), await doc.save());
  }

  /* ---------- garbage ---------- */
  fs.writeFileSync(
    path.join(OUT_DIR, "garbage.pdf"),
    Buffer.from("this is not a pdf, just bytes pretending.", "latin1")
  );

  console.log("repair fixtures written to", OUT_DIR);
}

void main();
