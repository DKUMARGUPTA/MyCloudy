/**
 * PRE-BUILD smoke for PHASE-3 batch 4 (pdf-layers). Everything drives
 * the pure engine with the crafted raw OCG fixture in Node.
 *
 *  1. READ: fixture tree (names, visibility, lock, nesting via /Order
 *     arrays, out-of-Order OCG completeness, plain-PDF empty).
 *  2. TOGGLE: hidden → visible (ON gains, OFF loses) and reverse.
 *  3. ADD: top-level + child (Order nesting + OCGs list + fresh objects).
 *  4. DELETE: from OCGs + ON/OFF + Order (nested too).
 *  5. Round trip: toggle+add+delete in ONE run; oracle reload.
 *  6. Honest errors: nothing-to-do.
 *  7. Registry: 135 live tools.
 *
 * Run: bun scripts/smoke-p3b4.ts
 */
import { PDFDocument } from "pdf-lib";

import {
  applyLayerOps,
  craftOcgFixture,
  readLayers,
} from "../tools/pdf-layers/engine";
import { parseOps } from "../tools/pdf-layers/worker";
import { latin1, parsePdf, asDict, resolve } from "../src/lib/own/pdf";
import { liveToolCount } from "../src/lib/tools/registry";

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const latin1All = (b: Uint8Array) => latin1(b, 0, b.length);

/** The /D config dict of a doc (post-rewrite docs point /OCProperties at it). */
function configDict(bytes: Uint8Array) {
  const doc = parsePdf(bytes);
  const rootObj = doc.trailer.get("Root");
  const catalog = rootObj?.k === "ref" ? doc.getObject(rootObj.num) : rootObj;
  const ocp = asDict(resolve(doc, asDict(catalog)?.get("OCProperties")));
  const d = asDict(resolve(doc, ocp?.get("D")));
  const ocgsArr = ocp?.get("OCGs");
  return {
    doc,
    d,
    ocp,
    ocgs: ocgsArr?.k === "arr" ? ocgsArr.items : [],
    raw: latin1All(bytes),
  };
}

/** OCG numbers listed in an /ON or /OFF array. */
function visNums(bytes: Uint8Array, key: string): number[] {
  const { d } = configDict(bytes);
  const arr = d?.get(key);
  if (arr?.k !== "arr") return [];
  return arr.items
    .filter((o): o is { k: "ref"; num: number } => o.k === "ref")
    .map((o) => o.num);
}

/* ------------------------------------------------------------------ */
console.log("1. readLayers — fixture tree");

{
  const fixture = craftOcgFixture();
  const layerDoc = readLayers(fixture);
  check("read: parses fixture", parsePdf(fixture) !== null);
  check("read: 2 OCGs total", layerDoc.all.length === 2, JSON.stringify(layerDoc.all));
  check("read: 2 tree nodes", layerDoc.tree.length === 2, String(layerDoc.tree.length));
  const bg = layerDoc.tree.find((n) => n.name === "Background");
  const ann = layerDoc.tree.find((n) => n.name === "Annotations");
  check("read: Background found + visible", bg !== undefined && bg.visible, JSON.stringify(layerDoc.tree.map((n) => [n.name, n.visible])));
  check("read: Annotations hidden", ann !== undefined && !ann.visible);

  // /Order [6 0 R [8 0 R]] — object 8 is an OCMD (not an OCG) inside the
  // nested array; readNode drops non-OCG dicts honestly.
  check("read: nested slot handled (OCMD not an OCG)", layerDoc.tree.every((n) => n.name !== "Layer 8"));

  // Plain PDF (no OCGs) → empty.
  const plain = await PDFDocument.create();
  plain.addPage([100, 100]);
  const plainBytes = new Uint8Array(await plain.save());
  const empty = readLayers(plainBytes);
  check("read: plain PDF empty tree", empty.tree.length === 0 && empty.all.length === 0);
}

/* ------------------------------------------------------------------ */
console.log("2. toggle visibility");

{
  const fixture = craftOcgFixture();
  // Annotations (obj 7) hidden → visible.
  const out = applyLayerOps(fixture, {
    toggles: [{ num: 7, visible: true }],
    adds: [],
    deletes: [],
  });
  check("toggle: hidden → visible applied", !visNums(out.bytes, "OFF").includes(7));
  check("toggle: ON gains 7", visNums(out.bytes, "ON").includes(7));
  const reread = readLayers(out.bytes);
  check("toggle: reread shows visible", reread.tree.find((n) => n.num === 7)?.visible === true, JSON.stringify(reread.tree.map((n) => [n.name, n.visible])));

  // Background (obj 6) visible → hidden.
  const out2 = applyLayerOps(fixture, {
    toggles: [{ num: 6, visible: false }],
    adds: [],
    deletes: [],
  });
  check("toggle: visible → hidden applied", visNums(out2.bytes, "OFF").includes(6));
  const reread2 = readLayers(out2.bytes);
  check("toggle: reread shows hidden", reread2.tree.find((n) => n.num === 6)?.visible === false);

  const oracle = await PDFDocument.load(out2.bytes);
  check("toggle: pdf-lib oracle reload", oracle.getPageCount() === 1);
}

/* ------------------------------------------------------------------ */
console.log("3. add layers (top + child)");

