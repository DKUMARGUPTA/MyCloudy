/**
 * DEV-TIME inspection: dump the GSUB structure of the shipped Devanagari font
 * so the own-engine shaper can be scoped to the lookup types it really uses.
 * Not part of any shipped path.
 */
import { readFileSync, writeFileSync } from "node:fs";

const bytes = readFileSync("/home/z/my-project/public/fonts/NotoSansDevanagari-Regular.ttf");
const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const tag = (off: number) =>
  String.fromCharCode(bytes[off]!, bytes[off + 1]!, bytes[off + 2]!, bytes[off + 3]!);
const u16 = (off: number) => dv.getUint16(off);
const u32 = (off: number) => dv.getUint32(off);

const numTables = u16(4);
const tables = new Map<string, number>();
for (let i = 0; i < numTables; i++) {
  const off = 12 + i * 16;
  tables.set(tag(off), u32(off + 8));
}
console.log("tables:", [...tables.keys()].sort().join(" "), " fileLen:", bytes.length);
console.log("upem:", u16(tables.get("head")! + 18), "numGlyphs:", u16(tables.get("maxp")! + 4));
const cmap = tables.get("cmap")!;
console.log(
  "cmap subtables:",
  u16(cmap + 2),
  [...Array(u16(cmap + 2))].map((_, i) => {
    const rec = cmap + 4 + i * 8;
    return `plat${u16(rec)}-enc${u16(rec + 2)}-fmt${u16(u32(rec + 4))}`;
  }).join(" "),
);
const hhea = tables.get("hhea")!;
console.log("numHMetrics:", u16(hhea + 34), "indexToLocFormat:", u16(tables.get("head")! + 50));

// ---- GSUB ----
const gsub = tables.get("GSUB");
if (gsub === undefined) {
  console.log("NO GSUB");
} else {
  const lookupListOff = gsub + u16(gsub + 8);
  const lookupCount = u16(lookupListOff);
  const typeCounts = new Map<number, number>();
  let formatCounts = "";
  for (let i = 0; i < lookupCount; i++) {
    const lo = lookupListOff + u16(lookupListOff + 2 + i * 2);
    const type = u16(lo);
    const fmt = u16(lo + 4);
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    formatCounts += ` ${type}/${fmt}`;
  }
  console.log("GSUB version:", u16(gsub), u16(gsub + 2), "lookupCount:", lookupCount);
  console.log("lookup types:", [...typeCounts.entries()].map(([t, n]) => `type${t}×${n}`).join(" "));
  console.log("type/format:", formatCounts.trim());

  // feature list
  const featureListOff = gsub + u16(gsub + 6);
  const featureCount = u16(featureListOff);
  const feats = new Map<string, number>();
  for (let i = 0; i < featureCount; i++) {
    const rec = featureListOff + 2 + i * 6;
    const ftag = tag(rec);
    const n = u16(rec + 4);
    feats.set(ftag, (feats.get(ftag) ?? 0) + n);
  }
  console.log(
    "features:",
    [...feats.entries()].map(([t, n]) => `${t}(${n})`).join(" "),
  );

  // script list
  const scriptListOff = gsub + u16(gsub + 4);
  const scriptCount = u16(scriptListOff);
  const scripts: string[] = [];
  for (let i = 0; i < scriptCount; i++) {
    const rec = scriptListOff + 2 + i * 6;
    scripts.push(`${tag(rec)}:langsys${u16(rec + 4)}`);
  }
  console.log("scripts:", scripts.join(" "));

  // sample: for lookup type 4, dump a couple of ligatures
  let ligSamples = 0;
  for (let i = 0; i < lookupCount && ligSamples < 8; i++) {
    const lo = lookupListOff + u16(lookupListOff + 2 + i * 2);
    if (u16(lo) !== 4) continue;
    const covOff = u16(lo + 6) !== 2 ? lo + u16(lo + 6) : lo + u16(lo + 6); // fmt-agnostic below
    // ligatureSubstFormat1: coverage at +6, ligSetCount +4
    const ligSetCount = u16(lo + 4);
    const covFmt = u16(covOff);
    let glyphs = "";
    if (covFmt === 1) {
      const cnt = u16(covOff + 2);
      glyphs = [Math.min(cnt, 6)].map((_, k) => u16(covOff + 6 + k * 2)).join(",");
    } else {
      const rg = u16(covOff + 2);
      glyphs = [Math.min(rg, 4)]
        .map((_, k) => {
          const r = covOff + 4 + k * 6;
          return `${u16(r)}-${u16(r + 2)}`;
        })
        .join(",");
    }
    console.log(`  ligLookup#${i}: sets=${ligSetCount} firstGlyphs=${glyphs}`);
    ligSamples++;
  }

  // extension lookups (type 7)?
  for (let i = 0; i < lookupCount; i++) {
    const lo = lookupListOff + u16(lookupListOff + 2 + i * 2);
    if (u16(lo) === 7) console.log(`  EXTENSION lookup #${i} present`);
  }
}

// hmtx sample for the digits + cmap check
const cmapFmt12 = (() => {
  const n = u16(cmap + 2);
  for (let i = 0; i < n; i++) {
    const rec = cmap + 4 + i * 8;
    if (u16(rec) === 3 && u16(rec + 2) === 10) return u32(rec + 4);
  }
  return null;
})();
console.log("has cmap 3/10 (UCS-4):", cmapFmt12 !== null);
