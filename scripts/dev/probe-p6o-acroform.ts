/**
 * P6-o AcroForm probe: the EXACT pdf-lib form-field object graph.
 *
 * Creates text (plain + multiline + setText), checkbox (unchecked + checked),
 * dropdown (options + select), radio group (2 options via addOptionToPage)
 * on a real page, saves, then re-parses the output with OUR parser and dumps
 * every object — the target graph the own-engine AcroForm builder must
 * reproduce (modulo object numbering).
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { parsePdf, resolve } from "../../src/lib/own/pdf/parser";
import type { PdfObj } from "../../src/lib/own/pdf/objects";

function dump(obj: PdfObj, depth = 0, seen = new Set<number>()): string {
  const pad = "  ".repeat(depth);
  switch (obj.k) {
    case "num":
      return String(obj.n);
    case "bool":
      return String(obj.b);
    case "null":
      return "null";
    case "name":
      return `/${obj.v}`;
    case "ref":
      return seen.has(obj.num)
        ? `${obj.num} 0 R (cycle)`
        : `${obj.num} 0 R`;
    case "newref":
      return `newref(${obj.num})`;
    case "str":
    case "hstr":
    case "lstr": {
      const bytes = Array.from(obj.b, (b) =>
        b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, "0")}`,
      ).join("");
      return `${obj.k === "str" ? "hexstr" : obj.k}(len=${obj.b.length}): "${bytes.slice(0, 120)}"`;
    }
    case "arr":
      return (
        "[\n" +
        obj.items
          .map((it) => `${pad}  ${dump(it, depth + 1, seen)}`)
          .join("\n") +
        `\n${pad}]`
      );
    case "dict": {
      const rows = [...obj.m.entries()].map(
        ([k, v]) => `${pad}  /${k} ${dump(v, depth + 1, seen)}`,
      );
      return `<<\n${rows.join("\n")}\n${pad}>>`;
    }
    case "stream": {
      const dictRows = [...obj.m.entries()]
        .filter(([k]) => k !== "Length")
        .map(([k, v]) => `${pad}  /${k} ${dump(v, depth + 1, seen)}`)
        .join("\n");
      const body = new TextDecoder("latin1").decode(obj.raw.slice(0, 300));
      return `STREAM<<\n${dictRows}\n${pad}>> len=${obj.raw.length} ops:\n${pad}  ${body.split("\n").join(`\n${pad}  `)}`;
    }
  }
}

async function main(): Promise<void> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);

  const form = doc.getForm();

  // Text field (make-pdf-fillable shape)
  const tf = form.createTextField("Full Name");
  tf.addToPage(page, {
    x: 100,
    y: 700,
    width: 200,
    height: 20,
    borderWidth: 1,
    borderColor: rgb(0.62, 0.65, 0.7),
  });

  // Multiline + default text (edit-pdf shape)
  const tf2 = form.createTextField("Notes");
  tf2.enableMultiline();
  tf2.setText("hello world");
  tf2.addToPage(page, {
    x: 100,
    y: 600,
    width: 200,
    height: 60,
    borderWidth: 0,
  });

  // Checkbox unchecked + checked
  const cb = form.createCheckBox("Agree");
  cb.addToPage(page, {
    x: 100,
    y: 500,
    width: 14,
    height: 14,
    borderWidth: 1,
    borderColor: rgb(0.45, 0.49, 0.55),
  });
  const cb2 = form.createCheckBox("Agree2");
  cb2.check();
  cb2.addToPage(page, {
    x: 130,
    y: 500,
    width: 14,
    height: 14,
    borderWidth: 1,
    borderColor: rgb(0.45, 0.49, 0.55),
  });

  // Dropdown + options + selection
  const dd = form.createDropdown("City");
  dd.addOptions(["Mumbai", "Delhi", "Pune"]);
  dd.select("Pune");
  dd.addToPage(page, {
    x: 100,
    y: 400,
    width: 150,
    height: 18,
    borderWidth: 1,
    borderColor: rgb(0.62, 0.65, 0.7),
  });

  // Radio group with 2 options (separate spots)
  const rg = form.createRadioGroup("Size");
  rg.addOptionToPage("S", page, {
    x: 100,
    y: 300,
    width: 14,
    height: 14,
    borderWidth: 1,
    borderColor: rgb(0.45, 0.49, 0.55),
  });
  rg.addOptionToPage("L", page, {
    x: 130,
    y: 300,
    width: 14,
    height: 14,
    borderWidth: 1,
    borderColor: rgb(0.45, 0.49, 0.55),
  });

  // Text field on the page too (font presence probe: does the form reference helv?)
  page.drawText("probe", { x: 20, y: 20, size: 10, font: helv });

  const bytes = await doc.save();
  console.log(`saved ${bytes.length} bytes`);

  const parsed = parsePdf(bytes);
  for (let n = 1; n <= 60; n++) {
    const obj = parsed.getObject(n);
    if (!obj) continue;
    if (obj.k === "stream" && obj.m.size === 1 && obj.m.has("Length")) {
      // skip plain content streams of pages
      const txt = new TextDecoder("latin1").decode(obj.raw.slice(0, 60));
      if (!/^\s*(q|BT)/.test(txt)) {
        console.log(`\n=== obj ${n} ===\n${dump(obj)}`);
        continue;
      }
    }
    const txt = dump(obj, 0, new Set([n]));
    // skip boring known pages/catalog; print everything else
    if (/\/Catalog/.test(txt) || /\/Type \/Pages/.test(txt)) continue;
    if (/\/Type \/Page\b/.test(txt) && /\/MediaBox/.test(txt) && !/\/Annots/.test(txt)) {
      continue;
    }
    console.log(`\n=== obj ${n} ===\n${txt}`);
  }
  // Also resolve the trailer /Root → catalog to see /AcroForm
  const root = resolve(parsed, parsed.trailer.get("Root")!);
  if (root) {
    console.log(`\n=== CATALOG ===\n${dump(root, 0, new Set())}`);
  }
  const acroformRef = root && root.k === "dict" ? root.m.get("AcroForm") : undefined;
  if (acroformRef && acroformRef.k === "ref") {
    const af = resolve(parsed, acroformRef);
    if (af) console.log(`\n=== ACROFORM ===\n${dump(af, 0, new Set([acroformRef.num]))}`);
  }

  // heightAtSize ascent probe for the 12 std fonts
  console.log("\n=== heightAtSize(descender:false) per std font ===");
  for (const [name, sf] of Object.entries(StandardFonts)) {
    try {
      const f = await doc.embedFont(sf);
      console.log(`${name}: ${f.heightAtSize(10, { descender: false })}`);
    } catch (e) {
      console.log(`${name}: ERR ${String(e)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