{
  const fixture = craftOcgFixture();
  const out = applyLayerOps(fixture, {
    adds: [
      { name: "Dimensions" },
      { name: "Grid", parent: 6 }, // child of Background
    ],
  });
  const { doc, ocgs, raw } = configDict(out.bytes);
  check("add: OCGs grew to 4", ocgs.length === 4, String(ocgs.length));

  // Fresh OCG object exists with the right name.
  const findOcgByName = (wanted: string): number | null => {
    for (const item of ocgs) {
      if (item.k !== "ref") continue;
      const dict = asDict(doc.getObject(item.num));
      const nm = dict?.get("Name");
      if (nm && (nm.k === "str" || nm.k === "lstr")) {
        if (new TextDecoder().decode(nm.b) === wanted) return item.num;
      }
    }
    return null;
  };
  const dimNum = findOcgByName("Dimensions");
  const gridNum = findOcgByName("Grid");
  check("add: Dimensions object exists", dimNum !== null);
  check("add: Grid object exists", gridNum !== null);
  check("add: /Type /OCG marker", raw.includes("/OCG"));

  // Order: Dimensions at top level; Grid nested after Background (obj 6
  // is followed by an array containing the Grid ref).
  const orderIdx6 = raw.indexOf("6 0 R");
  const orderIdxGrid = gridNum !== null ? raw.indexOf(`${gridNum} 0 R`) : -1;
  check("add: order preserved", orderIdx6 > 0 && orderIdxGrid > orderIdx6);

  const reread = readLayers(out.bytes);
  check("add: reread tree has 4 nodes", reread.tree.length + reread.tree.reduce((s, n) => s + n.children.length, 0) === 4, JSON.stringify(reread.tree.map((n) => [n.name, n.children.length])));
  const rereadGrid = reread.tree.flatMap((n) => n.children).find((n) => n.name === "Grid");
  check("add: Grid nests under a parent", rereadGrid !== undefined && rereadGrid.depth === 1);
  check("add: new layers default visible", rereadGrid?.visible === true);

  const oracle = await PDFDocument.load(out.bytes);
  check("add: oracle reload", oracle.getPageCount() === 1);
}

/* ------------------------------------------------------------------ */
console.log("4. delete layers");

{
  const fixture = craftOcgFixture();
  const out = applyLayerOps(fixture, {
    deletes: [7], // Annotations
  });
  const { ocgs, raw } = configDict(out.bytes);
  check("delete: OCGs shrinks to 1", ocgs.length === 1, String(ocgs.length));
  check("delete: OFF emptied", visNums(out.bytes, "OFF").length === 0);
  const reread = readLayers(out.bytes);
  check("delete: reread only Background", reread.tree.length === 1 && reread.tree[0]?.name === "Background");
  check("delete: deleted name gone", !raw.includes("(Annotations)"));
  const oracle = await PDFDocument.load(out.bytes);
  check("delete: oracle reload", oracle.getPageCount() === 1);
}

/* ------------------------------------------------------------------ */
console.log("5. combined round trip + parseOps validation");

{
  const fixture = craftOcgFixture();
  const out = applyLayerOps(fixture, {
    toggles: [{ num: 7, visible: true }],
    adds: [{ name: "Markup" }],
    deletes: [6],
  });
  const reread = readLayers(out.bytes);
  const names = reread.tree.map((n) => n.name).sort();
  check("combo: Background deleted, Annotations+Markup live", names.length === 2 && names[0] === "Annotations" && names[1] === "Markup", JSON.stringify(names));
  check("combo: Annotations now visible", reread.tree.find((n) => n.name === "Annotations")?.visible === true);
  const oracle = await PDFDocument.load(out.bytes);
  check("combo: oracle reload", oracle.getPageCount() === 1);

  // parseOps: bad payloads degrade to empty.
  check("ops: bad JSON", parseOps("x{").toggles?.length === 0);
  check(
    "ops: bad shapes dropped",
    (() => {
      const ops = parseOps(
        JSON.stringify({ toggles: [{ num: -1, visible: true }, { num: 7, visible: "yes" }, null], adds: [{ name: "   " }, { name: "ok" }], deletes: ["7", 7.5] })
      );
      return (
        ops.toggles?.length === 1 &&
        ops.toggles[0]?.num === 7 &&
        ops.toggles[0]?.visible === false &&
        ops.adds?.length === 1 &&
        ops.adds[0]?.name === "ok" &&
        ops.deletes?.length === 0
      );
    })()
  );

  // Honest nothing-to-do.
  let nothing: string | null = null;
  try {
    applyLayerOps(fixture, { toggles: [], adds: [], deletes: [] });
  } catch (error) {
    nothing = (error as Error).message;
  }
  check("ops: nothing-to-do error", nothing === "pl.errorNothingToDo", String(nothing));
}

/* ------------------------------------------------------------------ */
console.log("6. registry — live tool count");

{
  // 134 + 1 = 135 live, 138 total (3 AI deferred).
  check("registry: 141 live tools", liveToolCount === 141, String(liveToolCount));
}

/* ------------------------------------------------------------------ */
console.log("");
console.log(`smoke-p3b4: ${pass} pass, ${fail} fail`);
if (fail > 0) {
  process.exit(1);
}
