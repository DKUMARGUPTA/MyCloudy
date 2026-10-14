/**
 * Bookmark PDF smoke (P4.3) — engine tree-op unit checks + REAL pdf-lib
 * outline round-trips: write → save → reload with pdf.js → verify titles,
 * pages, nesting, then REPLACE an outline and verify the old tree is gone
 * and the file still parses. Exit code = failures.
 */
import { PDFDocument, PDFName, PDFDict, PDFRef } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  appendChild,
  appendRoot,
  classifyBookmarkError,
  countNodes,
  findNode,
  indentNode,
  insertAfterNode,
  moveNode,
  normalizeTree,
  outdentNode,
  removeNode,
  serializeTree,
  treeDepth,
  treeValid,
  updatePage,
  updateTitle,
  writeOutline,
  type BookmarkNode,
} from "../tools/bookmark-pdf/engine";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`  ✗ ${name}`);
  }
}

/* ---------------- fixtures ---------------- */

const n = (id: string, title: string, page: number, children: BookmarkNode[] = []): BookmarkNode => ({
  id,
  title,
  page,
  children,
});

/* ---------------- pure tree ops ---------------- */

const t0 = [n("a", "Intro", 1), n("b", "Chapter", 2), n("c", "End", 5)];
check("countNodes flat", countNodes(t0) === 3);
check("treeDepth flat", treeDepth(t0) === 1);
check("findNode hit/miss", findNode(t0, "b")?.title === "Chapter" && findNode(t0, "zz") === null);

check("updateTitle", updateTitle(t0, "b", "Kaksha")[1].title === "Kaksha" && t0[1].title === "Chapter");
check("updateTitle clamps 200", updateTitle(t0, "a", "x".repeat(300))[0].title.length === 200);
check("updatePage", updatePage(t0, "c", 4)[2].page === 4);

const removed = removeNode(t0, "b");
check("removeNode", removed.length === 2 && removed[1].title === "End");

const child = n("x", "New child", 2);
check("appendChild", appendChild(t0, "a", child)[0].children.length === 1);
check("appendRoot", appendRoot(t0, child).length === 4);
check("insertAfterNode", insertAfterNode(t0, "a", child)[1].id === "x");

const t1 = [n("a", "One", 1), n("b", "Two", 2), n("c", "Three", 3)];
check("moveNode down", moveNode(t1, "a", 1).map((x) => x.id).join("") === "bac");
check("moveNode up", moveNode(t1, "c", -1).map((x) => x.id).join("") === "acb");
check("moveNode boundary (first up)", moveNode(t1, "a", -1) === t1);
check("moveNode boundary (last down)", moveNode(t1, "c", 1) === t1);

// nested move only inside the right parent
const nested = [n("a", "A", 1, [n("a1", "A1", 1), n("a2", "A2", 2)]), n("b", "B", 3)];
const movedNested = moveNode(nested, "a1", 1);
check("moveNode nested", movedNested[0].children.map((x) => x.id).join("") === "a2a1" && movedNested[1].id === "b");

// indent: b becomes a child of a
const indented = indentNode(t1, "b");
check("indentNode parent got child", indented.length === 2 && indented[0].children[0]?.id === "b");
check("indentNode no previous sibling", indentNode(t1, "a") === t1);
// outdent brings it back
const outdented = outdentNode(indented, "b");
check("outdentNode restores", outdented.length === 3 && outdented.map((x) => x.id).join("") === "abc");
check("outdentNode root no-op", outdentNode(t1, "a").length === 3);
check("outdent keeps subtree", (() => {
  const deep = [n("a", "A", 1, [n("b", "B", 2, [n("c", "C", 3)])])];
  const out = outdentNode(deep, "b");
  return out.length === 2 && out[0].children.length === 0 && out[1].children[0]?.id === "c";
})());

// depth cap: indent at max depth is refused
const maxTree = [n("a", "1", 1, [n("b", "2", 1, [n("c", "3", 1, [n("d", "4", 1, [n("e", "5", 1, [n("f", "6", 1)])])])])])];
check("treeDepth 6", treeDepth(maxTree) === 6);
check("indent at cap refused", indentNode(maxTree, "f") === maxTree);

