const m = require("/home/z/my-project/scripts/dev/indic-machine.json");
const { stateTable, accepting, tags } = m;
const SYM = ["X","C","V","N","H","ZWNJ","ZWJ","M","SM","VD","A","Plc","DC","RS","Coeng","Repha","Ra","CM","Sym"];
function* match(str){
  let state = 1, startRun = null, lastAccepting = null, lastState = null;
  for (let p = 0; p < str.length; p++) {
    const c = str[p]; lastState = state;
    state = stateTable[state][c];
    if (state === 0) {
      if (startRun != null && lastAccepting != null && lastAccepting >= startRun) yield [startRun, lastAccepting, tags[lastState]];
      state = stateTable[1][c];
      startRun = null;
    }
    if (state !== 0 && startRun == null) startRun = p;
    if (accepting[state]) lastAccepting = p;
  }
  if (startRun != null && lastAccepting != null && lastAccepting >= startRun) yield [startRun, lastAccepting, tags[state]];
}
const tests = [
  "C H ZWJ M","C H ZWNJ M","C H ZWJ SM","C H ZWJ A","C H SM","C H A","C H N",
  "C ZWNJ H","C ZWJ H","C ZWNJ N","C ZWJ N","C ZWNJ M","C ZWJ M","C ZWNJ ZWJ",
  "N H","N M","N N","N SM","N A","N RS","N CM","N Coeng","N C","N V","N ZWJ","N ZWNJ",
  "M H N","M H H","M SM","M A","M N","M C","M V","M Ra","M CM","M Coeng","M RS","M ZWJ","M ZWNJ",
  "SM M","SM SM","SM A","SM H","SM N","SM C","SM ZWJ","SM ZWNJ","SM RS",
  "A M","A SM","A A","A H","A C","A ZWJ","A ZWNJ",
  "RS M","RS H","RS C","RS N","RS SM","RS ZWJ",
  "Coeng C","Coeng V","Coeng N","Coeng H","Coeng M","Coeng Coeng","Coeng Ra","Coeng CM","Coeng ZWJ",
  "Repha H","Repha C","Repha M","Repha N","Repha SM","Repha ZWJ","Repha V",
  "CM C","CM V","CM H","CM N","CM M","CM CM","CM Coeng","CM ZWJ","CM SM",
  "ZWNJ H","ZWJ H","ZWNJ M","ZWJ M","ZWNJ N","ZWJ N","ZWNJ ZWJ","ZWJ ZWJ","ZWNJ C","ZWJ C","ZWNJ SM","ZWJ SM",
  "V H","V ZWJ","V CM","V Coeng","V RS","V N","V M",
  "C CM M","C CM H","C CM N","C CM ZWJ","C CM SM","C Coeng M","C Coeng H","C Coeng N","C Coeng V","C Coeng ZWJ",
  "Sym N","Sym SM","Sym A","Sym M","Sym ZWJ","Sym C",
  "H ZWJ M","H ZWNJ M","H SM","H A","H M","H N","H C","H Ra","H V","H Coeng","H ZWJ C","H ZWJ ZWJ",
  "C H C M","C H C H","C H C ZWJ","C H C N","C H C SM","C H C A","C H C RS","C H C V","C H C CM","C H C Coeng","C H C ZWNJ H",
];
for (const t of tests) {
  const cats = t.split(" ").map(s => SYM.indexOf(s));
  const out = [...match(cats)].map(([s,e,tg]) => `${t.split(" ").slice(s,e+1).join(" ")}→${tg[0]}${tg.length>1?"(+"+(tg.length-1)+")":""}`);
  console.log(t.padEnd(22), out.join("  ") || "(none)");
}
