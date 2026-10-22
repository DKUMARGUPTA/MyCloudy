/**
 * Builds public/qa/sample-newsletter.pub — a realistic single-language
 * English .pub (OLE2/CFB container with one UTF-16 story stream) for
 * browser QA of the publisher-to-pdf tool. Helpers are the exact ones
 * from scripts/smoke-publisher-to-pdf.ts (copied, not imported — the
 * smoke is a top-level script that self-exits on import).
 *
 * Run: bun scripts/make-pub-fixture.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";

function storyBytes(
  paras: string[],
  utf16: boolean,
  joiner = "\r\n"
): Uint8Array {
  const chunks: number[] = [];
  const noise = [0x01, 0x02, 0x03, 0x04];
  for (const p of paras) {
    for (const b of noise) chunks.push(b);
    const s = `${p}${joiner}`;
    if (utf16) {
      for (let i = 0; i < s.length; i += 1) {
        const c = s.charCodeAt(i);
        chunks.push(c & 0xff, c >> 8);
      }
    } else {
      for (let i = 0; i < s.length; i += 1) chunks.push(s.charCodeAt(i) & 0xff);
    }
  }
  return new Uint8Array(chunks);
}

/**
 * Binary noise with NO byte ≥ 0x20 and no 0x09/0x0a/0x0d — guaranteed to
 * form no text run in either the UTF-16 or the ASCII scan (a "09" pair
 * high byte would fake Devanagari, so 0x09 stays out of the pattern).
 */
function noiseBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const pattern = [
    0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x0b, 0x0e, 0x11, 0x14, 0x17, 0x1a,
    0x1d, 0x1f,
  ];
  for (let i = 0; i < n; i += 1) out[i] = pattern[i % pattern.length]!;
  return out;
}

/** Tops a paragraph list up past a byte threshold with distinct fillers. */
function padParas(
  paras: string[],
  minBytes: number,
  utf16: boolean,
  line: (n: number) => string
): string[] {
  const out = [...paras];
  const bytesOf = (s: string): number => (utf16 ? s.length * 2 : s.length);
  let total = 0;
  for (const p of out) total += bytesOf(p) + 2;
  let n = 1;
  while (total < minBytes) {
    const l = line(n);
    out.push(l);
    total += bytesOf(l) + 2;
    n += 1;
  }
  return out;
}

const CFB_FREE = 0xffffffff;
const CFB_END = 0xfffffffe;
const CFB_FATSECT = 0xfffffffd;

interface CfbStreamSpec {
  name: string;
  data: Uint8Array;
}

interface CfbBuildOpts {
  streams: CfbStreamSpec[];
  /** extra type-1 (storage) directory entry, like real .pub files */
  storageName?: string;
  rootName?: string;
  /** v4 (4096-byte sectors, sector 0 after 3584 bytes of header pad) */
  v4?: boolean;
  /** tamper: this stream's start sector points out of range */
  breakStart?: string;
  /** tamper: this stream's FAT chain is cut after its first sector */
  breakChain?: string;
}

