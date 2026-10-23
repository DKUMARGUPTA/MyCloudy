/**
 * Smoke: view-pdf outline panel (ENH-2 feature 2) — bookmarks sidebar,
 * hidden entirely when the document has no outline.
 *
 * The outline panel itself (tabs, click-to-scroll) already exists; this
 * smoke pins the ENH-2 refinement — "no empty state noise" — plus the
 * REAL pdf.js outline resolution the surface performs:
 *
 *  0. Wiring sanity (source-text checks — the surface is a React client
 *     component, not node-safe): the outline tab is conditional on
 *     outline.length > 0, the stale-selection fallback (`activeTab`)
 *     exists, the empty-state string is gone, and the pdf.js destination
 *     chain (getOutline → getDestination → getPageIndex) is intact.
 *  1. i18n parity: view.outlineTab present in BOTH catalogs,
 *     view.outlineEmpty in NEITHER (hidden-when-empty removed it), and
 *     the whole view.* leaf set still matches EN=HI.
 *  2. REAL pdf.js outline walk (the exact logic the surface runs — same
 *     API calls, same flattening rules): a 5-page pdf-lib fixture with a
 *     nested bookmark tree written by the bookmark-pdf engine
 *     (A→p1, B→p2 {B1→p3, B2→p4}, C→p5) must flatten to rows with
 *     depth + page; a plain PDF without /Outlines must resolve to NO
 *     rows (the exact predicate that hides the tab); a 4-level tree must
 *     stop walking at depth 3 (the surface's nesting cap); an untitled
 *     bookmark gets the numbered fallback title.
 *  3. Presentation mode wiring (R2-c): the button + native fullscreen
 *     with the fixed-overlay fallback, the auto-hiding control strip,
 *     click/arrow advance, the keyboard override (stopPropagation) and
 *     the i18n keys in BOTH catalogs.
 *
 * Run: bun scripts/smoke-view-outline.ts
 */
import { readFileSync } from "node:fs";

import { PDFDocument, StandardFonts } from "pdf-lib";

import { writeOutline, type BookmarkNode } from "../tools/bookmark-pdf/engine";

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

