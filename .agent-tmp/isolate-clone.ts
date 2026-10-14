/**
 * Isolate the DataCloneError: walk → destroy → walk again.
 */
import { PDFDocument } from "pdf-lib";

async function buildFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const png = await doc.embedPng(
    new Uint8Array(Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAGUlEQVR4nGP8z8Agx8DAIIMLMzEQAMNDAQDomAHxQ9TxBwAAAABJRU5ErkJggg==",
      "base64"
    ))
  );
  const red = await doc.embedJpg(
    new Uint8Array(Buffer.from(
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDwSiiivz8/uA//2Q==",
      "base64"
    ))
  );
  const p1 = doc.addPage([400, 300]);
  p1.drawText("page one", { x: 20, y: 280 });
  p1.drawImage(png, { x: 20, y: 200, width: 60, height: 60 });
  p1.drawImage(red, { x: 100, y: 200, width: 60, height: 60 });
  const p2 = doc.addPage([400, 300]);
  p2.drawImage(red, { x: 20, y: 200, width: 60, height: 60 });
  return new Uint8Array(await doc.save());
}

interface Lib {
  OPS: Record<string, number>;
  getDocument(config: Record<string, unknown>): { promise: Promise<Doc> };
}
interface Doc {
  numPages: number;
  getPage(pageNumber: number): Promise<Page>;
  destroy(): Promise<void>;
}
interface Page {
  objs: { get(id: string, cb: (data: unknown) => void): null };
  commonObjs: { get(id: string, cb: (data: unknown) => void): null };
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
}

async function walk(bytes: Uint8Array, label: string): Promise<void> {
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as Lib;
  const doc = await pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    useSystemFonts: false,
    standardFontDataUrl: "public/pdfjs/standard_fonts/",
  }).promise;
  console.log(label, "pages:", doc.numPages);
  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const ops = await page.getOperatorList();
    for (let i = 0; i < ops.fnArray.length; i += 1) {
      if (ops.fnArray[i] === pdfjs.OPS.paintImageXObject) {
        const objId = ops.argsArray[i][0] as string;
        const pool = objId.startsWith("g_") ? page.commonObjs : page.objs;
        await new Promise<void>((resolve) => {
          pool.get(objId, (data) => {
            console.log(label, `p${p} ${objId} w=${(data as { width: number }).width}`);
            resolve();
          });
        });
      }
    }
  }
  console.log(label, "walk done, destroying…");
  await doc.destroy();
  console.log(label, "destroyed");
}

async function main(): Promise<void> {
  const fixture = await buildFixture();
  await walk(fixture, "WALK1");
  await new Promise((r) => setTimeout(r, 50));
  await walk(fixture, "WALK2");
  console.log("ALL OK");
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error("FAILED:", error);
  process.exit(1);
});
