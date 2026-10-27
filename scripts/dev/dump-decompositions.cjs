const fs = require("node:fs");
const pako = require("pako");
let src = fs.readFileSync("node_modules/@pdf-lib/fontkit/dist/fontkit.es.js", "utf8");
// extract the useData JSON (zlib-inflated)
const m = src.match(/base64DeflatedUseData = "([^"]+)"/);
const raw = new Uint8Array(Buffer.from(m[1], "base64"));
const json = JSON.parse(Buffer.from(pako.inflate(raw)).toString("utf8"));
console.log("keys:", Object.keys(json));
const d = json.decompositions;
const keys = Object.keys(d);
console.log("decomposition count:", keys.length);
console.log("max cp:", Math.max(...keys.map(Number)).toString(16), "min:", Math.min(...keys.map(Number)).toString(16));
// compact representation size
const compact = keys.map((k) => `${k}:${d[k].map((c) => c.toString(16)).join(",")}`).join(";");
console.log("compact bytes:", compact.length);
fs.writeFileSync("/tmp/decompositions.json", JSON.stringify(d));
