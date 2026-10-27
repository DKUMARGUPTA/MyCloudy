/**
 * TEMPORARY probe (RB4-a) — grounds the pdf.js 4.10.38 operator-list shapes
 * for pdf-to-svg: constructPath args, showText glyph objects, setFont refs,
 * color args, paintImageXObject args, and the font object in commonObjs.
 * Deleted once the model is settled.
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

const NAME_BY_CODE = new Map<number, string>();
for (const [k, v] of Object.entries(OPS as unknown as Record<string, number>)) {
  NAME_BY_CODE.set(v, k);
}

async function main(): Promise<void> {
  /* ---- fixture: EN text, bold, Hindi, colored rect, PNG image ---- */
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const notoBytes = readFileSync(
    new URL("./public/fonts/NotoSansDevanagari-Regular.ttf", import.meta.url)
  );
  const noto = await doc.embedFont(notoBytes, { subset: true });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  // 2x2 PNG: red, green / blue, yellow
  const px = new Uint8ClampedArray(4 * 4 * 4);
  const cols = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
  ];
  for (let i = 0; i < 4; i++) {
    px[i * 4] = cols[i][0];
    px[i * 4 + 1] = cols[i][1];
    px[i * 4 + 2] = cols[i][2];
    px[i * 4 + 3] = 255;
  }
  const { pngEncode } = await import("./tools/imgconv/png-encode");
  const pngBlob = pngEncode({ width: 2, height: 2, data: px });
  const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
  const img = await doc.embedPng(pngBytes);

  const page = doc.addPage([595.28, 841.89]);
  page.drawText("Quarterly Report", { x: 72, y: 720, size: 22, font: bold });
  page.drawText("Hello plain body", { x: 72, y: 680, size: 11, font: helv });
  const x2 = 72 + helv.widthOfTextAtSize("plain then ", 11);
  page.drawText("plain then ", { x: 72, y: 640, size: 11, font: helv });
  page.drawText("bold bit", { x: x2, y: 640, size: 11, font: bold });
  page.drawText("नमस्ते दुनिया", { x: 72, y: 600, size: 14, font: noto });
  page.drawRectangle({
    x: 72,
    y: 500,
    width: 200,
    height: 40,
    color: rgb(0.2, 0.4, 0.9),
    borderColor: rgb(0.9, 0.1, 0.1),
    borderWidth: 2,
  });
  page.drawImage(img, { x: 300, y: 300, width: 120, height: 60 });
  const fixture = await doc.save();
  const bytes = new Uint8Array(fixture);

  console.log("pdf-lib expected: 'Hello plain body' at (72, 680) size 11");
  console.log(
    `pdf-lib expected: bold bit starts at x=${x2.toFixed(2)} (width of "plain then " = ${helv
      .widthOfTextAtSize("plain then ", 11)
      .toFixed(2)})`
  );

  const task = getDocument({ data: bytes.slice(), useSystemFonts: true });
  const pdf = await task.promise;
  const p = await pdf.getPage(1);
  const vp = p.getViewport({ scale: 1 });
  console.log("viewport:", {
    width: vp.width,
    height: vp.height,
    transform: vp.transform,
    view: p.view,
    rotate: p.rotate,
  });

  const ops = await p.getOperatorList();
  console.log(`\nfnArray length: ${ops.fnArray.length}\n`);

  const seen = new Set<string>();
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const name = NAME_BY_CODE.get(fn) ?? `#${fn}`;
    const args = ops.argsArray[i];
    if (name === "dependency") continue;
    seen.add(name);
    let dump = "";
    try {
      dump = JSON.stringify(args, (_k, v) => {
        if (typeof v === "number") {
          return Math.round(v * 1000) / 1000;
        }
        return v;
      });
    } catch {
      dump = String(args);
    }
    if (dump && dump.length > 400) dump = `${dump.slice(0, 400)}…LEN=${dump.length}`;
    console.log(`${i}: ${name} ${dump}`);
  }

  /* ---- font objects from commonObjs ---- */
  console.log("\n--- font objects (commonObjs via callback form) ---");
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (ops.fnArray[i] !== OPS.setFont) continue;
    const ref = ops.argsArray[i][0];
    if (typeof ref !== "string") continue;
    const pool = ref.startsWith("g_") ? p.commonObjs : p.objs;
    const data = await new Promise<Record<string, unknown>>((resolve) => {
      pool.get(ref, (d: unknown) => resolve(d as Record<string, unknown>));
    });
    console.log(`ref=${ref} keys=${Object.keys(data).join(",")}`);
    console.log(
      `  name=${String(data.name)} loadedName=${String(data.loadedName)} fallbackName=${String(
        data.fallbackName
      )} black=${String(data.black)} bold=${String(data.bold)} italic=${String(
        data.italic
      )} vertical=${String(data.vertical)}`
    );
  }

  /* ---- image object from objs ---- */
  console.log("\n--- image objects ---");
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (
      fn !== OPS.paintImageXObject &&
      fn !== OPS.paintInlineImageXObject &&
      fn !== OPS.paintImageXObjectRepeat
    ) {
      continue;
    }
    console.log(`${NAME_BY_CODE.get(fn)} args:`, JSON.stringify(ops.argsArray[i], (_k, v) => (typeof v === "object" && v !== null && !(v instanceof Uint8Array) ? Object.keys(v) : typeof v === "number" ? Math.round(v * 100) / 100 : v)));
    const ref = ops.argsArray[i][0];
    if (typeof ref === "string") {
      const pool = ref.startsWith("g_") ? p.commonObjs : p.objs;
      const data = (await new Promise<unknown>((resolve) => {
        pool.get(ref, (d: unknown) => resolve(d));
      })) as Record<string, unknown>;
      if (data && typeof data === "object") {
        console.log(
          `  img ${ref}: keys=${Object.keys(data).join(",")} width=${String(
            data.width
          )} height=${String(data.height)} kind=${String(data.kind)} dataLen=${(
            data.data as Uint8Array | undefined
          )?.length}`
        );
      }
    }
  }

  await p.cleanup();
  await pdf.cleanup();
  await task.destroy();
}

main().catch((e: unknown) => {
  console.error("probe crashed:", e);
  process.exit(1);
});
