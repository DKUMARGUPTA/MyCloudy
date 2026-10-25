/**
 * Smoke test: i18n placeholder hygiene (R6-b).
 *
 * The catalogs carry keys with {param} placeholders. `t(key)` WITHOUT a
 * params object returns the raw catalog string — so a param-less render of
 * a placeholder-bearing key leaks a literal "{detail}" / "{count}" into the
 * UI. R6-b found exactly that family: 36 error toasts rendered
 * "…Please try again. {detail}" and 2 page alerts rendered
 * "…Unlock it first, then try again. {detail}".
 *
 * This smoke locks the whole family statically (house style: regex wiring
 * check over tools/ + src/):
 *   1. central catalog sanity — en/hi identical key sets + R6-a floor
 *      invariant (en == hi && >= 4366)
 *   2. the two honest error keys keep their {detail} placeholder in BOTH
 *      catalogs (the named-refusal UX depends on it)
 *   3. redact-pdf + sign-pdf render tool.errorEncrypted WITH the file name
 *      (detail: file?.name ?? "")
 *   4. ZERO param-less t("key") renders of any placeholder-bearing key,
 *      except the documented ALLOWLIST of intentional teaching/template
 *      keys (they SHOW the syntax or deliver a template string downstream)
 *
 * Run: bun scripts/smoke-i18n-params.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, extra = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ""}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  ✗ FAIL: ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

const ROOT = "/home/z/my-project";
const en = JSON.parse(
  readFileSync(join(ROOT, "src/i18n/en.json"), "utf8")
) as Record<string, Record<string, string>>;
const hi = JSON.parse(
  readFileSync(join(ROOT, "src/i18n/hi.json"), "utf8")
) as Record<string, Record<string, string>>;

/* ------------------------------------------------------------------ */
/* 1. central catalog sanity                                            */
/* ------------------------------------------------------------------ */

console.log("\n── 1. catalog sanity ────────────────────────────────────");
{
  const flat = (d: unknown, prefix = ""): string[] =>
    Object.entries(d as Record<string, unknown>).flatMap(([k, v]) =>
      typeof v === "string"
        ? [`${prefix}${k}`]
        : flat(v, `${prefix}${k}.`)
    );
  const enKeys = flat(en).sort();
  const hiKeys = flat(hi).sort();
  check(
    "en and hi have IDENTICAL key sets",
    enKeys.length === hiKeys.length &&
      enKeys.every((k, i) => k === hiKeys[i]),
    `en ${enKeys.length} vs hi ${hiKeys.length}`
  );
  // R6-a invariant pattern: a floor, never an exact count (every round adds keys).
  check(
    "leaf count respects the R6-a floor (>= 4366)",
    enKeys.length >= 4366,
    String(enKeys.length)
  );
}

/* ------------------------------------------------------------------ */
/* 2. honest error keys keep their {detail} placeholder                 */
/* ------------------------------------------------------------------ */

console.log("\n── 2. {detail} placeholders intact ──────────────────────");
{
  for (const [ns, key] of [
    ["tool", "errorGeneric"],
    ["tool", "errorEncrypted"],
  ] as const) {
    check(
      `en ${ns}.${key} carries {detail}`,
      en[ns]?.[key]?.includes("{detail}") === true,
      en[ns]?.[key]
    );
    check(
      `hi ${ns}.${key} carries {detail}`,
      hi[ns]?.[key]?.includes("{detail}") === true,
      hi[ns]?.[key]
    );
  }
}

/* ------------------------------------------------------------------ */
/* 3. the named-refusal render sites                                    */
/* ------------------------------------------------------------------ */

console.log("\n── 3. named-refusal render sites ────────────────────────");
{
  for (const surface of [
    "tools/redact-pdf/surface.tsx",
    "tools/sign-pdf/surface.tsx",
  ]) {
    const src = readFileSync(join(ROOT, surface), "utf8");
    check(
      `${surface} renders errorEncrypted WITH the file name`,
      src.includes('t("tool.errorEncrypted", { detail: file?.name ?? "" })')
    );
  }
}

/* ------------------------------------------------------------------ */
/* 4. static hygiene scan                                               */
/* ------------------------------------------------------------------ */