/* ================================================================== */
console.log("── 0. Wiring sanity (surface source) ──────────────────");
/* ================================================================== */
{
  const surface = readFileSync("tools/view-pdf/surface.tsx", "utf8");
  const config = readFileSync("tools/view-pdf/config.ts", "utf8");

  check(
    "outline tab renders ONLY when outline.length > 0",
    /\{outline\.length > 0 \? \(\s*<button[\s\S]*?ListTree/.test(surface)
  );
  check(
    "stale outline selection falls back to thumbs (activeTab derivation)",
    surface.includes(
      'const activeTab: "thumbs" | "outline" | null ='
    ) &&
      surface.includes('sidebar === "outline" && outline.length === 0')
  );
  check(
    "the empty-state paragraph is gone (no outlineEmpty render)",
    !surface.includes("view.outlineEmpty")
  );
  check(
    "pdf.js destination chain intact: getOutline → getDestination → getPageIndex",
    surface.includes("doc.getOutline()") &&
      surface.includes("doc.getDestination(") &&
      surface.includes("doc.getPageIndex(")
  );
  check(
    "outline rows keep click-to-scroll (goToPage on row click)",
    /outline\.map\(\(row, index\) =>[\s\S]{0,600}onClick=\{\(\) => goToPage\(row\.page\)\}/.test(
      surface
    )
  );
  check(
    "sidebar stays an overlay drawer on mobile, static on desktop (unchanged)",
    surface.includes("absolute inset-y-0 left-0 z-20") &&
      surface.includes("md:static")
  );
  check(
    "config still advertises the outline feature",
    config.includes("Thumbnails and outline in the sidebar")
  );
}

/* ================================================================== */
console.log("── 1. i18n parity (EN=HI) ─────────────────────────────");
/* ================================================================== */
{
  const en = JSON.parse(readFileSync("src/i18n/en.json", "utf8")) as Record<
    string,
    unknown
  >;
  const hi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8")) as Record<
    string,
    unknown
  >;
  const leaves = (node: unknown, prefix: string): string[] => {
    if (typeof node !== "object" || node === null) return [prefix];
    return Object.entries(node).flatMap(([key, value]) =>
      leaves(value, prefix === "" ? key : `${prefix}.${key}`)
    );
  };
  const enLeaves = new Set(leaves(en, ""));
  const hiLeaves = new Set(leaves(hi, ""));
  check(
    "catalog leaf parity holds after the removal",
    enLeaves.size === hiLeaves.size &&
      [...enLeaves].every((key) => hiLeaves.has(key)),
    { en: enLeaves.size, hi: hiLeaves.size }
  );
  check(
    "view.outlineTab exists in BOTH catalogs",
    enLeaves.has("view.outlineTab") && hiLeaves.has("view.outlineTab")
  );
  check(
    "view.outlineEmpty exists in NEITHER catalog (hidden-when-empty)",
    !enLeaves.has("view.outlineEmpty") && !hiLeaves.has("view.outlineEmpty")
  );
}

/* ================================================================== */
console.log("── 2. REAL pdf.js outline resolution ──────────────────");
/* ================================================================== */
{
  const node = (id: string, title: string, page: number, children: BookmarkNode[] = []): BookmarkNode => ({
    id,
    title,
    page,
    children,
  });

  const buildFixture = async (
    tree: BookmarkNode[]
  ): Promise<Uint8Array> => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 5; i += 1) {
      const page = doc.addPage([200, 300]);
      page.drawText(`Page ${i + 1}`, { x: 20, y: 150, size: 14, font });
    }
    const report = writeOutline(doc, tree);
    check(
      `fixture outline written (${report.written} items)`,
      report.written === treeLength(tree)
    );
    return doc.save();
  };

  const treeLength = (nodes: BookmarkNode[]): number =>
    nodes.reduce((sum, n) => sum + 1 + treeLength(n.children), 0);

  /** The surface's exact flattening walk (same API calls, same rules —
   *  keep in sync with tools/view-pdf/surface.tsx). */
  interface OutlineRow {
    title: string;
    page: number;
    depth: number;
  }
  const resolveOutline = async (
    bytes: Uint8Array
  ): Promise<OutlineRow[]> => {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await getDocument({
      data: bytes.slice(),
      verbosity: 0,
    }).promise;
    const raw = await doc.getOutline();
    if (!raw || raw.length === 0) return [];
    const rows: OutlineRow[] = [];
    const walk = async (
      items: typeof raw,
      depth: number
    ): Promise<void> => {
      for (const item of items) {
        let page = 0;
        try {
          const dest =
            typeof item.dest === "string"
              ? await doc.getDestination(item.dest)
              : item.dest;
          if (Array.isArray(dest) && dest.length > 0) {
            page = (await doc.getPageIndex(dest[0] as never)) + 1;
          }
        } catch {
          page = 0;
        }
        const title = (item.title ?? "").trim();
        if (page > 0) {
          rows.push({
            title: title.length > 0 ? title : `Bookmark ${rows.length + 1}`,
            page,
            depth,
          });
        }
        if (item.items && item.items.length > 0 && depth < 3) {
          await walk(item.items, depth + 1);
        }
      }
    };
    await walk(raw, 0);
    await doc.destroy();
    return rows;
  };

  /* --- nested tree → flattened rows with depth + page ---------------- */
  const nested = await buildFixture([
    node("a", "Introduction", 1),
    node("b", "Methods", 2, [
      node("b1", "Data collection", 3),
      node("b2", "Analysis", 4),
    ]),
    node("c", "Results", 5),
  ]);
  const rows = await resolveOutline(nested);
  check(
    "nested tree resolves to 5 rows (top-level + children)",
    rows.length === 5,
    rows
  );
  check(
    "rows carry title + destination page + depth",
    JSON.stringify(rows) ===
      JSON.stringify([
        { title: "Introduction", page: 1, depth: 0 },
        { title: "Methods", page: 2, depth: 0 },
        { title: "Data collection", page: 3, depth: 1 },
        { title: "Analysis", page: 4, depth: 1 },
        { title: "Results", page: 5, depth: 0 },
      ]),
    rows
  );

  /* --- no outline → zero rows = the tab-hiding predicate -------------- */
  const plainDoc = await PDFDocument.create();
  for (let i = 0; i < 3; i += 1) plainDoc.addPage([200, 300]);
  const plain = await resolveOutline(await plainDoc.save());
  check(
    "document without /Outlines resolves to zero rows (tab hidden)",
    plain.length === 0,
    plain
  );

  /* --- depth cap: the walk stops below depth 3 ------------------------ */
  const deep = await buildFixture([
    node("l1", "Level 1", 1, [
      node("l2", "Level 2", 2, [
        node("l3", "Level 3", 3, [
          node("l4", "Level 4", 4, [
            node("l5", "Level 5 (must be skipped)", 5),
          ]),
        ]),
      ]),
    ]),
  ]);
  const deepRows = await resolveOutline(deep);
  check(
    "walk respects the depth cap (Level 5 skipped, levels 1-4 kept)",
    deepRows.length === 4 &&
      deepRows.every((row, index) => row.depth === index) &&
      !deepRows.some((row) => row.title.includes("Level 5")),
    deepRows
  );

  /* --- untitled bookmarks get the numbered fallback ------------------- */
  const untitled = await buildFixture([
    node("u1", "", 1),
    node("u2", "   ", 2),
  ]);
  const untitledRows = await resolveOutline(untitled);
  check(
    "blank titles fall back to numbered bookmark names",
    untitledRows.length === 2 &&
      untitledRows[0].title === "Bookmark 1" &&
      untitledRows[1].title === "Bookmark 2",
    untitledRows
  );

  /* --- out-of-range destination pages are dropped, not crashed -------- */
  const bogus = await buildFixture([
    node("ok", "Real target", 2),
    node("bad", "No destination", 99), // clamped by normalizeTree → page 5
  ]);
  const bogusRows = await resolveOutline(bogus);
  check(
    "every row resolves to a real in-document page",
    bogusRows.length === 2 &&
      bogusRows.every((row) => row.page >= 1 && row.page <= 5),
    bogusRows
  );
}

/* ================================================================== */
console.log("── 3. Presentation mode wiring (R2-c) ─────────────────");
/* ================================================================== */
{
  const surface = readFileSync("tools/view-pdf/surface.tsx", "utf8");
  const en = JSON.parse(readFileSync("src/i18n/en.json", "utf8")) as Record<
    string,
    unknown
  >;
  const hi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8")) as Record<
    string,
    unknown
  >;
  const leaves = (node: unknown, prefix: string): string[] => {
    if (typeof node !== "object" || node === null) return [prefix];
    return Object.entries(node).flatMap(([key, value]) =>
      leaves(value, prefix === "" ? key : `${prefix}.${key}`)
    );
  };
  const enLeaves = new Set(leaves(en, ""));
  const hiLeaves = new Set(leaves(hi, ""));

  check(
    "presentation button renders (Presentation icon + enterPresentation)",
    surface.includes("<Presentation") && surface.includes("enterPresentation")
  );
  check(
    "native fullscreen requested, fixed-overlay fallback when unavailable",
    surface.includes("document.fullscreenEnabled") &&
      surface.includes("requestFullscreen") &&
      surface.includes("fixed inset-0 z-50")
  );
  check(
    "native Esc exit handled via the fullscreenchange event",
    surface.includes('addEventListener("fullscreenchange"') &&
      surface.includes("document.fullscreenElement")
  );
  check(
    "one fitted page at a time (dedicated stage + presScale fit math)",
    surface.includes("key=\"pres-page\"") && surface.includes("PRES_STAGE_PADDING")
  );
  check(
    "exit lands on the presented page only AFTER the fullscreen layout reverts (deferred presLandingRef + retries, never a scroll inside exitPresentation)",
    surface.includes("presLandingRef.current = target") &&
      surface.includes("presLandingRef.current = null") &&
      !surface.includes("scrollToPage(target, false)")
  );
  check(
    "controls auto-hide after ~2.5s; focus-within keeps them (a11y)",
    surface.includes("PRES_CONTROLS_HIDE_MS = 2500") &&
      surface.includes("focus-within:opacity-100")
  );
  check(
    "click-advance with a text-selection guard",
    surface.includes("handlePresClick") && surface.includes("getSelection()")
  );
  check(
    "presentation keys override the viewer shortcuts (stopPropagation) + focus trap",
    surface.includes("event.stopPropagation();") &&
      surface.includes("querySelectorAll<HTMLElement>")
  );
  check(
    "viewer chrome goes inert while presenting, restored on exit",
    surface.includes("inert={presenting || undefined}")
  );
  check(
    "i18n: view.present/presExit/presPageOf/presStage/presHint in BOTH catalogs",
    ["view.present", "view.presExit", "view.presPageOf", "view.presStage", "view.presHint"].every(
      (key) => enLeaves.has(key) && hiLeaves.has(key)
    )
  );
  check(
    "catalog leaf parity still holds after the new keys",
    enLeaves.size === hiLeaves.size &&
      [...enLeaves].every((key) => hiLeaves.has(key)),
    { en: enLeaves.size, hi: hiLeaves.size }
  );
}

/* ================================================================== */
console.log("");
console.log(`view outline smoke: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("FAILURES:", failures.join(" | "));
  process.exit(1);
}
process.exit(0);