function buildCfb(opts: CfbBuildOpts): Uint8Array {
  const sectorSize = opts.v4 ? 4096 : 512;
  const miniSectorSize = 64;
  const miniCutoff = 4096;
  const small = opts.streams.filter((s) => s.data.length < miniCutoff);
  const big = opts.streams.filter((s) => s.data.length >= miniCutoff);

  /* ---- mini stream: small streams concatenated at 64-byte alignment */
  const miniBytes: number[] = [];
  const miniStart = new Map<string, number>();
  for (const s of small) {
    const startSector = Math.ceil(miniBytes.length / miniSectorSize);
    while (miniBytes.length < startSector * miniSectorSize) miniBytes.push(0);
    miniStart.set(s.name, startSector);
    for (const b of s.data) miniBytes.push(b);
  }
  const miniStreamLen = miniBytes.length;
  const miniSectorCount = Math.ceil(miniStreamLen / miniSectorSize);

  /* ---- directory sizing */
  const perDirSector = Math.floor(sectorSize / 128);
  const entryCount = 1 + (opts.storageName ? 1 : 0) + opts.streams.length;
  const dirSectors = Math.max(1, Math.ceil(entryCount / perDirSector));

  /* ---- big-stream sector numbers, INTERLEAVED so chains must jump */
  const counts = big.map((s) => Math.ceil(s.data.length / sectorSize));
  const totalBig = counts.reduce((a, b) => a + b, 0);
  const bigSectors = new Map<string, number[]>();
  let nextSector = dirSectors;
  const maxCount = counts.reduce((a, b) => Math.max(a, b), 0);
  for (let k = 0; k < maxCount; k += 1) {
    for (let j = 0; j < big.length; j += 1) {
      if (k < counts[j]!) {
        const list = bigSectors.get(big[j]!.name) ?? [];
        list.push(nextSector);
        bigSectors.set(big[j]!.name, list);
        nextSector += 1;
      }
    }
  }

  const miniStreamSectors = Math.ceil(miniStreamLen / sectorSize);
  const miniFatSectors =
    miniSectorCount > 0
      ? Math.ceil(miniSectorCount / Math.floor(sectorSize / 4))
      : 0;

  /* ---- FAT sector count fixpoint (a FAT sector covers sectorSize/4) */
  const perFatSector = Math.floor(sectorSize / 4);
  let fatSectors = 1;
  for (;;) {
    const total =
      dirSectors + totalBig + miniStreamSectors + miniFatSectors + fatSectors;
    const need = Math.ceil(total / perFatSector);
    if (need <= fatSectors) break;
    fatSectors = need;
  }
  const totalSectors =
    dirSectors + totalBig + miniStreamSectors + miniFatSectors + fatSectors;
  const fatStartSec = totalSectors - fatSectors;
  const miniStreamStartSec = miniStreamSectors > 0 ? dirSectors + totalBig : -1;
  const miniFatStartSec =
    miniFatSectors > 0 ? dirSectors + totalBig + miniStreamSectors : -1;

  /* ---- FAT (flat next-sector table) */
  const fat = new Array<number>(fatSectors * perFatSector).fill(CFB_FREE);
  for (let i = 0; i < dirSectors; i += 1) {
    fat[i] = i + 1 < dirSectors ? i + 1 : CFB_END;
  }
  for (const [name, secs] of bigSectors) {
    for (let i = 0; i < secs.length; i += 1) {
      const s = secs[i]!;
      let next: number;
      if (opts.breakChain === name && i === 0) next = CFB_FREE;
      else next = i + 1 < secs.length ? secs[i + 1]! : CFB_END;
      fat[s] = next;
    }
  }
  for (let i = 0; i < miniStreamSectors; i += 1) {
    const s = miniStreamStartSec + i;
    fat[s] = i + 1 < miniStreamSectors ? s + 1 : CFB_END;
  }
  for (let i = 0; i < miniFatSectors; i += 1) {
    const s = miniFatStartSec + i;
    fat[s] = i + 1 < miniFatSectors ? s + 1 : CFB_END;
  }
  for (let i = 0; i < fatSectors; i += 1) fat[fatStartSec + i] = CFB_FATSECT;

  /* ---- mini FAT */
  const miniFat = new Array<number>(miniFatSectors * perFatSector).fill(
    CFB_FREE
  );
  for (const s of small) {
    const start = miniStart.get(s.name)!;
    const count = Math.ceil(s.data.length / miniSectorSize);
    for (let i = 0; i < count; i += 1) {
      miniFat[start + i] = i + 1 < count ? start + i + 1 : CFB_END;
    }
  }

  /* ---- file assembly (MS-CFB: sector N lives at (N+1) × sectorSize) */
  const headerLen = 512;
  const fileLen = (opts.v4 ? sectorSize : headerLen) + totalSectors * sectorSize;
  const out = new Uint8Array(fileLen);
  const dv = new DataView(out.buffer);

  out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  dv.setUint16(0x18, 0x003e, true); // minor version
  dv.setUint16(0x1a, opts.v4 ? 4 : 3, true);
  dv.setUint16(0x1c, 0xfffe, true); // little endian
  dv.setUint16(0x1e, opts.v4 ? 12 : 9, true);
  dv.setUint16(0x20, 6, true); // 64-byte mini sectors
  dv.setUint32(0x2c, opts.v4 ? dirSectors : 0, true);
  dv.setUint32(0x30, 0, true); // first directory sector
  dv.setUint32(0x38, miniCutoff, true);
  dv.setUint32(
    0x3c,
    miniFatSectors > 0 ? miniFatStartSec : CFB_END,
    true
  );
  dv.setUint32(0x40, miniFatSectors, true);
  dv.setUint32(0x44, CFB_END, true); // no DIFAT sectors
  dv.setUint32(0x48, 0, true);
  for (let i = 0; i < 109; i += 1) {
    dv.setUint32(
      0x4c + i * 4,
      i < fatSectors ? fatStartSec + i : CFB_FREE,
      true
    );
  }

  const putSector = (s: number, data: Uint8Array): void => {
    out.set(data.subarray(0, sectorSize), (s + 1) * sectorSize);
  };

  // directory
  const dir = new Uint8Array(dirSectors * sectorSize);
  const dirDv = new DataView(dir.buffer);
  const writeEntry = (
    slot: number,
    name: string,
    type: number,
    start: number,
    size: number
  ): void => {
    const off = slot * 128;
    const chars = Math.min(name.length, 31);
    for (let i = 0; i < chars; i += 1) {
      const c = name.charCodeAt(i);
      dir[off + i * 2] = c & 0xff;
      dir[off + i * 2 + 1] = c >> 8;
    }
    const nameLen = (chars + 1) * 2;
    dir[off + 0x40] = nameLen & 0xff;
    dir[off + 0x41] = nameLen >> 8;
    dir[off + 0x42] = type;
    dir[off + 0x43] = 1; // black
    dirDv.setUint32(off + 0x44, CFB_FREE, true); // left sibling
    dirDv.setUint32(off + 0x48, CFB_FREE, true); // right sibling
    dirDv.setUint32(off + 0x4c, CFB_FREE, true); // child
    dirDv.setUint32(off + 0x74, start, true);
    dirDv.setUint32(off + 0x78, size, true);
    dirDv.setUint32(off + 0x7c, 0, true);
  };
  let slot = 0;
  writeEntry(
    slot,
    opts.rootName ?? "Root Entry",
    5,
    miniStreamSectors > 0 ? miniStreamStartSec : CFB_END,
    miniStreamLen
  );
  slot += 1;
  if (opts.storageName) {
    writeEntry(slot, opts.storageName, 1, CFB_END, 0);
    slot += 1;
  }
  for (const s of opts.streams) {
    let start: number;
    if (opts.breakStart === s.name) start = totalSectors + 7;
    else if (s.data.length < miniCutoff) start = miniStart.get(s.name)!;
    else start = bigSectors.get(s.name)![0]!;
    writeEntry(slot, s.name, 2, start, s.data.length);
    slot += 1;
  }
  for (let i = 0; i < dirSectors; i += 1) {
    putSector(
      i,
      dir.subarray(i * sectorSize, (i + 1) * sectorSize)
    );
  }

  // big stream sectors (interleaved physical order)
  for (const [name, secs] of bigSectors) {
    const data = opts.streams.find((s) => s.name === name)!.data;
    for (let i = 0; i < secs.length; i += 1) {
      putSector(
        secs[i]!,
        data.subarray(i * sectorSize, (i + 1) * sectorSize)
      );
    }
  }

  // mini stream (the root's chain) — sector i carries miniBytes[i×size…]
  // (the old padInto((i + 1) × size) emitted the FIRST sector's bytes into
  // every sector, so any mini stream spanning 2+ file sectors was corrupt)
  for (let i = 0; i < miniStreamSectors; i += 1) {
    const buf = new Uint8Array(sectorSize);
    for (
      let k = 0;
      k < sectorSize && i * sectorSize + k < miniStreamLen;
      k += 1
    ) {
      buf[k] = miniBytes[i * sectorSize + k]!;
    }
    putSector(miniStreamStartSec + i, buf);
  }

  // mini FAT sectors
  for (let i = 0; i < miniFatSectors; i += 1) {
    const buf = new Uint8Array(sectorSize);
    const bufDv = new DataView(buf.buffer);
    for (let k = 0; k < perFatSector; k += 1) {
      const idx = i * perFatSector + k;
      if (idx < miniFat.length) bufDv.setUint32(k * 4, miniFat[idx]!, true);
    }
    putSector(miniFatStartSec + i, buf);
  }

  // FAT sectors
  for (let i = 0; i < fatSectors; i += 1) {
    const buf = new Uint8Array(sectorSize);
    const bufDv = new DataView(buf.buffer);
    for (let k = 0; k < perFatSector; k += 1) {
      const idx = i * perFatSector + k;
      if (idx < fat.length) bufDv.setUint32(k * 4, fat[idx]!, true);
    }
    putSector(fatStartSec + i, buf);
  }

  return out;
}


