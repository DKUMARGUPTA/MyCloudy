const m = require("/home/z/my-project/scripts/dev/indic-machine.json");
const { stateTable, accepting, tags } = m;
function* dfaMatch(cats) {
  let state = 1, startRun = null, lastAccepting = null, lastState = 0;
  for (let p = 0; p < cats.length; p++) {
    const c = cats[p]; lastState = state;
    state = stateTable[state][c];
    if (state === 0) {
      if (startRun != null && lastAccepting != null && lastAccepting >= startRun) yield [startRun, lastAccepting, tags[lastState][0] ?? null];
      state = stateTable[1][c];
      startRun = null;
    }
    if (state !== 0 && startRun == null) startRun = p;
    if (accepting[state]) lastAccepting = p;
  }
  if (startRun != null && lastAccepting != null && lastAccepting >= startRun) yield [startRun, lastAccepting, tags[state][0] ?? null];
}
const SYM = ["X","C","V","N","H","ZWNJ","ZWJ","M","SM","VD","A","Plc","DC","RS","Coeng","Repha","Ra","CM","Sym"];
// For each start symbol, for each second symbol: does the DFA make ONE run covering both? What tag?
console.log("start + next → (run covers both? resulting end tag when input ends there)");
for (let a = 1; a < 19; a++) {
  const row = [];
  for (let b = 0; b < 19; b++) {
    const runs = [...dfaMatch([a, b])];
    if (runs.length === 0) { row.push(`${SYM[b]}:--`); continue; }
    const covers = runs.some(([s, e]) => s === 0 && e >= 1);
    const tag = runs[runs.length-1][2] ?? "null";
    row.push(`${SYM[b]}:${covers ? (tag === null ? "T" : tag.slice(0,4)) : "x"}`);
  }
  console.log(`${SYM[a].padEnd(6)} ${row.join(" ")}`);
}
