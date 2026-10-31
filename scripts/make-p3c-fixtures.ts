/**
 * E2E fixture generator for the P3-c tools (R57) — writes real files the
 * agent-browser golden paths upload:
 *
 *   /tmp/p3c-fixtures/photo.bmp    24-bit BI_RGB 8×6 (colour gradient)
 *   /tmp/p3c-fixtures/art.psd      RGB + alpha, PackBits RLE composite 8×6
 *   /tmp/p3c-fixtures/comic.cbz    own-zip archive: cover.png + page-2.bmp + page-10.jpg
 *   /tmp/p3c-fixtures/message.eml  Hindi RFC 2047 subject + QP Devanagari body + base64 attachment
 *
 * All authored with our own engines (no canvas / no network). The real
 * JPEG page reuses public/qa-rkb-small.jpg so the DCT passthrough path
 * is exercised with genuine JPEG bytes.
 *
 * Run: bun scripts/make-p3c-fixtures.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { zipSync, zlibSync, crc32 } from "../src/lib/own/zip";

const OUT = "/tmp/p3c-fixtures";
mkdirSync(OUT, { recursive: true });

const enc = new TextEncoder();

function dv(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

/* ─── photo.bmp — 24-bit BI_RGB 8×6 gradient ────────────────────────────── */
{
  const width = 8;
  const height = 6;
  const stride = (width * 3 + 3) & ~3;
  const pixelStart = 14 + 40;
  const out = new Uint8Array(pixelStart + stride * height);
  const view = dv(out);
  out[0] = 0x42;
  out[1] = 0x4d;
  view.setUint32(2, out.length, true);
  view.setUint32(10, pixelStart, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(30, 0, true);
  for (let y = 0; y < height; y += 1) {
    const srcY = height - 1 - y; // bottom-up file rows
    for (let x = 0; x < width; x += 1) {
      const o = pixelStart + y * stride + x * 3;
      out[o] = Math.round((x / (width - 1)) * 255); // B → x gradient
      out[o + 1] = Math.round((y / (height - 1)) * 255); // G → y gradient
      out[o + 2] = 255 - Math.round((x / (width - 1)) * 255); // R → inverse
      void srcY;
    }
  }
  writeFileSync(join(OUT, "photo.bmp"), out);
  console.log("photo.bmp", out.length, "bytes");
}

/* ─── art.psd — RGB + alpha RLE composite 8×6 ───────────────────────────── */
{
  const width = 8;
  const height = 6;
  const plane = width * height;
  const rP = new Uint8Array(plane);
  const gP = new Uint8Array(plane);
  const bP = new Uint8Array(plane);
  const aP = new Uint8Array(plane);
  for (let i = 0; i < plane; i += 1) {
    const x = i % width;
    const y = Math.floor(i / width);
    rP[i] = Math.round((x / (width - 1)) * 255);
    gP[i] = Math.round((y / (height - 1)) * 255);
    bP[i] = 255 - rP[i]!;
    aP[i] = y < 2 ? Math.round((x / (width - 1)) * 200) : 255; // top rows translucent
  }
  const packBitsRow = (row: Uint8Array): Uint8Array => {
    const outArr: number[] = [];
    let i = 0;
    while (i < row.length) {
      let run = 1;
      while (i + run < row.length && row[i + run] === row[i] && run < 128) run += 1;
      if (run >= 3) {
        outArr.push(257 - run, row[i]!);
        i += run;
      } else {
        let j = i;
        while (
          j < row.length &&
          j - i < 128 &&
          !(j + 2 < row.length && row[j] === row[j + 1] && row[j + 1] === row[j + 2])
        ) {
          j += 1;
        }
        const lit = j - i;
        if (lit === 0) {
          outArr.push(0, row[i]!);
          i += 1;
        } else {
          outArr.push(lit - 1);
          for (let k = i; k < j; k += 1) outArr.push(row[k]!);
          i = j;
        }
      }
    }
    return Uint8Array.from(outArr);
  };
  const planes = [rP, gP, bP, aP];
  const channels = planes.length;
  const counts = new Uint8Array(2 * channels * height);
  const countsView = dv(counts);
  const packed: Uint8Array[] = [];
  for (let c = 0; c < channels; c += 1) {
    for (let y = 0; y < height; y += 1) {
      const row = planes[c]!.subarray(y * width, (y + 1) * width);
      const encRow = packBitsRow(row);
      countsView.setUint16(2 * (c * height + y), encRow.length, false);
      packed.push(encRow);
    }
  }
  const body = new Uint8Array(counts.length + packed.reduce((s, p) => s + p.length, 0));
  let bo = 0;
  body.set(counts, bo);
  bo += counts.length;
  for (const p of packed) {
    body.set(p, bo);
    bo += p.length;
  }
  const total = 26 + 4 + 4 + 4 + 2 + body.length;
  const out = new Uint8Array(total);
  const view = dv(out);
  out[0] = 0x38;
  out[1] = 0x42;
  out[2] = 0x50;
  out[3] = 0x53;
  view.setUint16(4, 1, false); // PSD v1
  view.setUint16(12, channels, false);
  view.setUint32(14, height, false);
  view.setUint32(18, width, false);
  view.setUint16(22, 8, false); // depth
  view.setUint16(24, 3, false); // RGB
  view.setUint16(26 + 12, 1, false); // compression RLE (offset 26+4+4+4)
  out.set(body, 26 + 4 + 4 + 4 + 2);
  writeFileSync(join(OUT, "art.psd"), out);
  console.log("art.psd", out.length, "bytes");
}

/* ─── comic.cbz — cover.png + page-2.bmp + page-10.jpg ──────────────────── */
{
  // hand-built RGBA PNG 8×4 (checker)
  const width = 8;
  const height = 4;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const x = i % width;
    const y = Math.floor(i / width);
    const dark = (x + y) % 2 === 0;
    rgba[i * 4] = dark ? 30 : 230;
    rgba[i * 4 + 1] = dark ? 30 : 180;
    rgba[i * 4 + 2] = dark ? 60 : 40;
    rgba[i * 4 + 3] = 255;
  }
  const stride = width * 4 + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * stride + 1);
  }
  const idat = zlibSync(raw, 6);
  const ihdr = new Uint8Array(13);
  const iv = dv(ihdr);
  iv.setUint32(0, width, false);
  iv.setUint32(4, height, false);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const head = new Uint8Array(4 + data.length + 4 + 4);
    const hv = dv(head);
    hv.setUint32(0, data.length, false);
    for (let i = 0; i < 4; i += 1) head[4 + i] = type.charCodeAt(i);
    head.set(data, 8);
    hv.setUint32(4 + data.length + 4, crc32(head.subarray(4, 8 + data.length)), false);
    return head;
  };
  const png = new Uint8Array([
    ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", idat),
    ...chunk("IEND", new Uint8Array(0)),
  ]);

  // small 24-bit BMP page (solid colour)
  const bmpWidth = 4;
  const bmpHeight = 4;
  const bmpStride = (bmpWidth * 3 + 3) & ~3;
  const bmpStart = 14 + 40;
  const bmp = new Uint8Array(bmpStart + bmpStride * bmpHeight);
  const bv = dv(bmp);
  bmp[0] = 0x42;
  bmp[1] = 0x4d;
  bv.setUint32(10, bmpStart, true);
  bv.setUint32(14, 40, true);
  bv.setInt32(18, bmpWidth, true);
  bv.setInt32(22, bmpHeight, true);
  bv.setUint16(26, 1, true);
  bv.setUint16(28, 24, true);
  for (let y = 0; y < bmpHeight; y += 1) {
    for (let x = 0; x < bmpWidth; x += 1) {
      const o = bmpStart + y * bmpStride + x * 3;
      bmp[o] = 200; // B
      bmp[o + 1] = 80; // G
      bmp[o + 2] = 40; // R
    }
  }

  const realJpg = new Uint8Array(readFileSync(join(import.meta.dir, "..", "public", "qa-rkb-small.jpg")));

  const archive = zipSync({
    "cover.png": png,
    "page-2.bmp": bmp,
    "page-10.jpg": realJpg,
    "__MACOSX/junk.png": new Uint8Array([1, 2, 3]),
    ".DS_Store": enc.encode("junk"),
  });
  writeFileSync(join(OUT, "comic.cbz"), archive);
  console.log("comic.cbz", archive.length, "bytes (3 real pages + 2 junk)");
}

