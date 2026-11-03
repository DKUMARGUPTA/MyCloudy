import { ALL_TOOLS, CATEGORIES } from "../../src/lib/tools/registry";
const byCat: Record<string, number> = {};
for (const t of ALL_TOOLS) {
  if (!t.enabled) continue;
  byCat[t.category] = (byCat[t.category] ?? 0) + 1;
}
let total = 0;
for (const c of CATEGORIES) {
  console.log(c.id, byCat[c.id] ?? 0);
  total += byCat[c.id] ?? 0;
}
console.log("TOTAL enabled:", total, "| ALL_TOOLS len:", ALL_TOOLS.length);
