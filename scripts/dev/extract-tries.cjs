/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
let src = fs.readFileSync("node_modules/@pdf-lib/fontkit/dist/fontkit.umd.js", "utf8");
// Inject an exports hook at the end of the factory, right before `return fontkit;`
if (!src.includes("return fontkit;\n\n})))")) throw new Error("anchor not found");
src = src.replace(
  "return fontkit;\n\n})))",
  `globalThis.__FONTKIT_INTERNALS = {
    indicTrie: trie$2, machine: indicMachine, dfaCtor: dfa, unicodeTrie: trie,
    unicodeData: data, scripts: data.scripts, UMD: true,
  };
  return fontkit;

})))`
);
fs.writeFileSync("/home/z/my-project/scripts/dev/fontkit-patched.cjs", src);
const fontkit = require("/home/z/my-project/scripts/dev/fontkit-patched.cjs");
require("regenerator-runtime/runtime");
console.log("fontkit loaded:", typeof fontkit.create, "| internals:", Object.keys(globalThis.__FONTKIT_INTERNALS).join(","));
const I = globalThis.__FONTKIT_INTERNALS;
console.log("क cat:", I.indicTrie.get(0x915) >> 8, "pos:", 1 << (I.indicTrie.get(0x915) & 0xff));
console.log("ि cat:", I.indicTrie.get(0x93f) >> 8, "pos:", 1 << (I.indicTrie.get(0x93f) & 0xff));
console.log("A cat:", I.indicTrie.get(0x41) >> 8, "pos:", 1 << (I.indicTrie.get(0x41) & 0xff));