console.log("\n── 4. no param-less render of a placeholder key ─────────");
{
  // Intentional param-less renders — each SHOWS the placeholder syntax to
  // the user (teaching copy) or DELIVERS a template string downstream.
  // Renaming/adding any of these keys must update this list; the check
  // below fails if an allowlisted key vanishes from either catalog.
  const ALLOWLIST: Record<string, string> = {
    // teaches the {date} header/footer token ("Only used when {date} appears…")
    "hf.dateHint": "teaching copy: shows the {date} token",
    // header/footer placeholder examples in the write-pdf setup grid
    "write.setupHeaderPh": "teaching copy: placeholder text shows {date}",
    "write.setupFooterPh": "teaching copy: placeholder text shows {date}",
    "write.setupVars": "teaching copy: lists {date}/{page}/{pages} tokens",
    // table cell aria-label is completed by an explicit .replace("{r}"…) chain
    "write.tableCell": "aria label completed by .replace chains",
    // template strings handed to the WORKER, which interpolates {n}/{m}
    "ppt.notesHeadingFmt": "template value passed to worker options",
    "xls.footerFmt": "template value passed to worker options",
    // create-card's mail-merge syntax IS double-brace {{column}} (model.ts)
    "card.csvHint": "teaching copy: shows the {{column}} merge token",
  };

  const flat = (d: Record<string, Record<string, string>>): Map<string, string> => {
    const m = new Map<string, string>();
    for (const [ns, vals] of Object.entries(d))
      for (const [k, v] of Object.entries(vals)) m.set(`${ns}.${k}`, v);
    return m;
  };
  const enFlat = flat(en);
  const hiFlat = flat(hi);

  // A key is "placeholder-bearing" when its en value interpolates a plain
  // {word} token. ICU plural syntax ({n, plural, …}) is NOT matched — the
  // brace is followed by a comma, not a word char + }.
  const placeholderKeys = new Set(
    [...enFlat.entries()]
      .filter(([, v]) => /\{\w+\}/.test(v))
      .map(([k]) => k)
  );

  for (const key of Object.keys(ALLOWLIST)) {
    check(
      `allowlisted key ${key} exists in en + hi`,
      enFlat.has(key) && hiFlat.has(key)
    );
  }

  const glob = (pat: string): string[] => {
    // minimal recursive glob (no deps): walk tools/ + src/
    const out: string[] = [];
    const base = pat.slice(0, pat.indexOf("/**"));
    const exts = [".ts", ".tsx"];
    const walk = (dir: string): void => {
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const e of entries) {
        const full = join(dir, e);
        if (e.startsWith("node_modules") || e === ".next") continue;
        let isDir = false;
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          continue;
        }
        if (isDir) walk(full);
        else if (exts.some((x) => e.endsWith(x))) out.push(full);
      }
    };
    walk(join(ROOT, base));
    return out;
  };

  const { readdirSync, statSync } = await import("node:fs");
  const files = [...glob("tools/**"), ...glob("src/**")].filter(
    (f) => !f.startsWith(join(ROOT, "src/i18n/"))
  );

  const T_CALL = /\bt\(\s*(['"])([^'"]+)\1\s*\)/g;
  const leaks: string[] = [];
  for (const f of files) {
    const txt = readFileSync(f, "utf8");
    for (const m of txt.matchAll(T_CALL)) {
      const key = m[2];
      if (!placeholderKeys.has(key)) continue;
      const rel = f.slice(ROOT.length + 1);
      leaks.push(`${key} @ ${rel}:${txt.slice(0, m.index).split("\n").length}`);
    }
  }

  check(
    "every param-less render of a placeholder key is allowlisted (known set: 8)",
    leaks.every((l) => ALLOWLIST[l.split(" @ ")[0]] !== undefined),
    leaks.filter((l) => ALLOWLIST[l.split(" @ ")[0]] === undefined).join("; ") ||
      "no unknown leaks"
  );
  const byKey = new Map<string, number>();
  for (const l of leaks) {
    const k = l.split(" @ ")[0];
    byKey.set(k, (byKey.get(k) ?? 0) + 1);
  }
  const expected: Record<string, number> = {
    "hf.dateHint": 1,
    "write.setupHeaderPh": 1,
    "write.setupFooterPh": 1,
    "write.setupVars": 1,
    "write.tableCell": 1,
    "ppt.notesHeadingFmt": 2,
    "xls.footerFmt": 1,
    "card.csvHint": 1,
  };
  for (const [key, n] of Object.entries(expected)) {
    check(
      `${key}: exactly ${n} intentional site(s)`,
      byKey.get(key) === n,
      `found ${byKey.get(key) ?? 0}`
    );
  }
  check(
    "no allowlisted key lost its site silently (total == 9)",
    leaks.length === 9,
    `total ${leaks.length}`
  );
}

/* ------------------------------------------------------------------ */

console.log(`\nsmoke-i18n-params: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("FAILED:", ...failures);
}
process.exit(fail === 0 ? 0 : 1);
