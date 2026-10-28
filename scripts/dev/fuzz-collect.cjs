const fs = require("node:fs");
const { matchRuns } = require("/home/z/my-project/src/lib/own/pdf/shape-deva.ts");
const m = require("/home/z/my-project/scripts/dev/indic-machine.json");
const { stateTable, accepting, tags } = m;
function* dfaMatch(cats) {
  let state = 1, startRun = null, lastAccepting = null, lastState = 0;
  for (let p = 0; p < cats.length; p++) {
    const c = cats[p]; lastState = state;
    state = stateTable[state][c];
    if (state === 0) {
      if (startRun != null && lastAccepting != null && lastAccepting >= startRun) yield [startRun, lastAccepting, tags[lastState][0]];
      state = stateTable[1][c];
      startRun = null;
    }
    if (state !== 0 && startRun == null) startRun = p;
    if (accepting[state]) lastAccepting = p;
  }
  if (startRun != null && lastAccepting != null && lastAccepting >= startRun) yield [startRun, lastAccepting, tags[state][0]];
}
const SYM = ["X","C","V","N","H","ZWNJ","ZWJ","M","SM","VD","A","Plc","DC","RS","Coeng","Repha","Ra","CM","Sym"];
// exhaustive over PAIRS (19×19) and TRIPLES with 2 free symbols over a smaller set
const patterns = new Map();
const record = (cats) => {
  const w = JSON.stringify([...dfaMatch(cats)].map(([s,e,t]) => [s,e,t ?? null]));
  const g = JSON.stringify(matchRuns(cats).map(([s,e,t]) => [s,e,t ?? null]));
  if (w !== g) {
    const key = cats.map(c => SYM[c]).join(" ");
    // canonical: pattern of mismatch = first difference type
    patterns.set(key, { w, g });
  }
};
for (let a = 0; a < 19; a++) for (let b = 0; b < 19; b++) record([a, b]);
const FOCUS = [0,1,2,3,4,5,6,7,8,10,13,14,15,16,17,18];
for (const a of FOCUS) for (const b of FOCUS) for (const c of FOCUS) record([a, b, c]);
// random longer sequences (same PRNG as the fuzz)
let seed = 987654321;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
const weighted = [1,1,1,1,1,1,3,4,5,6,7,7,7,8,8,8,10,10,10,16,16,0,0,0,2,17,18,11];
for (let iter = 0; iter < 400000; iter++) {
  const len = 5 + Math.floor(rnd() * 6);
  const seq = [];
  for (let i = 0; i < len; i++) seq.push(weighted[Math.floor(rnd() * weighted.length)]);
  record(seq);
}
console.log("distinct mismatching sequences:", patterns.size);
let shown = 0;
for (const [k, v] of patterns) {
  if (shown++ >= 200) break;
  console.log(`✗ [${k}]\n   want ${v.w}\n   got  ${v.g}`);
}
