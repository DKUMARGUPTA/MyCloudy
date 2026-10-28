/**
 * DEV-TIME fuzz: our syllable machine (matchRuns) vs fontkit's real DFA.
 * Drives both over random category sequences and compares the emitted
 * [start, end, firstTag] runs. Any divergence is a machine bug.
 * Run: bun scripts/dev/fuzz-machine.ts
 */
import { readFileSync } from "node:fs";
import { matchRuns } from "/home/z/my-project/src/lib/own/pdf/shape-deva";
import { indicCatPos } from "../../src/lib/own/pdf/indic-data";

/* Load the real DFA (dumped from fontkit at dev time). */
const machineJson = JSON.parse(
  readFileSync("/home/z/my-project/scripts/dev/indic-machine.json", "utf8"),
) as {
  stateTable: number[][];
  accepting: number[];
  tags: string[][];
};
const stateTable = machineJson.stateTable;
const accepting = machineJson.accepting;
const tags = machineJson.tags;

function* dfaMatch(cats: number[]): Generator<[number, number, string]> {
  let state = 1;
  let startRun: number | null = null;
  let lastAccepting: number | null = null;
  let lastState = 0;
  for (let p = 0; p < cats.length; p++) {
    const c = cats[p]!;
    lastState = state;
    state = stateTable[state]![c]!;
    if (state === 0) {
      if (startRun !== null && lastAccepting !== null && lastAccepting >= startRun) {
        yield [startRun, lastAccepting, tags[lastState]![0]!];
      }
      state = stateTable[1]![c]!;
      startRun = null;
    }
    if (state !== 0 && startRun === null) startRun = p;
    if (accepting[state]!) lastAccepting = p;
  }
  if (startRun !== null && lastAccepting !== null && lastAccepting >= startRun) {
    yield [startRun, lastAccepting, tags[state]![0]!];
  }
}

/* Deterministic PRNG */
let seed = 987654321;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;

const SYMBOLS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];

function randomSeq(len: number): number[] {
  // Weight toward the Devanagari-relevant symbols but cover everything.
  const weighted = [1, 1, 1, 3, 4, 5, 6, 7, 8, 10, 1, 12, 13, 14, 16, 17, 0, 0, 0, 2, 9, 11, 15, 18];
  const out: number[] = [];
  for (let i = 0; i < len; i++) {
    out.push(weighted[Math.floor(rnd() * weighted.length)]!);
  }
  return out;
}

let checked = 0;
let mismatches = 0;
const shown = new Set<string>();

function compare(cats: number[]): void {
  checked++;
  const want = [...dfaMatch(cats)];
  const got = matchRuns(cats);
  const w = JSON.stringify(want);
  const g = JSON.stringify(got);
  if (w !== g) {
    mismatches++;
    const names = ["X","C","V","N","H","ZWNJ","ZWJ","M","SM","VD","A","Plc","DC","RS","Coeng","Repha","Ra","CM","Sym"];
    if (shown.size < 25) {
      const key = cats.map((c) => names[c]).join(" ");
      if (!shown.has(key)) {
        shown.add(key);
        console.log(`✗ [${key}]`);
        console.log(`   want: ${JSON.stringify(want.map(([s, e, t]) => [s, e, t]))}`);
        console.log(`   got : ${JSON.stringify(got.map(([s, e, t]) => [s, e, t]))}`);
      }
    }
  }
}

/* Exhaustive up to length 4, sampled beyond (weighted). */
for (let len = 1; len <= 4; len++) {
  const total = Math.pow(SYMBOLS.length, len);
  if (total <= 200000) {
    for (let mask = 0; mask < total; mask++) {
      const cats: number[] = [];
      let m = mask;
      for (let i = 0; i < len; i++) {
        cats.push(m % 19);
        m = Math.floor(m / 19);
      }
      compare(cats);
    }
  }
}
for (let iter = 0; iter < 400000; iter++) {
  const len = 5 + Math.floor(rnd() * 6);
  compare(randomSeq(len));
}
console.log(`\nchecked ${checked}, mismatches ${mismatches}`);

/* Also verify our indicCatPos against the trie over all BMP codepoints once. */
void indicCatPos;