// validity
check("treeValid ok", treeValid(t1, 5));
check("treeValid empty title", !treeValid([n("a", "  ", 1)], 5));
check("treeValid page 0", !treeValid([n("a", "A", 0)], 5));
check("treeValid page over", !treeValid([n("a", "A", 6)], 5));
check("treeValid nested bad", !treeValid([n("a", "A", 1, [n("b", "B", 99)])], 5));

/* ---------------- serialization ---------------- */

const ser = serializeTree([
  { id: "q", title: "बुकमार्क", page: 2, children: [{ id: "r", title: "Inner", page: 3, children: [] }] },
]);
const back = normalizeTree(ser, 5);
check("serialize roundtrip count", back.length === 1 && back[0].children.length === 1);
check("serialize roundtrip devanagari", back[0].title === "बुकमार्क");
check("serialize roundtrip page", back[0].children[0].page === 3);
check("normalizeTree garbage", normalizeTree("not json", 5).length === 0);
check("normalizeTree bad shape", normalizeTree('{"v":1,"n":"nope"}', 5).length === 0);
check("normalizeTree drops empty titles", normalizeTree('{"v":1,"n":[{"t":"  ","p":1},{"t":"ok","p":1}]}', 5).length === 1);
check("normalizeTree clamps page", normalizeTree('{"v":1,"n":[{"t":"A","p":99}]}', 5)[0].page === 5);
check("normalizeTree clamps page low", normalizeTree('{"v":1,"n":[{"t":"A","p":-3}]}', 5)[0].page === 1);
check("normalizeTree depth cap", (() => {
  const deep6 = { t: "L", p: 1, c: [] as unknown[] };
  let cursor = deep6;
  for (let i = 0; i < 10; i += 1) {
    cursor.c = [{ t: "L" + i, p: 1, c: [] as unknown[] }];
    cursor = cursor.c[0] as typeof deep6;
  }
  return treeDepth(normalizeTree(JSON.stringify({ v: 1, n: [deep6] }), 9)) === 6;
})());
check("classifyBookmarkError", classifyBookmarkError(new Error("encrypted")) === "tool.errorEncrypted" && classifyBookmarkError(new Error("boom")) === "tool.errorCorrupt");

/* ---------------- real pdf-lib write + pdf.js read-back ---------------- */

async function makePdf(pages: number): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) {
    doc.addPage([595, 842]);
  }
  return doc;
}

