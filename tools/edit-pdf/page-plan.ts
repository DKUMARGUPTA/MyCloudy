/**
 * Edit PDF — page-plan application (R12, worker-side but bun-testable).
 *
 * Pure pdf-lib surgery that rebuilds a loaded document's page tree to
 * match the workspace plan, IN PLACE (same doc, same objects — never a
 * rebuild into a fresh document, so content streams, annotations and
 * the AcroForm registry all survive):
 *
 *  1. every src shown more than once gets a fresh self-copy
 *     (doc.copyPages(doc, [src]) — ONE call per extra slot so each is a
 *     distinct page node; a memoised batch copy would alias them and the
 *     drawing pass would write through one node into "both" pages);
 *  2. source pages that left the workspace are removed, highest index
 *     first (earlier indices stay valid);
 *  3. the tree is unhooked and re-attached in plan order via
 *     insertPage(index, page) with SAME-doc page objects — true reference
 *     moves, not copies.
 *
 * Isolated in its own module (no worker globals) so the smoke script
 * drives the exact shipping code against real pdf-lib documents.
 */

import type { PDFDocument, PDFPage } from "pdf-lib";

/** Tampered-blob guard — the surface caps the workspace at 500 slots. */
export const MAX_WORKSPACE_PAGES = 2000;

export interface PlanPageView {
  /** The source page this workspace slot shows. */
  src?: number;
}

export async function applyPagePlan(
  doc: PDFDocument,
  originalPages: PDFPage[],
  plan: PlanPageView[]
): Promise<PDFPage[]> {
  const seen = new Map<number, number>();
  const extras: PDFPage[] = [];
  for (const view of plan) {
    const src = view.src ?? 0;
    const n = seen.get(src) ?? 0;
    seen.set(src, n + 1);
    if (n >= 1) extras.push((await doc.copyPages(doc, [src]))[0]);
  }
  for (let i = originalPages.length - 1; i >= 0; i -= 1) {
    if (!seen.has(i)) doc.removePage(i);
  }
  while (doc.getPageCount() > 0) doc.removePage(0);
  const pageBySrc = new Map<number, PDFPage>();
  for (let i = 0; i < originalPages.length; i += 1) {
    if (seen.has(i)) pageBySrc.set(i, originalPages[i]);
  }
  const outPages: PDFPage[] = [];
  let e = 0;
  const reSeen = new Map<number, number>();
  for (const view of plan) {
    const src = view.src ?? 0;
    const n = reSeen.get(src) ?? 0;
    reSeen.set(src, n + 1);
    const page = n === 0 ? pageBySrc.get(src) : extras[e++];
    if (page === undefined) continue; // clamped src — impossible post-parse
    doc.insertPage(doc.getPageCount(), page);
    outPages.push(page);
  }
  return outPages;
}
