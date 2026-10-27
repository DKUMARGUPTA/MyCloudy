/**
 * DocoPDF own PDF micro-engine — writer (P6-a).
 *
 * Emits a fresh, strictly-shaped classic-xref PDF from a page plan:
 *  - new objects (catalog, /Pages tree, blank pages + their empty content
 *    streams) numbered first, then the reachable graphs of every copied
 *    page in deterministic BFS discovery order
 *  - copied page dicts are caller-CLONED (no /Parent) — this writer never
 *    mutates parsed source graphs
 *  - content streams pass through BYTE-EXACT (raw subarray views, /Length
 *    rewritten to the raw length)
 *  - unresolvable refs serialize as `null` (spec-legal placeholder) so one
 *    dangling source object can never corrupt the output
 *  - document-level extras (Outlines/Names/StructTree/AcroForm catalog
 *    entries) are intentionally NOT carried — same behavior class as
 *    pdf-lib copyPages (the engine seam parity contract)
 */

import {
  type PdfObj,
  type PdfRef,
  collectRefs,
  pdfNameToString,
  pdfNumToString,
  pdfStringToHex,
} from "./objects";
import { type ParsedPdf } from "./parser";

export type WritePage =
  | {
      /** Copied source page — `dict` is a pre-cloned map WITHOUT /Parent. */
      type: "copy";
      doc: ParsedPdf;
      /** Original page object number (lets annotations' /P back-refs remap). */
      srcNum: number;
      dict: Map<string, PdfObj>;
    }
  | { type: "blank"; width: number; height: number };

const ENC = new TextEncoder();

class ByteSink {
  private chunks: Uint8Array[] = [];
  length = 0;

  bytes(b: Uint8Array): void {
    if (b.length === 0) return;
    this.chunks.push(b);
    this.length += b.length;
  }

  text(s: string): void {
    this.bytes(ENC.encode(s));
  }

