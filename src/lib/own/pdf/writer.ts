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
  | { type: "blank"; width: number; height: number }
  | {
      /**
       * Authored page (P6-h, the N-up route): a brand-new sheet with its
       * own content stream and resources. `resources` values may use
       * new-space refs ("newref" or plain refs — synthetics serialize in
       * new numbering) to reference form XObjects from the same write.
       */
      type: "new";
      width: number;
      height: number;
      /** Raw content-stream bytes (already-encoded operators). */
      content: Uint8Array;
      /** Resource dict object (or undefined for an empty /Resources). */
      resources?: PdfObj;
    };

/**
 * A synthetic object authored by stamp-side code (P6-f) — a stamp content
 * stream, a base-14 font dict, an image XObject, an ExtGState… Numbering
 * contract: synthetics occupy the output numbers right AFTER the last page
 * object (exactly 3+pages.length for an all-copy plan — blank pages use two
 * objects each, and this writer's `next` counter is the single source of
 * truth), so the caller can pre-compute each object's number and reference it
 * from page dicts via { k: "newref", num }. Objects must be self-contained
 * except for newrefs.
 *
 * P6-h adds SOURCE-ANCHORED synthetics ({ sourceDoc, obj }): objects whose
 * refs point into a parsed SOURCE document (a Form XObject carrying the
 * embedded page's /Resources). Their refs remap through that source's copy
 * map, and their referenced graphs are discovered by the writer's BFS like
 * copied-page graphs — shared objects (a font used by two embedded pages)
 * are still written exactly once per source doc.
 */
export type WriteSynthetic = PdfObj | { sourceDoc: ParsedPdf; obj: PdfObj };

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
  /** 1-based plan position for page dicts (drives the progress hook). */
  pageNo?: number;
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
    case "lstr": {
      // Literal (parenthesized) string — Info dates (P6-l). The bytes we
      // put here are ASCII-safe (digits, ':', 'Z', '+', '-', `'`), so the
      // escape arm only fires for hostile input.
      sink.text("(");
      for (let i = 0; i < obj.b.length; i++) {
        const c = obj.b[i]!;
        if (c === 0x28 || c === 0x29 || c === 0x5c) sink.text("\\");
        if (c >= 0x20 && c <= 0x7e) sink.text(String.fromCharCode(c));
        else sink.text(`\\${c.toString(8).padStart(3, "0")}`);
      }
      sink.text(")");
      return;
    }
    case "hstr": {
      // UPPERCASE hex — pdf-lib's PDFHexString.fromText (P6-l Info text).
      let hx = "<";
      for (let i = 0; i < obj.b.length; i++) {
        hx += obj.b[i]!.toString(16).toUpperCase().padStart(2, "0");
      }
      sink.text(hx + ">");
      return;
    }
    case "newref":
      // Synthetic-authored output-space reference — emitted verbatim.
      sink.text(`${obj.num} 0 R`);
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

/** Progress hook: (fraction of pages written, 1-based page number). */
export type WriteProgress = (fraction: number, page: number) => void;

/**
 * Build the output document. Deterministic numbering:
 *   1 = catalog, 2 = /Pages tree, then each page dict (and each blank
 *   page's content stream) in plan order, then the caller's synthetics
 *   (3+pages.length…, per the WriteSynthetic contract), then BFS-copied
 *   graphs. `onPage` fires after each plan page's object is serialized.
 *
 * P6-o: `catalogExtras` appends entries to the CATALOG dict (e.g. /AcroForm
 * for the edit-surface form builder). Values may use newref(3+slot…) —
 * page dicts occupy 3..3+pages.length-1 for all-copy plans.
 */
