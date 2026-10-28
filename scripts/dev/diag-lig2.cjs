const fs = require("node:fs");
require("regenerator-runtime/runtime");
const fontkit = require("/home/z/my-project/scripts/dev/fontkit-patched.cjs");
const bytes = fs.readFileSync("/home/z/my-project/public/fonts/NotoSansDevanagari-Regular.ttf");
(async () => {
  const font = await fontkit.create(bytes);
  // what features does the deva default langsys have, post-layout?
  const run = font.layout("त्र");
  console.log("layout glyphs:", run.glyphs.map(g => `${g.id}:[${g.codePoints.map(c=>c.toString(16)).join(",")}]`).join(" "));
  const GSUB = font._layoutEngine.engine.GSUBProcessor;
  console.log("resolved features:", Object.keys(GSUB.features).join(" "));
  console.log("scriptTag:", GSUB.scriptTag);
})();
