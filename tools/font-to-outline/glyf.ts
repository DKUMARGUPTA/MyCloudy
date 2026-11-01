import type { ParsedTtfFont } from "@/lib/own/pdf";

/**
 * TrueType glyf outline decoding (PHASE-7 font-to-outline): simple
 * glyphs (endPts/flags/deltas) and composite glyphs (component
 * transforms), then the TrueType on/off-curve contour walk emitted as
 * PDF path operators (quadratic → cubic via the 2/3 control rule).
 *
 * Pure math on the ParsedTtfFont's already-sliced glyf/loca tables.
 */

export interface GlyphPoint {
  x: number;
  y: number;
  on: boolean;
}

export type GlyphContour = GlyphPoint[];

const i16 = (b: Uint8Array, o: number): number => {
  const v = ((b[o]! << 8) | b[o + 1]!) | 0;
  return v >= 0x8000 ? v - 0x10000 : v;
};

const u16 = (b: Uint8Array, o: number): number =>
  ((b[o]! << 8) | b[o + 1]!) >>> 0;

const int8 = (b: Uint8Array, o: number): number => {
  const v = b[o]! | 0;
  return v >= 0x80 ? v - 0x100 : v;
};

/** F2Dot14 fixed point. */
const f2dot14 = (b: Uint8Array, o: number): number => i16(b, o) / 16384;

const mid = (a: GlyphPoint, b: GlyphPoint): GlyphPoint => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
  on: true,
});

/** Simple-glyph contours (numberOfContours >= 0). */
function simpleContours(bytes: Uint8Array, nContours: number): GlyphContour[] {
  const endPts: number[] = [];
  for (let i = 0; i < nContours; i += 1) endPts.push(u16(bytes, 10 + i * 2));
  const instrLen = u16(bytes, 10 + nContours * 2);
  let p = 10 + nContours * 2 + 2 + instrLen;
  const n = (endPts[endPts.length - 1] ?? -1) + 1;
  if (n <= 0) return [];

  const flags: number[] = [];
  while (flags.length < n) {
    if (p >= bytes.length) return [];
    const f = bytes[p]!;
    p += 1;
    flags.push(f);
    if (f & 0x0008) {
      const rep = bytes[p] ?? 0;
      p += 1;
      for (let r = 0; r < rep && flags.length < n; r += 1) flags.push(f);
    }
  }

  const xs: number[] = [];
  let x = 0;
  for (let i = 0; i < n; i += 1) {
    const f = flags[i]!;
    if (f & 0x0002) {
      const d = bytes[p] ?? 0;
      p += 1;
      x += (f & 0x0010) !== 0 ? d : -d;
    } else if ((f & 0x0010) === 0) {
      x += i16(bytes, p);
      p += 2;
    }
    xs.push(x);
  }

  const ys: number[] = [];
  let y = 0;
  for (let i = 0; i < n; i += 1) {
    const f = flags[i]!;
    if (f & 0x0004) {
      const d = bytes[p] ?? 0;
      p += 1;
      y += (f & 0x0020) !== 0 ? d : -d;
    } else if ((f & 0x0020) === 0) {
      y += i16(bytes, p);
      p += 2;
    }
    ys.push(y);
  }

  const contours: GlyphContour[] = [];
  let start = 0;
  for (const end of endPts) {
    const c: GlyphPoint[] = [];
    for (let i = start; i <= end && i < n; i += 1) {
      c.push({ x: xs[i]!, y: ys[i]!, on: (flags[i]! & 0x0001) !== 0 });
    }
    if (c.length > 0) contours.push(c);
    start = end + 1;
  }
  return contours;
}

/**
 * All contours of a glyph — simple or composite (components resolved
 * recursively with their translate/scale/2×2 transforms; legacy
 * point-matching components drop their matched offset, a rare
 * pre-1990 relic). Depth-capped against malformed recursion.
 */
