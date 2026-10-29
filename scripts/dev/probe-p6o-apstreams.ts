/** P6-o probe: inflate the pdf-lib appearance streams to see exact ops. */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { inflateSync } from "node:zlib";
import { parsePdf, resolve } from "../../src/lib/own/pdf/parser";
import type { PdfObj } from "../../src/lib/own/pdf/objects";

function show(obj: PdfObj & { k: "stream" }, label: string): void {
  let text: string;
  try {
    text = new TextDecoder("latin1").decode(inflateSync(Buffer.from(obj.raw)));
  } catch {
    text = new TextDecoder("latin1").decode(obj.raw);
  }
  console.log(`\n--- ${label} (len=${obj.raw.length}) ---\n${text}`);
}

async function main(): Promise<void> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();

  const tf = form.createTextField("T1");
  tf.setText("hello world");
  tf.addToPage(page, { x: 100, y: 700, width: 200, height: 20, borderWidth: 1, borderColor: rgb(0.62, 0.65, 0.7) });

  const tfm = form.createTextField("T2");
  tfm.enableMultiline();
  tfm.setText("the quick brown fox\njumps over");
  tfm.addToPage(page, { x: 100, y: 600, width: 200, height: 60, borderWidth: 0 });

  const cb = form.createCheckBox("C1");
  cb.addToPage(page, { x: 100, y: 500, width: 14, height: 14, borderWidth: 1, borderColor: rgb(0.45, 0.49, 0.55) });

  const rg = form.createRadioGroup("R1");
  rg.addOptionToPage("S", page, { x: 100, y: 300, width: 14, height: 14, borderWidth: 1, borderColor: rgb(0.45, 0.49, 0.55) });

  const bytes = await doc.save();
  const parsed = parsePdf(bytes);
  for (let n = 1; n <= 60; n++) {
    const obj = parsed.getObject(n);
    if (!obj || obj.k !== "stream") continue;
    const bb = obj.m.get("BBox");
    if (!bb) continue; // page content
    const sub = obj.m.get("Subtype");
    if (sub && sub.k === "name" && sub.v === "Form") {
      const bbArr = bb.k === "arr" ? bb.items.map((i) => (i.k === "num" ? i.n : "?")).join(" ") : "?";
      show(obj, `obj ${n} BBox[${bbArr}]`);
    }
  }
  // DA strings
  const root = resolve(parsed, parsed.trailer.get("Root")!);
  const afRef = root && root.k === "dict" ? root.m.get("AcroForm") : undefined;
  if (afRef && afRef.k === "ref") {
    const af = resolve(parsed, afRef);
    if (af && af.k === "dict") {
      const fields = af.m.get("Fields");
      if (fields && fields.k === "arr") {
        for (const f of fields.items) {
          if (f.k !== "ref") continue;
          const fd = resolve(parsed, f);
          if (!fd || fd.k !== "dict") continue;
          const da = fd.m.get("DA");
          const t = fd.m.get("T");
          const tn = t && t.k === "str" ? new TextDecoder("latin1").decode(t.b.slice(2)) : "?";
          const das = da && (da.k === "str" || da.k === "hstr") ? new TextDecoder("latin1").decode(da.b) : "?";
          console.log(`\nfield "${tn}" DA = ${JSON.stringify(das)}`);
        }
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
