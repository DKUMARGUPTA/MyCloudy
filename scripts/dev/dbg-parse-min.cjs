const fs = require("node:fs");
const bytes = new Uint8Array(fs.readFileSync("/home/z/my-project/public/fonts/NotoSansDevanagari-Regular.ttf"));
const u16 = (b,p)=>(b[p]<<8)|b[p+1];
const u32 = (b,p)=>((b[p]<<24)|(b[p+1]<<16)|(b[p+2]<<8)|b[p+3])>>>0;
console.log("numTables:", u16(bytes,4));
const numTables = u16(bytes, 4);
const tables = new Map();
for (let i = 0; i < numTables; i++) {
  const rec = 12 + i * 16;
  if (rec + 16 > bytes.length) break;
  const tag = String.fromCharCode(bytes[rec], bytes[rec+1], bytes[rec+2], bytes[rec+3]);
  const offset = u32(bytes, rec + 8);
  const length = u32(bytes, rec + 12);
  if (offset + length > bytes.length) continue;
  tables.set(tag, bytes.subarray(offset, offset + length));
}
console.log("tables found:", [...tables.keys()].join(" "));
