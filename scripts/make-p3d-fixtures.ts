/**
 * P3-d E2E fixtures (own engine only — the discipline rule):
 *   public/qa-p3d-host.pdf                2-page plain host
 *   public/qa-p3d-notes.txt               text attachment payload
 *   public/qa-p3d-photo.bin               binary attachment payload (1 KiB)
 *   public/qa-p3d-data.json               json attachment payload
 *   public/qa-p3d-with-attachments.pdf    host + the 3 files embedded
 *
 * Run: bun scripts/make-p3d-fixtures.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CreateContext,
  catalogDict,
  parsePdf,
  rewriteDocument,
  type PdfObj,
} from "../src/lib/own/pdf";
import { attachFile } from "../tools/attachments-common/write";
import { sniffAttachmentMime } from "../tools/attachments-common/mime";

const root = join(import.meta.dir, "..");
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function hostPdf(): Uint8Array {
  const doc = CreateContext.create();
  const p1 = doc.addPage(420, 300);
  p1.drawText({ x: 30, y: 220, text: "P3-d attachment host", size: 16 });
  p1.drawText({ x: 30, y: 190, text: "Page one — plain content.", size: 11 });
  const p2 = doc.addPage(420, 300);
  p2.drawText({ x: 30, y: 220, text: "Page two", size: 16 });
  doc.setProducer("DocoPDF");
  return doc.write();
}

function withAttachmentsPdf(host: Uint8Array): Uint8Array {
  const parsed = parsePdf(host);
  const catalog = catalogDict(parsed);
  if (catalog === null) throw new Error("no catalog");
  let nextNum = 1;
  for (const n of parsed.entries.keys()) nextNum = Math.max(nextNum, n + 1);

  const payloads: { name: string; bytes: Uint8Array }[] = [
    { name: "notes.txt", bytes: enc("P3-d fixture notes.\nThis file was embedded by the DocoPDF own engine.\nByte-exact roundtrip expected.") },
    {
      name: "photo.bin",
      bytes: (() => {
        const b = new Uint8Array(1024);
        for (let i = 0; i < b.length; i += 1) b[i] = (i * 31 + 7) & 0xff;
        return b;
      })(),
    },
    { name: "data.json", bytes: enc('{"fixture":"p3d","tools":["add-attachments","extract-attachments","remove-attachments"],"pages":2}') },
  ];

  const extras: Array<{ num: number; obj: PdfObj }> = [];
  for (const p of payloads) {
    const r = attachFile(
      parsed,
      catalog,
      { name: p.name, mime: sniffAttachmentMime(p.name, p.bytes), bytes: p.bytes },
      nextNum,
      { compress: true, modDate: "D:20261101000000Z" },
    );
    nextNum = r.nextNum;
    extras.push(...r.extras);
  }
  return rewriteDocument(parsed, { extraObjects: extras, minVersion: "1.4" });
}

const host = hostPdf();
const withAtt = withAttachmentsPdf(host);

writeFileSync(join(root, "public", "qa-p3d-host.pdf"), host);
writeFileSync(join(root, "public", "qa-p3d-with-attachments.pdf"), withAtt);
writeFileSync(
  join(root, "public", "qa-p3d-notes.txt"),
  enc("P3-d fixture notes.\nThis file was embedded by the DocoPDF own engine.\nByte-exact roundtrip expected."),
);
writeFileSync(
  join(root, "public", "qa-p3d-photo.bin"),
  (() => {
    const b = new Uint8Array(1024);
    for (let i = 0; i < b.length; i += 1) b[i] = (i * 31 + 7) & 0xff;
    return b;
  })(),
);
writeFileSync(
  join(root, "public", "qa-p3d-data.json"),
  enc('{"fixture":"p3d","tools":["add-attachments","extract-attachments","remove-attachments"],"pages":2}'),
);

console.log(
  `fixtures written: host=${host.length}B with-attachments=${withAtt.length}B`,
);
