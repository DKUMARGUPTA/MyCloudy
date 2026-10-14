import { PDFDocument, PDFName, PDFHexString } from "pdf-lib";
import { writeFileSync } from "node:fs";
import { writeOutline } from "../tools/bookmark-pdf/engine";

const doc = await PDFDocument.create();
for (let i = 0; i < 8; i++) {
  const page = doc.addPage([595, 842]);
  page.drawText(`Page ${i + 1}`, { x: 60, y: 780, size: 18 });
}
// Foreign-style existing outline (as another generator would write)
writeOutline(doc, [
  { id: "1", title: "परिचय", page: 1, children: [] },
  { id: "2", title: "अध्याय एक", page: 2, children: [
    { id: "3", title: "विषय 1.1", page: 3, children: [] },
    { id: "4", title: "विषय 1.2", page: 4, children: [] },
  ]},
  { id: "5", title: "अध्याय दो", page: 5, children: [] },
]);
const bytes = await doc.save();
writeFileSync("public/qa/bm-fixture.pdf", bytes);
console.log("fixture written:", bytes.length, "bytes, 8 pages, 5 existing bookmarks");
