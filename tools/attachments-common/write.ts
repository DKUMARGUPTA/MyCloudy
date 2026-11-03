import {
  asArr,
  asDict,
  arr,
  name,
  newDict,
  num,
  pdfInfoText,
  ref,
  type PdfObj,
  type ParsedPdf,
  resolveTrailerRef,
} from "@/lib/own/pdf";
import { zlibSync } from "@/lib/own/zip";
import { decodePdfText } from "./nametree";

/**
 * Embedded-files writer (P3-d) — the GENERALIZED, spec-correct version
 * of the create-electronic-invoice facturx-attach surgery (same own-
 * engine lineage, zero competitor code):
 *
 *   1. EmbeddedFile stream — { Type /EmbeddedFile, Subtype <mime>,
 *      [/Filter /FlateDecode], Params { Size, ModDate } } as an
 *      extraObject above the source numbering. /Params /Size is the
 *      UNCOMPRESSED byte length (spec: "size of the embedded file")
 *      even when the stream itself is Flate-packed.
 *   2. Filespec — { Type /Filespec, F <latin1>, UF <UTF-16BE hex>,
 *      [Desc], EF { F, UF }, [AFRelationship] }.
 *   3. Catalog /AF — the filespec ref APPENDED to any existing array.
 *   4. Catalog /Names /EmbeddedFiles — [ key, filespecRef ] inserted
 *      in SORTED position in the flat Names array (one better than
 *      the facturx append-at-end: binary-search lookups are spec-
 *      correct from the start). Split trees follow /Kids to the
 *      first leaf; a leaf carrying /Limits gets its limits
 *      recomputed from its own (now larger) key set.
 *
 * All catalog/tree mutations happen IN PLACE on the parsed objects —
 * the rewrite preserve-path serializes them back (facturx precedent,
 * zero remapping).
 */

/** One attachment to embed (worker-side input). */
export interface AttachInput {
  /** File name WITH extension (the /UF + tree key). */
  name: string;
  /** Sniffed or caller-known MIME type. */
  mime: string;
  /** The raw (uncompressed) file bytes. */
  bytes: Uint8Array;
  /** Optional description (filespec /Desc). */
  desc?: string;
  /** Optional AFRelationship name (PDF 2.0, e.g. "Data"). */
  relationship?: string;
}

/** Result of authoring + merging one attachment. */
export interface AttachExtras {
  /** New objects to write ABOVE the source numbering. */
  extras: Array<{ num: number; obj: PdfObj }>;
}

/** Formats "now" as a PDF date string (D:YYYYMMDDHHmmSSZ). */
export function pdfDateNow(): string {
  const d = new Date();
  const p = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(
    d.getUTCDate()
  )}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/**
 * Authors the filespec + EmbeddedFile stream pair and merges the
 * references into the catalog (/AF + /Names /EmbeddedFiles, sorted).
 * `nextNum` is the first free object number ABOVE the source table;
 * returns the NEXT free number after this attachment's two objects.
 */
export function attachFile(
  doc: ParsedPdf,
  catalog: Map<string, PdfObj>,
  input: AttachInput,
  nextNum: number,
  opts: { compress: boolean; modDate?: string }
): { nextNum: number; extras: AttachExtras["extras"] } {
  const extras: AttachExtras["extras"] = [];

  /* ---- 1. EmbeddedFile stream -------------------------------------- */
  const embeddedNum = nextNum++;
  const raw = input.bytes;
  let body = raw;
  const streamDict = new Map<string, PdfObj>([
    ["Type", name("EmbeddedFile")],
    ["Subtype", name(input.mime)],
  ]);
  if (opts.compress) {
    body = zlibSync(raw);
    streamDict.set("Filter", name("FlateDecode"));
  }
  streamDict.set(
    "Params",
    newDict([
      ["Size", num(raw.length)],
      ["ModDate", { k: "lstr", b: latin1Bytes(opts.modDate ?? pdfDateNow()) }],
    ])
  );
  extras.push({ num: embeddedNum, obj: { k: "stream", m: streamDict, raw: body } });

  /* ---- 2. Filespec -------------------------------------------------- */
  const filespecNum = nextNum++;
  const specPairs: Array<[string, PdfObj]> = [
    ["Type", name("Filespec")],
    ["F", { k: "lstr", b: latin1Bytes(input.name) }],
    ["UF", pdfInfoText(input.name)],
  ];
  if (input.desc !== undefined && input.desc.length > 0) {
    specPairs.push(["Desc", { k: "lstr", b: latin1Bytes(input.desc) }]);
  }
  specPairs.push([
    "EF",
    newDict([
      ["F", ref(embeddedNum)],
      ["UF", ref(embeddedNum)],
    ]),
  ]);
  if (input.relationship !== undefined && input.relationship.length > 0) {
    specPairs.push(["AFRelationship", name(input.relationship)]);
  }
  extras.push({ num: filespecNum, obj: { k: "dict", m: new Map(specPairs) } });
  const filespecRef = ref(filespecNum);

  /* ---- 3. catalog /AF (merge) -------------------------------------- */
  const afExisting = asArr(catalog.get("AF"));
  if (afExisting !== undefined) {
    afExisting.push(filespecRef);
  } else {
    catalog.set("AF", arr(filespecRef));
  }

  /* ---- 4. /Names /EmbeddedFiles (sorted merge) ---------------------- */
  mergeSortedEmbeddedFilesName(doc, catalog, filespecRef, input.name);

  return { nextNum, extras };
}

