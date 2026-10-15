/**
 * Assemble PDF — pure shared model (PRD §8.1 "Assemble PDF").
 *
 * The workspace is a list of DOCUMENTS (columns), each holding an ordered
 * list of page REFERENCES into the workspace files (never page data —
 * uids stay client-side, refs stay tiny so history snapshots are cheap).
 * The surface edits this list with undoable operations; the worker
 * rebuilds the output PDFs from the serialized plan. Same module on both
 * sides — the column preview and the worker output can never disagree.
 *
 * PRD options: "Zipper merge (alternate pages, jaise front/back scans)",
 * reverse, save all separately (ZIP) — encoded by `planAssemble`, which
 * turns the edited columns into concrete output documents (pure data the
 * worker executes).
 */

/** One page inside a document column. `page` is a 0-based index into the source file. */
export interface AsmPageRef {
  /** Client-only stable identity (dnd keys, React keys); NOT serialized. */
  uid: number;
  /** Workspace file id (stable across reorders). */
  fileId: string;
  /** 0-based page index in that file. */
  page: number;
}

/** One document column in the workspace. */
export interface AsmDoc {
  id: number;
  name: string;
  pages: AsmPageRef[];
}

/** Output document produced by the plan (pure data — the worker executes it). */
export interface AsmOutputDoc {
  name: string;
  /** [fileId, pageIndex] pairs in final output order. */
  pages: [string, number][];
}

let uidSeq = 0;
let docIdSeq = 0;

export function nextUid(): number {
  uidSeq += 1;
  return uidSeq;
}

export function nextDocId(): number {
  docIdSeq += 1;
  return docIdSeq;
}

/** Fresh document with every page of a file, named after it. */
export function createDocFromFile(
  fileName: string,
  fileId: string,
  pageCount: number,
  _atIndex?: number
): AsmDoc {
  const pages: AsmPageRef[] = [];
  for (let page = 0; page < pageCount; page += 1) {
    pages.push({ uid: nextUid(), fileId, page });
  }
  return {
    id: nextDocId(),
    name: baseFileName(fileName),
    pages,
  };
}

/** Empty document column (the PRD "new document column"). */
export function createEmptyDoc(name: string): AsmDoc {
  return { id: nextDocId(), name, pages: [] };
}

/** Strips ".pdf" and path junk for a readable column name. */
export function baseFileName(name: string): string {
  const cleaned = name
    .replace(/\.(pdf)$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 60) : "Document";
}

/* ------------------------------ operations ------------------------------ */
/* All pure: they return new arrays and never mutate their input. */

export function addDoc(docs: AsmDoc[], doc: AsmDoc): AsmDoc[] {
  return [...docs, doc];
}

export function removeDoc(docs: AsmDoc[], docId: number): AsmDoc[] {
  return docs.filter((doc) => doc.id !== docId);
}

export function renameDoc(docs: AsmDoc[], docId: number, name: string): AsmDoc[] {
  return docs.map((doc) => (doc.id === docId ? { ...doc, name } : doc));
}

/** Reorders one column's pages (drag inside a column, or the header reverse button). */
export function setDocPages(docs: AsmDoc[], docId: number, pages: AsmPageRef[]): AsmDoc[] {
  return docs.map((doc) => (doc.id === docId ? { ...doc, pages } : doc));
}

export function reverseDocPages(docs: AsmDoc[], docId: number): AsmDoc[] {
  return docs.map((doc) =>
    doc.id === docId ? { ...doc, pages: [...doc.pages].reverse() } : doc
  );
}

/** dnd-kit within-column move (local arrayMove copy). */
function arrayMove<T>(list: T[], from: number, to: number): T[] {
  const out = [...list];
  const clamped = Math.max(0, Math.min(to, out.length - 1));
  const [moved] = out.splice(from, 1);
  out.splice(clamped, 0, moved);
  return out;
}

/** Moves a page inside one column. No-op when out of bounds. */
export function movePageWithinDoc(
  docs: AsmDoc[],
  docId: number,
  fromIndex: number,
  toIndex: number
): AsmDoc[] {
  const doc = docs.find((entry) => entry.id === docId);
  if (!doc) return docs;
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    fromIndex >= doc.pages.length
  ) {
    return docs;
  }
  return setDocPages(docs, docId, arrayMove(doc.pages, fromIndex, toIndex));
}

/**
 * The PRD core action: move a page from one document to another.
 * `toIndex < 0` (or beyond the target) appends at the end.
 */
export function transferPage(
  docs: AsmDoc[],
  fromDocId: number,
  fromIndex: number,
  toDocId: number,
  toIndex: number
): AsmDoc[] {
  const from = docs.find((entry) => entry.id === fromDocId);
  const to = docs.find((entry) => entry.id === toDocId);
  if (!from || !to) return docs;
  if (fromIndex < 0 || fromIndex >= from.pages.length) return docs;

  if (fromDocId === toDocId) {
    return movePageWithinDoc(docs, fromDocId, fromIndex, toIndex);
  }

  const page = from.pages[fromIndex];
  const insertAt =
    toIndex < 0 ? to.pages.length : Math.min(toIndex, to.pages.length);

  return docs.map((doc) => {
    if (doc.id === fromDocId) {
      return { ...doc, pages: doc.pages.filter((_, i) => i !== fromIndex) };
    }
    if (doc.id === toDocId) {
      const pages = [...doc.pages];
      pages.splice(insertAt, 0, page);
      return { ...doc, pages };
    }
    return doc;
  });
}