/* ---------------- fixture build ---------------- */
const PARAS = padParas(
  [
    "WINTER OPEN DAY AT THE LIBRARY",
    "Saturday, 14 February 2026, from 10 am to 4 pm.",
    "Free Entry And Guided Tours",
    "The city library opens its doors for a full day of reading corners, guided tours, and family activities. Volunteers will be present in every hall to answer questions about membership, digital lending, and the winter programme.",
    "Children can join the storytelling hour at eleven in the morning, followed by a drawing workshop in the afternoon. Both sessions are free of charge and require no prior registration; seats are limited to the room capacity of forty.",
    "Tea, coffee and light snacks are served in the reading room throughout the day.",
    "We look forward to welcoming you, your family, your friends and your neighbours to the warmest room in town on the fourteenth of February.",
  ],
  4200,
  true,
  (n) => `Winter open day notice ${n}: additional announcements, signage and volunteer shifts are confirmed in the programme.`
);

const story = storyBytes(PARAS, true);
const cfb = buildCfb({
  streams: [
    { name: "Contents", data: noiseBytes(96) },
    { name: "EnglishStory", data: story },
  ],
  storageName: "Quill",
});

mkdirSync("public/qa", { recursive: true });
writeFileSync("public/qa/sample-newsletter.pub", cfb);
console.log(`sample-newsletter.pub written: ${cfb.length} bytes, story ${story.length} bytes, ${PARAS.length} paragraphs`);