export function writeDocument(
  pages: WritePage[],
  version?: string,
  onPage?: WriteProgress,
  synthetics?: WriteSynthetic[],
  info?: PdfObj,
  catalogExtras?: Array<[string, PdfObj]>,
): Uint8Array {
  const map = new Map<string, number>(); // `${docIdx}:${srcNum}` → new num
  const emit: EmitEntry[] = [];
  const docIdx = new Map<ParsedPdf, number>();
  for (const p of pages) {
    if (p.type === "copy" && !docIdx.has(p.doc)) {
      docIdx.set(p.doc, docIdx.size);
    }
  }
  const syntheticsList: Array<PdfObj | { sourceDoc: ParsedPdf; obj: PdfObj }> =
    synthetics ?? [];
  // Source-anchored synthetics also need a docIdx slot for ref remapping.
  for (const s of syntheticsList) {
    if (
      typeof s === "object" &&
      s !== null &&
      "sourceDoc" in s &&
      !docIdx.has(s.sourceDoc)
    ) {
      docIdx.set(s.sourceDoc, docIdx.size);
    }
  }

  const catalogNum = 1;
  const pagesTreeNum = 2;
  let next = 3;
  const kids: PdfObj[] = [];

  // ── page objects (synthetics) ──
  for (let planIndex = 0; planIndex < pages.length; planIndex += 1) {
    const p = pages[planIndex]!;
    if (p.type === "copy") {
      const newNum = next++;
      map.set(`${docIdx.get(p.doc)}:${p.srcNum}`, newNum);
      emit.push({ doc: p.doc, obj: { k: "dict", m: p.dict }, pageNo: planIndex + 1 });
      kids.push({ k: "ref", num: newNum, gen: 0 });
    } else if (p.type === "blank") {
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
      emit.push({ obj: { k: "dict", m: pageDict }, pageNo: planIndex + 1 });
      emit.push({ obj: emptyStream });
      kids.push({ k: "ref", num: dictNum, gen: 0 });
    } else {
      // Authored page (P6-h): dict + caller-provided content stream, both
      // synthetic — same two-object numbering as a blank page.
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
        [
          "Resources",
          p.resources ?? { k: "dict", m: new Map() },
        ],
        ["Contents", { k: "ref", num: streamNum, gen: 0 }],
      ]);
      const stream: PdfObj = {
        k: "stream",
        m: new Map<string, PdfObj>([
          ["Length", { k: "num", n: p.content.length }],
        ]),
        raw: p.content,
      };
      emit.push({ obj: { k: "dict", m: pageDict }, pageNo: planIndex + 1 });
      emit.push({ obj: stream });
      kids.push({ k: "ref", num: dictNum, gen: 0 });
    }
  }

  // ── synthetic stamp objects (fixed numbering: after the page dicts) ──
  const syntheticEmit: EmitEntry[] = [];
  for (const s of syntheticsList) {
    if (typeof s === "object" && s !== null && "sourceDoc" in s) {
      syntheticEmit.push({ doc: s.sourceDoc, obj: s.obj });
    } else {
      syntheticEmit.push({ obj: s as PdfObj });
    }
    next++; // number already implied by position: 3 + pages.length + index
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
  // Seed: refs from source-anchored synthetics (Form XObject /Resources).
  for (const s of syntheticsList) {
    if (typeof s === "object" && s !== null && "sourceDoc" in s) {
      collectRefs(s.obj, (r) => {
        queue.push({ doc: s.sourceDoc, num: r.num });
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
  // P6-o: caller-authored catalog entries (e.g. /AcroForm) — appended
  // AFTER /Pages, exactly one entry each, caller-deduplicated.
  if (catalogExtras !== undefined) {
    for (const [key, value] of catalogExtras) catalog.m.set(key, value);
  }
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
    ...syntheticEmit,
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
    const entry = all[i]!;
    if (entry.pageNo !== undefined && onPage !== undefined) {
      onPage(entry.pageNo / pages.length, entry.pageNo);
    }
  }

  const count = all.length + 1; // + free entry 0
  let infoNum = 0;
  if (info !== undefined && info.k === "dict" && info.m.size > 0) {
    // The Info dict rides as the LAST object (pdf-lib allocates it early,
    // next to the catalog — object NUMBER is not a parity surface, only
    // the field encoding + the trailer structure are).
    infoNum = all.length + 1;
    offsets[all.length] = sink.length;
    sink.text(`${infoNum} 0 obj\n`);
    serialize(sink, info, mapRef, undefined);
    sink.text("\nendobj\n");
  }
  // xref must start AFTER the Info object — startxref points HERE.
  const xrefPos = sink.length;
  const size = Math.max(count, infoNum + 1);
  sink.text(`xref\n0 ${size}\n`);
  sink.text("0000000000 65535 f \n");
  for (let i = 0; i < all.length; i++) {
    sink.text(`${String(offsets[i]!).padStart(10, "0")} 00000 n \n`);
  }
  if (infoNum > 0) {
    sink.text(`${String(offsets[all.length]!).padStart(10, "0")} 00000 n \n`);
  }
  sink.text(
    "trailer\n<< /Size " + size + " /Root " + catalogNum + " 0 R" +
      (infoNum > 0 ? " /Info " + infoNum + " 0 R" : "") +
      " >>\n",
  );
  sink.text(`startxref\n${xrefPos}\n%%EOF\n`);

  return sink.toUint8Array();
}