  toUint8Array(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

interface EmitEntry {
  /** Source doc for ref remapping (undefined for pure synthetics). */
  doc?: ParsedPdf;
  obj: PdfObj;
}

function serialize(
  sink: ByteSink,
  obj: PdfObj,
  mapRef: (doc: ParsedPdf | undefined, r: PdfRef) => number | undefined,
  doc: ParsedPdf | undefined,
): void {
  switch (obj.k) {
    case "num":
      sink.text(pdfNumToString(obj.n));
      return;
    case "bool":
      sink.text(obj.b ? "true" : "false");
      return;
    case "null":
      sink.text("null");
      return;
    case "name":
      sink.text(pdfNameToString(obj.v));
      return;
    case "str":
      sink.text(pdfStringToHex(obj.b));
      return;
    case "ref": {
      const newNum = mapRef(doc, obj);
      if (newNum === undefined) sink.text("null");
      else sink.text(`${newNum} 0 R`);
      return;
    }
    case "arr": {
      sink.text("[ ");
      for (let i = 0; i < obj.items.length; i++) {
        if (i > 0) sink.text(" ");
        serialize(sink, obj.items[i]!, mapRef, doc);
      }
      sink.text(" ]");
      return;
    }
    case "dict": {
      sink.text("<<");
      for (const [key, value] of obj.m) {
        sink.text(` ${pdfNameToString(key)} `);
        serialize(sink, value, mapRef, doc);
      }
      sink.text(" >>");
      return;
    }
    case "stream": {
      // /Length is rewritten to the RAW body length (we pass bytes through
      // undecoded — the declared length must match what we emit).
      sink.text("<<");
      for (const [key, value] of obj.m) {
        if (key === "Length") continue;
        sink.text(` ${pdfNameToString(key)} `);
        serialize(sink, value, mapRef, doc);
      }
      sink.text(` /Length ${obj.raw.length} >>\nstream\n`);
      sink.bytes(obj.raw);
      sink.text("\nendstream");
      return;
    }
  }
}

/**
 * Build the output document. Deterministic numbering:
 *   1 = catalog, 2 = /Pages tree, then each page dict (and each blank
 *   page's content stream) in plan order, then BFS-copied graphs.
 */
export function writeDocument(pages: WritePage[], version?: string): Uint8Array {
  const map = new Map<string, number>(); // `${docIdx}:${srcNum}` → new num
  const emit: EmitEntry[] = [];
  const docIdx = new Map<ParsedPdf, number>();
  for (const p of pages) {
    if (p.type === "copy" && !docIdx.has(p.doc)) {
      docIdx.set(p.doc, docIdx.size);
    }
  }

  const catalogNum = 1;
  const pagesTreeNum = 2;
  let next = 3;
  const kids: PdfObj[] = [];

  // ── page objects (synthetics) ──
  for (const p of pages) {
    if (p.type === "copy") {
      const newNum = next++;
      map.set(`${docIdx.get(p.doc)}:${p.srcNum}`, newNum);
      emit.push({ doc: p.doc, obj: { k: "dict", m: p.dict } });
      kids.push({ k: "ref", num: newNum, gen: 0 });
    } else {
      // Blank page: dict + empty content stream, both synthetic.
      const dictNum = next++;
      const streamNum = next++;
      const pageDict = new Map<string, PdfObj>([
        ["Type", { k: "name", v: "Page" }],
        ["Parent", { k: "ref", num: pagesTreeNum, gen: 0 }],
        [
          "MediaBox",
          {
            k: "arr",
            items: [
              { k: "num", n: 0 },
              { k: "num", n: 0 },
              { k: "num", n: p.width },
              { k: "num", n: p.height },
            ],
          },
        ],
        ["Resources", { k: "dict", m: new Map() }],
        ["Contents", { k: "ref", num: streamNum, gen: 0 }],
      ]);
      const emptyStream: PdfObj = {
        k: "stream",
        m: new Map<string, PdfObj>([["Length", { k: "num", n: 0 }]]),
        raw: new Uint8Array(0),
      };
      emit.push({ obj: { k: "dict", m: pageDict } });
      emit.push({ obj: emptyStream });
      kids.push({ k: "ref", num: dictNum, gen: 0 });
    }
  }

  // ── BFS over reachable source graphs ──
  const queue: Array<{ doc: ParsedPdf; num: number }> = [];
  // Seed: refs from each copied page dict (skip /Parent — already dropped,
  // but nested dicts are shared with the source graph so keep the guard).
  for (const p of pages) {
    if (p.type === "copy") {
      collectRefs({ k: "dict", m: p.dict }, (r) => {
        queue.push({ doc: p.doc, num: r.num });
      }, "Parent");
    }
  }

  const copied: EmitEntry[] = [];
  for (let head = 0; head < queue.length; head++) {
    const item = queue[head]!;
    const key = `${docIdx.get(item.doc)}:${item.num}`;
    if (map.has(key)) continue;
    const obj = item.doc.getObject(item.num);
    if (!obj) continue; // dangling source ref → serializes as null
    const newNum = next++;
    map.set(key, newNum);
    copied.push({ doc: item.doc, obj });
    collectRefs(obj, (r) => {
      queue.push({ doc: item.doc, num: r.num });
    }, "Parent");
  }

  // ── catalog + pages tree ──
  const catalog: PdfObj = {
    k: "dict",
    m: new Map<string, PdfObj>([
      ["Type", { k: "name", v: "Catalog" }],
      ["Pages", { k: "ref", num: pagesTreeNum, gen: 0 }],
    ]),
  };
  const pagesTree: PdfObj = {
    k: "dict",
    m: new Map<string, PdfObj>([
      ["Type", { k: "name", v: "Pages" }],
      ["Kids", { k: "arr", items: kids }],
      ["Count", { k: "num", n: kids.length }],
    ]),
  };

  const all: EmitEntry[] = [
    { obj: catalog },
    { obj: pagesTree },
    ...emit,
    ...copied,
  ];

  // ── serialize ──
  const sink = new ByteSink();
  sink.text(`%PDF-${version && /^\d\.\d$/.test(version) ? version : "1.7"}\n`);
  sink.bytes(Uint8Array.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker

  const mapRef = (doc: ParsedPdf | undefined, r: PdfRef): number | undefined => {
    if (doc === undefined) {
      // Synthetic objects are authored directly in NEW numbering (e.g. a
      // blank page's /Parent → the /Pages tree at 2) — identity mapping.
      return r.num >= 1 && r.num <= all.length ? r.num : undefined;
    }
    return map.get(`${docIdx.get(doc)}:${r.num}`);
  };

  const offsets: number[] = [];
  for (let i = 0; i < all.length; i++) {
    offsets[i] = sink.length;
    sink.text(`${i + 1} 0 obj\n`);
    serialize(sink, all[i]!.obj, mapRef, all[i]!.doc);
    sink.text("\nendobj\n");
  }

  const count = all.length + 1; // + free entry 0
  const xrefPos = sink.length;
  sink.text(`xref\n0 ${count}\n`);
  sink.text("0000000000 65535 f \n");
  for (let i = 0; i < all.length; i++) {
    sink.text(`${String(offsets[i]!).padStart(10, "0")} 00000 n \n`);
  }
  sink.text("trailer\n<< /Size " + count + " /Root " + catalogNum + " 0 R >>\n");
  sink.text(`startxref\n${xrefPos}\n%%EOF\n`);

  return sink.toUint8Array();
}
