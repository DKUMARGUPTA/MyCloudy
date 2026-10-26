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
  /**
   * R14: the user's rotation OFFSET in degrees (0 | 90 | 180 | 270).
   * Absent/0 = untouched — the source page keeps whatever /Rotate it
   * shipped with (the preview renders it as-is; the export never writes
   * /Rotate for it). The offset ADDS to the source's own rotation at
   * export (R13 lesson: never flatten it), and four taps of +90 wrap
   * back to absent — an honest reset, not a sticky 360.
   */
  rotate?: number;
}

/** Workspace-wide page cap for duplication (page-plan precedent). */
export const MAX_WORKSPACE_PAGES = 2000;

/** Normalizes a rotation value to [0, 360). */
function norm360(raw: number): number {
  return ((Math.trunc(raw) % 360) + 360) % 360;
}

/** Snaps any value to a quadrant 0 | 90 | 180 | 270 (R13 quadrantRotate rule: non-quadrant → 0). */
export function quadrantRotation(raw: number): number {
  const r = norm360(raw);
  return r === 90 || r === 180 || r === 270 ? r : 0;
}

/** The user's rotation offset for a ref (0 when untouched). */
export function pageRotateOffset(page: AsmPageRef): number {
  return page.rotate === undefined ? 0 : quadrantRotation(page.rotate);
}

/** The offset a `delta` turn would land a ref on (toast math, pure). */
export function nextRotationOffset(
  page: AsmPageRef,
  delta: number
): number {
  return quadrantRotation(pageRotateOffset(page) + delta);
}

/** One document column in the workspace. */
export interface AsmDoc {
  id: number;
  name: string;
  pages: AsmPageRef[];
  /** Workspace file id this column was created from ("new document"
   * columns have none). Client-only — never serialized; the surface uses
   * it to attribute per-column probe failures (unreadable/encrypted). */
  sourceFileId?: string;
}

/** Output document produced by the plan (pure data — the worker executes it). */
export interface AsmOutputDoc {
  name: string;
  /** [fileId, pageIndex] pairs in final output order; a third element
   * carries the user's rotation offset when the page was turned (R14). */
  pages: [string, number, number?][];
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
    sourceFileId: fileId,
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
 * R14: turns one page by a quadrant delta (±90 in the UI). The offset
 * wraps — 270 + 90 lands back on 0, where the field is REMOVED (the
 * honest reset: the page exports exactly as its source shipped it).
 * Rotation never reorders or drops slots, so it stays available on any
 * workspace size. Returns the input unchanged for bad indices or a
 * zero delta (nothing to record in history).
 */
export function rotatePage(
  docs: AsmDoc[],
  docId: number,
  index: number,
  delta: number
): AsmDoc[] {
  if (delta % 360 === 0) return docs;
  const doc = docs.find((entry) => entry.id === docId);
  if (!doc || index < 0 || index >= doc.pages.length) return docs;
  return setDocPages(
    docs,
    docId,
    doc.pages.map((page, i) => {
      if (i !== index) return page;
      const next = quadrantRotation(pageRotateOffset(page) + delta);
      if (next === 0) {
        const { rotate: _dropped, ...rest } = page;
        return rest;
      }
      return { ...page, rotate: next };
    })
  );
}

/**
 * R14: duplicates a page in place — a fresh ref (new uid, same source
 * page AND its current rotation) inserted right after the original, so
 * the copy can then be turned or moved independently. No-op at the
 * workspace-wide page cap (MAX_WORKSPACE_PAGES); the surface turns the
 * identity return into the honest cap toast.
 */
export function duplicatePage(
  docs: AsmDoc[],
  docId: number,
  index: number
): AsmDoc[] {
  const doc = docs.find((entry) => entry.id === docId);
  if (!doc || index < 0 || index >= doc.pages.length) return docs;
  const total = docs.reduce((sum, entry) => sum + entry.pages.length, 0);
  if (total >= MAX_WORKSPACE_PAGES) return docs;
  const src = doc.pages[index];
  const copy: AsmPageRef = {
    uid: nextUid(),
    fileId: src.fileId,
    page: src.page,
    ...(src.rotate !== undefined ? { rotate: src.rotate } : {}),
  };
  const pages = [...doc.pages];
  pages.splice(index + 1, 0, copy);
  return setDocPages(docs, docId, pages);
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

/** A planned page as wire data: source ref + optional rotation offset. */
export function planPage(
  page: AsmPageRef
): [string, number, number?] {
  const out: [string, number, number?] = [page.fileId, page.page];
  const rot = pageRotateOffset(page);
  if (rot !== 0) out.push(rot);
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
      pages: doc.pages.map(planPage),
    }));
  }

  const refs = options.zipper
    ? interleavePages(nonEmpty)
    : nonEmpty.flatMap((doc) => doc.pages);
  if (options.reverse) refs.reverse();

  return [
    {
      name: nonEmpty[0].name,
      pages: refs.map(planPage),
    },
  ];
}

/* ------------------------------ serialization ------------------------------ */

/**
 * Compact wire format (option "assemble"): [[name, [[fileId, page], …]], …].
 * Uids never leave the client. Passed to the worker as a plain option.
 * R14: a TURNED page serializes as [fileId, page, rotate] — untouched
 * pages stay 2-tuples, so workspaces with no rotation are byte-identical
 * to the pre-R14 format (old payloads must keep parsing forever).
 */
export function serializeAssemble(docs: AsmDoc[]): string {
  return JSON.stringify(
    docs.map((doc) => [
      doc.name,
      doc.pages.map((page) => {
        const planned = planPage(page);
        return planned.length === 3 ? planned : [planned[0], planned[1]];
      }),
    ])
  );
}

/** Parses the wire format back. Returns null for anything malformed. */
export function parseAssembleOption(
  raw: unknown
): { name: string; pages: [string, number, number?][] }[] | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: { name: string; pages: [string, number, number?][] }[] = [];
  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const name = entry[0];
    const rawPages = entry[1];
    if (typeof name !== "string" || !Array.isArray(rawPages)) return null;
    const pages: [string, number, number?][] = [];
    for (const ref of rawPages) {
      if (
        !Array.isArray(ref) ||
        (ref.length !== 2 && ref.length !== 3) ||
        typeof ref[0] !== "string" ||
        typeof ref[1] !== "number" ||
        !Number.isInteger(ref[1]) ||
        ref[1] < 0
      ) {
        return null;
      }
      // R14 third element: the rotation offset. Legacy payloads (and
      // untouched pages) carry none. A non-quadrant value is stale or
      // tampered data — it snaps to 0 (the R13 quadrantRotate rule), so
      // the run proceeds with the page exactly as its source shipped it.
      const rawRot = ref.length === 3 ? ref[2] : undefined;
      const rot =
        typeof rawRot === "number" && Number.isFinite(rawRot)
          ? quadrantRotation(rawRot)
          : 0;
      pages.push(
        rot === 0 ? [ref[0], ref[1]] : [ref[0], ref[1], rot]
      );
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
  /** Pages carrying a user rotation offset (R14 toolbar chip). */
  rotated: number;
}

/** Summary for the toolbar chips. */
export function asmStats(docs: AsmDoc[]): AsmStats {
  let pages = 0;
  let nonEmptyDocs = 0;
  let rotated = 0;
  for (const doc of docs) {
    pages += doc.pages.length;
    if (doc.pages.length > 0) nonEmptyDocs += 1;
    for (const page of doc.pages) {
      if (pageRotateOffset(page) !== 0) rotated += 1;
    }
  }
  return { docs: docs.length, nonEmptyDocs, pages, rotated };
}