export function glyphContours(
  font: ParsedTtfFont,
  gid: number,
  depth = 0
): GlyphContour[] {
  if (!Number.isInteger(gid) || gid < 0 || depth > 5) return [];
  const bytes = font.glyphBytes(gid);
  if (bytes.length < 10) return [];
  const nContours = i16(bytes, 0);
  if (nContours >= 0) return simpleContours(bytes, nContours);

  const out: GlyphContour[] = [];
  let p = 10;
  for (;;) {
    if (p + 4 > bytes.length) break;
    const flags = u16(bytes, p);
    const compGid = u16(bytes, p + 2);
    p += 4;

    let dx = 0;
    let dy = 0;
    if (flags & 0x0001) {
      dx = i16(bytes, p);
      dy = i16(bytes, p + 2);
      p += 4;
    } else {
      dx = int8(bytes, p);
      dy = int8(bytes, p + 1);
      p += 2;
    }
    // ARGS_ARE_XY_VALUES — point-matching (legacy) carries no offset.
    if ((flags & 0x0002) === 0) {
      dx = 0;
      dy = 0;
    }

    let a = 1;
    let b = 0;
    let c = 0;
    let d = 1;
    if (flags & 0x0008) {
      a = f2dot14(bytes, p);
      d = a;
      p += 2;
    } else if (flags & 0x0040) {
      a = f2dot14(bytes, p);
      d = f2dot14(bytes, p + 2);
      p += 4;
    } else if (flags & 0x0080) {
      a = f2dot14(bytes, p);
      b = f2dot14(bytes, p + 2);
      c = f2dot14(bytes, p + 4);
      d = f2dot14(bytes, p + 6);
      p += 8;
    }

    for (const contour of glyphContours(font, compGid, depth + 1)) {
      out.push(
        contour.map((pt) => ({
          x: a * pt.x + c * pt.y + dx,
          y: b * pt.x + d * pt.y + dy,
          on: pt.on,
        }))
      );
    }

    if ((flags & 0x0020) === 0) break; // MORE_COMPONENTS
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Contour walk → PDF path operators                                   */
/* ------------------------------------------------------------------ */

type Seg =
  | { t: "L"; p: GlyphPoint }
  | { t: "Q"; c: GlyphPoint; p: GlyphPoint };

interface Walked {
  start: GlyphPoint;
  segs: Seg[];
}

/**
 * The TrueType on/off-curve walk: lines between on points, quadratics
 * through off points with implied midpoints, all-off contours start
 * and end at the implied midpoint.
 */
export function walkContour(pts: GlyphContour): Walked | null {
  const n = pts.length;
  if (n === 0) return null;

  let first = -1;
  for (let i = 0; i < n; i += 1) {
    if (pts[i]!.on) {
      first = i;
      break;
    }
  }

  if (first < 0) {
    // All off-curve: start/end at the implied midpoint.
    const start = mid(pts[n - 1]!, pts[0]!);
    const segs: Seg[] = [];
    for (let i = 0; i < n; i += 1) {
      const c = pts[i]!;
      const next = pts[(i + 1) % n]!;
      segs.push({ t: "Q", c, p: next.on ? next : mid(c, next) });
    }
    return { start, segs };
  }

  const start = pts[first]!;
  const segs: Seg[] = [];
  let i = (first + 1) % n;
  for (;;) {
    if (i === first) break;
    const pt = pts[i]!;
    if (pt.on) {
      segs.push({ t: "L", p: pt });
      i = (i + 1) % n;
      continue;
    }
    const nextI = (i + 1) % n;
    const next = pts[nextI]!;
    let end: GlyphPoint;
    if (nextI === first) {
      end = start;
    } else if (next.on) {
      end = next;
    } else {
      end = mid(pt, next);
    }
    segs.push({ t: "Q", c: pt, p: end });
    if (nextI === first) break;
    i = next.on ? (nextI + 1) % n : nextI;
  }
  return { start, segs };
}

/**
 * One glyph as PDF path operators (`m`/`l`/`c`/`h` + `f`), coordinates
 * produced by the caller's transform (font units in, formatted page
 * points out — strings so callers control number precision).
 */
export function glyphToPathOps(
  contours: GlyphContour[],
  tf: (x: number, y: number) => [string, string]
): string {
  const parts: string[] = [];
  let any = false;
  for (const contour of contours) {
    const walked = walkContour(contour);
    if (!walked) continue;
    any = true;
    let [cx, cy] = tf(walked.start.x, walked.start.y);
    parts.push(`${cx} ${cy} m`);
    let px = walked.start.x;
    let py = walked.start.y;
    for (const seg of walked.segs) {
      if (seg.t === "L") {
        [cx, cy] = tf(seg.p.x, seg.p.y);
        parts.push(`${cx} ${cy} l`);
      } else {
        const c1x = px + (2 / 3) * (seg.c.x - px);
        const c1y = py + (2 / 3) * (seg.c.y - py);
        const c2x = seg.p.x + (2 / 3) * (seg.c.x - seg.p.x);
        const c2y = seg.p.y + (2 / 3) * (seg.c.y - seg.p.y);
        const [a1x, a1y] = tf(c1x, c1y);
        const [a2x, a2y] = tf(c2x, c2y);
        [cx, cy] = tf(seg.p.x, seg.p.y);
        parts.push(`${a1x} ${a1y} ${a2x} ${a2y} ${cx} ${cy} c`);
      }
      px = seg.p.x;
      py = seg.p.y;
    }
    parts.push("h");
  }
  if (!any) return "";
  parts.push("f");
  return parts.join("\n");
}
