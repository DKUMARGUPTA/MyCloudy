const pako = require("pako");
const fs = require("node:fs");
const src = fs.readFileSync("node_modules/@pdf-lib/fontkit/dist/fontkit.es.js", "utf8");
const name = "base64DeflatedTrie$2";
const rx = new RegExp(name.replace(/\$/g, "\\$") + ' = "([^"]+)"');
const m = rx.exec(src);
const raw = new Uint8Array(Buffer.from(m[1], "base64"));
console.log("raw len:", raw.length, "first bytes:", [...raw.slice(0, 8)].map((b) => b.toString(16)).join(" "));
let inner;
try {
  inner = pako.inflate(raw);
  console.log("zlib OK, inner len:", inner.length, "first bytes:", [...inner.slice(0, 16)].map((b) => b.toString(16)).join(" "));
} catch (e) {
  console.log("zlib fail:", e.message);
  inner = raw;
}
for (const off of [0, 12]) {
  try {
    const out = pako.inflateRaw(inner.subarray(off));
    console.log(`inflateRaw@${off} OK:`, out.length, [...out.slice(0, 8)].map((b) => b.toString(16)).join(" "));
  } catch (e) {
    console.log(`inflateRaw@${off} FAIL:`, e.message);
  }
}