/**
 * Inserts [ <UTF-16BE key>, filespecRef ] into the catalog's
 * /Names /EmbeddedFiles tree in SORTED position (code-unit compare —
 * the sort order the spec's binary search assumes). Split trees:
 * follow /Kids to the first leaf carrying a flat /Names array; the
 * leaf's /Limits are recomputed when it carries them. Every other
 * /Names key (Dests, JavaScript…) is preserved untouched.
 */
function mergeSortedEmbeddedFilesName(
  doc: ParsedPdf,
  catalog: Map<string, PdfObj>,
  filespecRef: PdfObj,
  key: string
): void {
  const namesValue = catalog.get("Names");
  const namesDictRaw = resolveTrailerRef(doc, namesValue);
  if (namesDictRaw === undefined || namesDictRaw.k !== "dict") {
    // No /Names at all — create the whole branch.
    catalog.set(
      "Names",
      newDict([["EmbeddedFiles", newDict([["Names", makePair(key, filespecRef)]])]])
    );
    return;
  }

  let node: Map<string, PdfObj> | undefined = asDict(
    resolveTrailerRef(doc, namesDictRaw.m.get("EmbeddedFiles"))
  );
  // A split tree: follow /Kids to the first leaf carrying flat /Names.
  let depth = 0;
  while (
    node !== undefined &&
    flatNamesOf(doc, node) === undefined &&
    depth < 5
  ) {
    const kids = asArr(resolveTrailerRef(doc, node.get("Kids")));
    if (kids === undefined || kids.length === 0) break;
    const firstDict = asDict(resolveTrailerRef(doc, kids[0]));
    if (firstDict === undefined) break;
    node = firstDict;
    depth += 1;
  }

  if (node === undefined) {
    namesDictRaw.m.set(
      "EmbeddedFiles",
      newDict([["Names", makePair(key, filespecRef)]])
    );
    return;
  }

  const namesArray = flatNamesOf(doc, node);
  if (namesArray === undefined) {
    node.set("Names", makePair(key, filespecRef));
    return;
  }

  // Sorted insert: find the first key strictly greater than ours.
  let insertAt = namesArray.length; // default: append (also the equal-key case)
  for (let i = 0; i + 1 < namesArray.length; i += 2) {
    const existing = decodePdfText(namesArray[i]!);
    if (existing !== undefined && compareKeys(existing, key) > 0) {
      insertAt = i;
      break;
    }
  }
  namesArray.splice(insertAt, 0, pdfInfoText(key), filespecRef);

  // Leaf /Limits keep intermediate binary searches honest.
  recomputeLimits(node, namesArray);
}

/** The node's flat /Names items, resolved when the array is indirect. */
function flatNamesOf(
  doc: ParsedPdf,
  node: Map<string, PdfObj>
): PdfObj[] | undefined {
  const resolved = resolveTrailerRef(doc, node.get("Names"));
  return resolved !== undefined && resolved.k === "arr" ? resolved.items : undefined;
}

/** [ <hex key>, filespecRef ] pair array. */
function makePair(key: string, filespecRef: PdfObj): PdfObj {
  return arr(pdfInfoText(key), filespecRef);
}

