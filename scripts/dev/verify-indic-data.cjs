const { indicCatPos, scriptClass, SCRIPT_DEVA, SCRIPT_LATN, SCRIPT_SKIP, SCRIPT_OTHER, SCRIPT_CYRL } = require("/home/z/my-project/src/lib/own/pdf/indic-data.ts");
// [cp, catIdx, posIdx]
const cases = [[0x915,1,4],[0x93f,7,2],[0x930,16,4],[0x41,0,15],[0x966,11,3],[0x94d,4,0],[0x200d,6,0],[0x200c,5,0],[0x25cc,12,0],[0x905,2,0],[0x93c,3,0],[0x902,8,0],[0x964,0,15]];
for (const [cp, cat, pos] of cases) {
  const r = indicCatPos(cp);
  if (r.cat !== cat || r.pos !== pos) throw new Error(`cp ${cp.toString(16)}: got cat ${r.cat} pos ${r.pos}, want ${cat}/${pos}`);
}
console.log("indicCatPos OK (13 anchors)");
const sc = {
  deva: scriptClass(0x915) === SCRIPT_DEVA,
  latin: scriptClass(0x41) === SCRIPT_LATN,
  digitSkip: scriptClass(0x30) === SCRIPT_SKIP,
  han: scriptClass(0x4e00) === SCRIPT_OTHER,
  cyr: scriptClass(0x40f) === SCRIPT_CYRL,
  dandaSkip: scriptClass(0x964) === SCRIPT_SKIP,
};
if (Object.values(sc).some((v) => v !== true)) throw new Error(JSON.stringify(sc));
console.log("scriptClass OK", JSON.stringify(sc));