/* ─── message.eml — Hindi subject + QP body + attachment ────────────────── */
{
  const hindiSubject = "नमस्ते — साप्ताहिक रिपोर्ट";
  const b64Subject = btoa(String.fromCharCode(...enc.encode(hindiSubject)));
  const bodyText =
    "नमस्ते दीपक ji,\n\nयह साप्ताहिक रिपोर्ट का परीक्षण संदेश है।\n\nपूरा टेक्स्ट डिवाइस पर ही रेंडर हुआ।\n\n— रवि";
  const qp = (bytes: Uint8Array): string => {
    let out = "";
    for (const b of bytes) {
      if (b === 0x3d) out += "=3D";
      else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
      else out += `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }
    return out;
  };
  const attBytes = enc.encode("%PDF-1.4 fake attachment payload for the E2E run — 40 bytes");
  const attB64 = btoa(String.fromCharCode(...attBytes));
  const eml = [
    "Return-Path: <ravi@example.com>",
    "From: Ravi Sharma <ravi@example.com>",
    "To: Deepak Kumar <deepak@example.com>,",
    "\tPriya <priya@example.com>",
    `Subject: =?utf-8?B?${b64Subject}?=`,
    "Date: Thu, 12 Mar 2026 14:30:00 +0530",
    "Message-ID: <p3c-e2e@example.com>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="P3C"',
    "",
    "--P3C",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    qp(enc.encode(bodyText)),
    "--P3C",
    'Content-Type: application/pdf; name="report.pdf"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="report.pdf"',
    "",
    attB64,
    "--P3C--",
    "",
  ].join("\r\n");
  writeFileSync(join(OUT, "message.eml"), eml, "utf8");
  console.log("message.eml", enc.encode(eml).length, "bytes");
}

console.log(`\nFixtures written to ${OUT}`);