/** Deletes the given (0-based) page indices from one column. */
export function deletePages(
  docs: AsmDoc[],
  docId: number,
  indices: number[]
): AsmDoc[] {
  if (indices.length === 0) return docs;
  const touched = new Set(indices);
  return docs.map((doc) =>
    doc.id === docId
      ? { ...doc, pages: doc.pages.filter((_, index) => !touched.has(index)) }
      : doc
  );
}

/**
 * Removes every page that references a file that left the workspace.
 * Docs that BECAME empty because of the drop go away; docs that were
 * already empty (user-created columns) survive untouched.
 */
export function dropFilePages(docs: AsmDoc[], fileId: string): AsmDoc[] {
  const out: AsmDoc[] = [];
  for (const doc of docs) {
    if (doc.pages.length === 0) {
      out.push(doc); // user-created column — keep untouched
      continue;
    }
    const pages = doc.pages.filter((page) => page.fileId !== fileId);
    if (pages.length > 0) out.push({ ...doc, pages });
    // else: every page came from the dropped file → the doc goes with it
  }
  return out;
}

/* ------------------------------ planning ------------------------------ */

export type AsmOutputMode = "merge" | "separate";

export interface AsmPlanOptions {
  mode: AsmOutputMode;
  /** Zipper merge: alternate pages across columns (front/back scans). */
  zipper: boolean;
  /** Reverse the final page sequence (merge mode). */
  reverse: boolean;
}

/**
 * Round-robin interleave: page 1 of doc A, page 1 of doc B, page 2 of A…
 * (the classic "fronts + backs" scan fix). Shorter columns drop out early.
 */
function interleavePages(docs: AsmDoc[]): AsmPageRef[] {
  const active = docs.filter((doc) => doc.pages.length > 0);
  const out: AsmPageRef[] = [];
  const maxLen = active.reduce(
    (best, doc) => Math.max(best, doc.pages.length),
    0
  );
  for (let index = 0; index < maxLen; index += 1) {
    for (const doc of active) {
      if (index < doc.pages.length) out.push(doc.pages[index]);
    }
  }
  return out;
}

/**
 * Turns the edited columns into concrete output documents (pure data —
 * the worker just executes this). Merge mode returns ONE document;
 * separate mode returns one per non-empty column.
 */
export function planAssemble(
  docs: AsmDoc[],
  options: AsmPlanOptions
): AsmOutputDoc[] {
  const nonEmpty = docs.filter((doc) => doc.pages.length > 0);
  if (nonEmpty.length === 0) return [];

  if (options.mode === "separate") {
    return nonEmpty.map((doc) => ({
      name: doc.name,
      pages: doc.pages.map(
        (page): [string, number] => [page.fileId, page.page]
      ),
    }));
  }

  const refs = options.zipper
    ? interleavePages(nonEmpty)
    : nonEmpty.flatMap((doc) => doc.pages);
  if (options.reverse) refs.reverse();

  return [
    {
      name: nonEmpty[0].name,
      pages: refs.map((page): [string, number] => [page.fileId, page.page]),
    },
  ];
}

/* ------------------------------ serialization ------------------------------ */

/**
 * Compact wire format (option "assemble"): [[name, [[fileId, page], …]], …].
 * Uids never leave the client. Passed to the worker as a plain option.
 */
export function serializeAssemble(docs: AsmDoc[]): string {
  return JSON.stringify(
    docs.map((doc) => [
      doc.name,
      doc.pages.map((page): [string, number] => [page.fileId, page.page]),
    ])
  );
}

/** Parses the wire format back. Returns null for anything malformed. */
export function parseAssembleOption(
  raw: unknown
): { name: string; pages: [string, number][] }[] | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: { name: string; pages: [string, number][] }[] = [];
  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const name = entry[0];
    const rawPages = entry[1];
    if (typeof name !== "string" || !Array.isArray(rawPages)) return null;
    const pages: [string, number][] = [];
    for (const ref of rawPages) {
      if (
        !Array.isArray(ref) ||
        ref.length !== 2 ||
        typeof ref[0] !== "string" ||
        typeof ref[1] !== "number" ||
        !Number.isInteger(ref[1]) ||
        ref[1] < 0
      ) {
        return null;
      }
      pages.push([ref[0], ref[1]]);
    }
    out.push({ name, pages });
  }
  return out;
}

/* ------------------------------ stats ------------------------------ */

export interface AsmStats {
  docs: number;
  nonEmptyDocs: number;
  pages: number;
}

/** Summary for the toolbar chips. */
export function asmStats(docs: AsmDoc[]): AsmStats {
  let pages = 0;
  let nonEmptyDocs = 0;
  for (const doc of docs) {
    pages += doc.pages.length;
    if (doc.pages.length > 0) nonEmptyDocs += 1;
  }
  return { docs: docs.length, nonEmptyDocs, pages };
}
