/** Scratch: exact code points of देवनागरी in the word-to-pdf artifact vs
 *  what fontkit's shaper does to ी. DELETE AFTER. */
import { readFile } from "node:fs/promises";

const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
const bytes = new Uint8Array(await readFile("download/qa-word-to-pdf-output.pdf"));
const doc = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
for (let p = 1; p <= doc.numPages; p += 1) {
  const page = await doc.getPage(p);
  const content = await page.getTextContent();
  for (const raw of content.items) {
    const item = raw as { str?: string };
    const str = item.str ?? "";
    if (/[\u0900-\u097f]/.test(str)) {
      const idx = str.indexOf("देवनाग");
      if (idx >= 0) {
        const chunk = str.slice(idx, idx + 10);
        console.log("chunk:", JSON.stringify(chunk));
        console.log(
          "cps  :",
          Array.from(chunk)
            .map((c) => `U+${c.charCodeAt(0).toString(16)}`)
            .join(" ")
        );
      }
    }
  }
  page.cleanup();
}
