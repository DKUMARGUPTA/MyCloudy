const fs = require("node:fs");
const bytes = new Uint8Array(fs.readFileSync("/home/z/my-project/public/fonts/NotoSansDevanagari-Regular.ttf"));
const u16 = (b,p)=>(b[p]<<8)|b[p+1];
const u32 = (b,p)=>((b[p]<<24)|(b[p+1]<<16)|(b[p+2]<<8)|b[p+3])>>>0;
console.log("sfnt:", u32(bytes,0).toString(16), "numTables:", u16(bytes,4), "len:", bytes.length);
for (let i = 0; i < u16(bytes,4); i++) {
  const rec = 12 + i*16;
  const tag = String.fromCharCode(bytes[rec],bytes[rec+1],bytes[rec+2],bytes[rec+3]);
  console.log(tag, u32(bytes,rec+8), u32(bytes,rec+12));
}