async function readOutline(bytes: Uint8Array): Promise<{ titles: string[]; flat: Array<{ title: string; page: number; level: number }> }> {
  const doc = await getDocument({
    data: bytes.slice(),
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;
  const outline = (await doc.getOutline()) ?? [];
  const flat: Array<{ title: string; page: number; level: number }> = [];
  const walk = async (items: Array<{ title: string | null; dest: unknown; items: unknown[] }>, level: number): Promise<void> => {
    for (const item of items) {
      let dest = item.dest;
      if (typeof dest === "string") dest = await doc.getDestination(dest);
      const pageIndex = Array.isArray(dest) ? await doc.getPageIndex(dest[0]) : 0;
      flat.push({ title: item.title ?? "", page: pageIndex + 1, level });
      if (Array.isArray(item.items) && item.items.length > 0) {
        await walk(item.items as typeof items, level + 1);
      }
    }
  };
  await walk(outline, 0);
  const titles = flat.map((entry) => entry.title);
  await doc.destroy();
  return { titles, flat };
}

// 1. Write a fresh 3-level outline onto a 6-page PDF.
const doc1 = await makePdf(6);
const tree1 = [
  n("a", "मुखबंध", 1, [
    n("a1", "पहला अध्याय", 2),
    n("a2", "दूसरा अध्याय", 4, [n("a2a", "उप-अनुभाग", 5)]),
  ]),
  n("b", "Appendix", 6),
];
const report1 = writeOutline(doc1, tree1);
check("report counts", report1.written === 5 && report1.rootCount === 5 && report1.removed === 0);
const bytes1 = await doc1.save();
const read1 = await readOutline(bytes1);
check("readback count", read1.flat.length === 5);
check("readback titles incl. devanagari", JSON.stringify(read1.titles) === JSON.stringify(["मुखबंध", "पहला अध्याय", "दूसरा अध्याय", "उप-अनुभाग", "Appendix"]));
check("readback pages", read1.flat[1].page === 2 && read1.flat[3].page === 5 && read1.flat[4].page === 6);
check("readback nesting", read1.flat[1].level === 1 && read1.flat[3].level === 2 && read1.flat[4].level === 0);
check("catalog PageMode UseOutlines", (() => {
  // confirm on a fresh load of the saved bytes
  const check = PDFDocument.load(bytes1, { ignoreEncryption: true }).then((d) => {
    const mode = d.catalog.get(PDFName.of("PageMode"));
    return mode === PDFName.of("UseOutlines");
  });
  return check;
})() instanceof Promise ? await (async () => {
  const d = await PDFDocument.load(bytes1, { ignoreEncryption: true });
  return d.catalog.get(PDFName.of("PageMode")) === PDFName.of("UseOutlines");
})() : false);

// 2. REPLACE the outline: load bytes1, write a different tree, verify.
const doc2 = await PDFDocument.load(bytes1, { ignoreEncryption: true });
const tree2 = [n("x", "Only chapter", 3), n("y", "End", 6)];
const report2 = writeOutline(doc2, tree2);
check("replace report removed old items", report2.removed === 6 && report2.written === 2);
const bytes2 = await doc2.save();
const read2 = await readOutline(bytes2);
check("replace readback exact", JSON.stringify(read2.titles) === JSON.stringify(["Only chapter", "End"]));
check("replace readback pages", read2.flat[0].page === 3 && read2.flat[1].page === 6);
// old devanagari titles must NOT be present anywhere in the new file's outline
check("old titles gone", !read2.titles.some((title) => title.includes("अध्याय") || title.includes("मुखबंध")));

// 3. Empty tree REMOVES the outline entirely.
const doc3 = await PDFDocument.load(bytes2, { ignoreEncryption: true });
const report3 = writeOutline(doc3, []);
check("empty write removes", report3.written === 0);
const bytes3 = await doc3.save();
const read3 = await readOutline(bytes3);
check("empty readback none", read3.flat.length === 0);

// 4. Round-trip a serialized tree through normalizeTree → writeOutline
//    (the exact worker path).
const serialized = serializeTree(tree1);
const normalized = normalizeTree(serialized, 6);
const doc4 = await makePdf(6);
writeOutline(doc4, normalized);
const bytes4 = await doc4.save();
const read4 = await readOutline(bytes4);
check("worker path roundtrip", JSON.stringify(read4.titles) === JSON.stringify(["मुखबंध", "पहला अध्याय", "दूसरा अध्याय", "उप-अनुभाग", "Appendix"]));

// 5. An existing REAL outline made by another writer (pdf-lib low-level,
//    mimicking a foreign generator) survives load + replace without
//    corrupting the xref (pdf.js parses the final file fine).
const doc5 = await makePdf(3);
const foreignRoot = doc5.context.obj({ Type: PDFName.of("Outlines") });
const foreignRef = doc5.context.register(foreignRoot);
doc5.catalog.set(PDFName.of("Outlines"), foreignRef);
const foreignItem = doc5.context.obj({ Title: doc5.context.obj("Foreign"), Parent: foreignRef });
const foreignItemRef = doc5.context.register(foreignItem);
foreignRoot.set(PDFName.of("First"), foreignItemRef);
foreignRoot.set(PDFName.of("Last"), foreignItemRef);
foreignRoot.set(PDFName.of("Count"), doc5.context.obj(1));
// a cycle-style malformed link must not hang the collector
foreignItem.set(PDFName.of("Next"), foreignItemRef);
const report5 = writeOutline(doc5, [n("z", "Mine", 2)]);
check("cycle-safe replace", report5.written === 1);
const read5 = await readOutline(await doc5.save());
check("cycle-safe readback", JSON.stringify(read5.titles) === JSON.stringify(["Mine"]));

console.log(`bookmark smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
