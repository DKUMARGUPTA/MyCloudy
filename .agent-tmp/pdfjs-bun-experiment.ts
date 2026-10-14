/**
 * Experiment: can pdf.js (legacy build) run in bun headless for
 * getOperatorList + image objs extraction?
 */
import { readFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";

async function main() {
  const jpgA = new Uint8Array(await readFile(".agent-tmp/fx-a.jpg"));
  const jpgB = new Uint8Array(await readFile(".agent-tmp/fx-b.jpg"));
  const png = new Uint8Array(await readFile(".agent-tmp/fx-c.png"));

  const doc = await PDFDocument.create();
  const pngImg = await doc.embedPng(png);
  const jpgAImg = await doc.embedJpg(jpgA);
  const jpgBImg = await doc.embedJpg(jpgB);
  const page = doc.addPage([300, 200]);
  page.drawImage(pngImg, { x: 10, y: 10, width: 40, height: 40 });
  page.drawImage(jpgAImg, { x: 60, y: 10, width: 40, height: 40 });
  page.drawImage(jpgBImg, { x: 110, y: 10, width: 40, height: 40 });
  const bytes = await doc.save();
  console.log("fixture bytes:", bytes.length);

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false,
  });
  const pdf = await task.promise;
  console.log("numPages:", pdf.numPages);
  const page1 = await pdf.getPage(1);
  const ops = await page1.getOperatorList();
  const OPS = pdfjs.OPS;
  console.log(
    "paintImageXObject:",
    OPS.paintImageXObject,
    "Repeat:",
    OPS.paintImageXObjectRepeat,
    "Inline:",
    OPS.paintInlineImageXObject
  );
  for (let i = 0; i < ops.fnArray.length; i += 1) {
    const fn = ops.fnArray[i];
    if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
      const objId = ops.argsArray[i][0];
      console.log(`op#${i} fn=${fn} objId=${JSON.stringify(objId)} argsLen=${ops.argsArray[i].length}`);
      const pool = String(objId).startsWith("g_") ? page1.commonObjs : page1.objs;
      await new Promise<void>((resolve) => {
        pool.get(objId, (data: unknown) => {
          const d = data as { width?: number; height?: number; kind?: number; bitmap?: unknown; data?: Uint8Array } | null;
          console.log(
            "  -> resolved:",
            d === null
              ? "null"
              : `w=${d.width} h=${d.height} kind=${d.kind} hasBitmap=${!!d.bitmap} hasData=${!!d.data}${
                  d.data ? ` dataLen=${d.data.length}` : ""
                }`
          );
          resolve();
        });
      });
    } else if (fn === OPS.paintInlineImageXObject) {
      const d = ops.argsArray[i][0] as { width?: number; height?: number; kind?: number; data?: Uint8Array };
      console.log(
        `op#${i} INLINE w=${d.width} h=${d.height} kind=${d.kind} dataLen=${d.data?.length}`
      );
    }
  }
  console.log("DONE");
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error("EXPERIMENT FAILED:", error);
  process.exit(1);
});
