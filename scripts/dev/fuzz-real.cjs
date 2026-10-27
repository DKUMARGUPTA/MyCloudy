// Fuzz restricted to categories that can actually occur in OUR font's text
// (Devanagari + Latin + digits + punctuation): the Khmer/other-script
// categories (Coeng, RS, Repha, VD, PLC, DC) can never appear.
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
// real alphabet for our font's texts: X C V N H ZWNJ ZWJ M SM A Ra CM Sym(danda? no — danda is X... Symbol = avagraha ऽ which IS possible!) Plc(digits!)
const REAL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 16, 17, 18];
let seed = 1357924680;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
const weighted = [1,1,1,1,1,1,3,4,5,6,7,7,7,8,8,8,10,10,10,16,16,0,0,0,2,17,18,11];
let checked = 0, mismatches = 0;
const shown = new Set();
for (let iter = 0; iter < 600000; iter++) {
  const len = 1 + Math.floor(rnd() * 10);
  const cats = [];
  for (let i = 0; i < len; i++) cats.push(weighted[Math.floor(rnd() * weighted.length)]);
  checked++;
  const w = JSON.stringify([...dfaMatch(cats)].map(([s, e, t]) => [s, e, t ?? null]));
  const g = JSON.stringify(matchRuns(cats).map(([s, e, t]) => [s, e, t ?? null]));
  if (w !== g) {
    mismatches++;
    if (shown.size < 15) {
      const key = cats.map((c) => SYM[c]).join(" ");
      if (!shown.has(key)) { shown.add(key); console.log(`✗ [${key}]\n   want ${w}\n   got  ${g}`); }
    }
  }
}
console.log(`\nREAL-alphabet fuzz: checked ${checked}, mismatches ${mismatches}`);