/** Code-unit key comparison (the tree's sort order). */
export function compareKeys(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/** Recomputes a leaf's /Limits [min, max] from its own flat keys. */
function recomputeLimits(node: Map<string, PdfObj>, namesArray: PdfObj[]): void {
  if (namesArray.length < 2) {
    node.delete("Limits");
    return;
  }
  if (node.get("Limits") === undefined) return; // leaf never carried them
  const first = decodePdfText(namesArray[0]!);
  const last = decodePdfText(namesArray[namesArray.length - 2]!);
  if (first === undefined || last === undefined) return;
  node.set("Limits", arr(pdfInfoText(first), pdfInfoText(last)));
}

/** UTF-8 → latin1-ish bytes for literal strings (ASCII content only). */
function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    out[i] = text.charCodeAt(i) & 0xff;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Name de-duplication (pre-insert)                                    */
/* ------------------------------------------------------------------ */

/**
 * Makes an attachment name unique against the taken set: "a.pdf",
 * "a.pdf" → "a (2).pdf". Tree keys and filespec names must be unique
 * — a silent overwrite would lose data.
 */
export function uniqueAttachmentName(raw: string, taken: Set<string>): string {
  const base = raw.trim().length > 0 ? raw.trim() : "file";
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${stem} (${i})${ext}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  // Pathological — fall back to a timestamped name.
  const fallback = `${stem}-${Date.now()}${ext}`;
  taken.add(fallback);
  return fallback;
}

/* ------------------------------------------------------------------ */
/* Removal surgery                                                     */
/* ------------------------------------------------------------------ */

/**
 * Strips every document-level embedded-file reference from the
 * catalog, in place:
 *   - /Names /EmbeddedFiles entries removed (leaf arrays filtered;
 *     empty /Names branch dropped when it carries nothing else);
 *   - catalog /AF entries removed (key dropped when it empties).
 * Does NOT touch page-level file-attachment annotations (a different
 * mechanism — the caller keeps their filespec objects alive when an
 * annotation still points at them).
 */
export function stripEmbeddedFileReferences(
  doc: ParsedPdf,
  catalog: Map<string, PdfObj>,
  filespecNums: Set<number>
): void {
  /* ---- /Names /EmbeddedFiles -------------------------------------- */
  const namesDictRaw = resolveTrailerRef(doc, catalog.get("Names"));
  if (namesDictRaw !== undefined && namesDictRaw.k === "dict") {
    const root = asDict(resolveTrailerRef(doc, namesDictRaw.m.get("EmbeddedFiles")));
    if (root !== undefined) {
      stripTreeNode(doc, root, filespecNums);
      // Drop the branch when it carries nothing findable.
      if (treeIsEmpty(doc, root)) {
        namesDictRaw.m.delete("EmbeddedFiles");
        if (namesDictRaw.m.size === 0) {
          catalog.delete("Names");
        }
      }
    }
  }

  /* ---- catalog /AF ------------------------------------------------- */
  const af = asArr(catalog.get("AF"));
  if (af !== undefined) {
    const kept = af.filter(
      (item) => !(item.k === "ref" && filespecNums.has(item.num))
    );
    if (kept.length === 0) {
      catalog.delete("AF");
    } else if (kept.length !== af.length) {
      // Replace contents in place (the parsed array is shared).
      af.length = 0;
      af.push(...kept);
    }
  }
}

/** Filters the filespec pairs out of one tree node (Kids or flat). */
function stripTreeNode(
  doc: ParsedPdf,
  node: Map<string, PdfObj>,
  filespecNums: Set<number>
): void {
  const kids = asArr(resolveTrailerRef(doc, node.get("Kids")));
  if (kids !== undefined) {
    for (const kid of kids) {
      const kidDict = asDict(resolveTrailerRef(doc, kid));
      if (kidDict !== undefined) stripTreeNode(doc, kidDict, filespecNums);
    }
    return;
  }
  const flat = flatNamesOf(doc, node);
  if (flat === undefined) return;
  const kept: PdfObj[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const spec = flat[i + 1]!;
    if (spec.k === "ref" && filespecNums.has(spec.num)) continue;
    kept.push(flat[i]!, spec);
  }
  if (kept.length !== flat.length) {
    flat.length = 0;
    flat.push(...kept);
    recomputeLimits(node, flat);
  }
}

/** True when the tree node has no entries left (Kids or flat). */
function treeIsEmpty(doc: ParsedPdf, node: Map<string, PdfObj>): boolean {
  const kids = asArr(resolveTrailerRef(doc, node.get("Kids")));
  if (kids !== undefined) return kids.length === 0;
  const flat = flatNamesOf(doc, node);
  if (flat === undefined) return true;
  return flat.length === 0;
}

