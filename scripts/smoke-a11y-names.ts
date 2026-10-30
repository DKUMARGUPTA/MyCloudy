/**
 * Smoke: a11y names (P7-a) — the source-level accessible-name regression gate.
 *
 * DOM TRUTH (verified 2025-10-30, agent-browser, EVERY page): all 110 tool
 * pages + home + /#/search + /#/tools + about/contact/privacy/terms have
 * ZERO unnamed interactive elements. The one flag on the contact page was a
 * FALSE POSITIVE — Radix's hidden form-value <input> (aria-hidden, tabindex
 * -1, opacity 0): screen readers never announce it, and the actual control
 * (the role="checkbox" button) is labeled via <Label htmlFor={id}>.
 *
 * This smoke locks the SOURCE patterns that regress most easily, so the
 * battery catches them without a browser:
 *
 *  1. Icon-only buttons (`size="icon"`) must carry aria-label /
 *     aria-labelledby / title in the opening tag, or an sr-only child in
 *     the element body. Brace-aware tag extraction: inline arrow props
 *     contain `>` which terminates naive regexes (the exact bug the first
 *     source scan hit — 30 false "violations" that all had aria-labels
 *     after an onClick arrow).
 *  2. Lucide icons inside interactive elements must be aria-hidden="true"
 *     (decorative — the name lives on the control, not the glyph).
 *  3. The contact consent wiring: Checkbox id ↔ Label htmlFor pair.
 *  4. Wiring sanity: no surface file lost its i18n aria-label keys.
 *
 * Run: bun scripts/smoke-a11y-names.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  ✗ ${label}${actual !== undefined ? ` — ${JSON.stringify(actual).slice(0, 300)}` : ""}`);
  }
}

/* ------------------------------------------------------------------ */
/* Source collection (surfaces + doco components)                      */
/* ------------------------------------------------------------------ */

function collectTsx(dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (name.endsWith(".tsx") || name.endsWith(".ts")) out.push(full);
    }
  };
  for (const d of dirs) walk(d);
  return out;
}

/* ------------------------------------------------------------------ */
/* Brace-aware JSX opening-tag extraction                               */
/* ------------------------------------------------------------------ */

interface OpenTag {
  /** index of the '<' */
  start: number;
  /** index just past the '>' that closes the opening tag */
  end: number;
  /** the raw attribute text (between tag name and '>') */
  attrs: string;
  tagName: string;
}

/**
 * Finds <Button …> / <button …> opening tags with a scanner that tracks
 * brace/paren/bracket depth, so a '>' inside an inline arrow prop
 * (onClick={() => foo()}) does not terminate the capture.
 */
function findOpeningTags(src: string, tagNames: string[]): OpenTag[] {
  const out: OpenTag[] = [];
  const wanted = new Set(tagNames);
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt === -1) break;
    let p = lt + 1;
    while (p < n && /[A-Za-z0-9_.]/.test(src[p] ?? "")) p += 1;
    const tagName = src.slice(lt + 1, p);
    if (!wanted.has(tagName)) {
      i = lt + 1;
      continue;
    }
    // scan for the true end of the opening tag, tracking depth
    let depth = 0;
    let q = p;
    let end = -1;
    while (q < n) {
      const c = src[q]!;
      if (c === "{" || c === "(" || c === "[") depth += 1;
      else if (c === "}" || c === ")" || c === "]") depth -= 1;
      else if (c === ">" && depth <= 0) {
        // not '=>' at depth 0 (comparison operators are rare in props)
        if (src[q - 1] === "=" || src[q - 1] === "!") {
          q += 1;
          continue;
        }
        end = q;
        break;
      }
      q += 1;
    }
    if (end === -1) {
      i = lt + 1;
      continue;
    }
    out.push({ start: lt, end: end + 1, attrs: src.slice(p, end), tagName });
    i = end + 1;
  }
  return out;
}

/** The element body between the opening tag and its matching close. */
function elementBody(src: string, tag: OpenTag): string {
  const close = `</${tag.tagName}>`;
  const open = `<${tag.tagName}`;
  let depth = 1;
  let i = tag.end;
  while (i < src.length && depth > 0) {
    const nextClose = src.indexOf(close, i);
    const nextOpen = src.indexOf(open, i);
    if (nextClose === -1) return src.slice(tag.end, tag.end + 200);
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      i = nextOpen + open.length;
    } else {
      depth -= 1;
      if (depth === 0) return src.slice(tag.end, nextClose);
      i = nextClose + close.length;
    }
  }
  return src.slice(tag.end, tag.end + 200);
}

/**
 * True when the icon at `relIdx` in `body` sits inside an ancestor element
 * that carries aria-hidden="true" (e.g. the pagegrid/convert-from icon
 * wrapper spans — the glyph needs no own aria-hidden then). JSX child
 * expressions ({cond ? (<el/>) : null}) are NOT skipped — their elements
 * are real children (the edit-pdf stripCropped lesson).
 */
function hiddenByAncestor(body: string, relIdx: number): boolean {
  let i = 0;
  const stack: boolean[] = [false];
  while (i < relIdx) {
    const c = body[i]!;
    if (c === "<") {
      const m = /^<\/?[A-Za-z][^>]*>/.exec(body.slice(i, relIdx + 200));
      if (m) {
        const tag = m[0];
        if (tag.startsWith("</")) {
          if (stack.length > 1) stack.pop();
        } else if (!tag.endsWith("/>")) {
          stack.push(/aria-hidden/.test(tag));
        }
        i += tag.length;
        continue;
      }
    }
    i += 1;
  }
  return stack.some(Boolean);
}

/* ------------------------------------------------------------------ */
/* 1. Icon-only buttons must be named                                   */
/* ------------------------------------------------------------------ */

const files = [
  ...collectTsx(["tools"]),
  ...collectTsx(["src/components/doco"]),
];

check(
  "scan surface: files collected (tools + doco components)",
  files.length > 60,
  { count: files.length }
);

interface Violation {
  file: string;
  line: number;
}

const unnamedIconButtons: Violation[] = [];
let iconButtons = 0;
let namedViaAttr = 0;
let namedViaSrOnly = 0;

for (const file of files) {
  const src = readFileSync(file, "utf8");
  for (const tag of findOpeningTags(src, ["Button", "button"])) {
    if (!/size="icon"|size=\{"icon"\}/.test(tag.attrs)) continue;
    iconButtons += 1;
    if (/aria-label=|aria-labelledby=|title=/.test(tag.attrs)) {
      namedViaAttr += 1;
      continue;
    }
    const body = elementBody(src, tag);
    if (/sr-only/.test(body)) {
      namedViaSrOnly += 1;
      continue;
    }
    unnamedIconButtons.push({
      file: file.replace(/^\.\//, ""),
      line: src.slice(0, tag.start).split("\n").length,
    });
  }
}

check(
  "icon-only buttons: every size=\"icon\" button has an accessible name (attr or sr-only child)",
  unnamedIconButtons.length === 0,
  { iconButtons, namedViaAttr, namedViaSrOnly, unnamed: unnamedIconButtons.slice(0, 10) }
);
check(
  "icon-only buttons: the codebase actually has icon buttons to guard",
  iconButtons >= 50,
  { iconButtons }
);

/* ------------------------------------------------------------------ */
/* 2. Lucide icons inside buttons are aria-hidden                        */
/* ------------------------------------------------------------------ */

let iconsInButtons = 0;
let hiddenIcons = 0;
const visibleIcons: Violation[] = [];

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const buttons = findOpeningTags(src, ["Button", "button"]);
  for (const tag of buttons) {
    const body = elementBody(src, tag);
    // lucide glyphs: <IconName … /> or <IconName …></IconName>
    for (const m of body.matchAll(/<([A-Z][A-Za-z0-9]*)\b[^>]*\/>/g)) {
      const iconTag = m[0];
      const isLucide = /Icon|Chevron|Arrow|X$|Plus|Minus|Trash|Check|Search|Menu|Zoom|Copy|Download|Upload|Eye|File|Folder|Grip|Rotate|Move|Printer|Play|Pause|Info|Alert|Circle|Square|Star|Heart|Lock|Key|Pen|Pencil|Scissors|Sparkle|Sun|Moon|Globe|Lang|Theme|Maximize|Minimize|Panel|Rows|Columns|Grid|List|Table|Link|Unlink|Refresh|Reload|Repeat|Undo|Redo|Save|Send|Share|Settings|Sliders|Filter|Calendar|Clock|Map|Mail|Phone|User|Users|Credit|Receipt|Signature|Stamp|Book|Bookmark|Tag|Layers|Combine|Merge|Split|Slice|Crop|Frame|Image|Camera|Scan|Wand|Wand2|Zap|Bolt|Cloud|Database|Hard|Package|Box|Archive|Briefcase|Business/.test(m[1]!) || m[1]!.length <= 2;
      if (!isLucide) continue;
      if (/\balt=/.test(iconTag)) continue; // a meaningful image (ChipImage) — alt is its name
      iconsInButtons += 1;
      if (/aria-hidden/.test(iconTag)) hiddenIcons += 1;
      else if (m.index !== undefined && hiddenByAncestor(body, m.index)) {
        hiddenIcons += 1; // an ancestor wrapper is aria-hidden (pagegrid pattern)
      } else {
        const iconStart = tag.end + m.index!;
        visibleIcons.push({
          file: file.replace(/^\.\//, ""),
          line: src.slice(0, iconStart).split("\n").length,
        });
      }
    }
  }
}

check(
  "decorative icons: lucide glyphs inside buttons are aria-hidden (the name lives on the control)",
  visibleIcons.length === 0,
  { iconsInButtons, hiddenIcons, visible: visibleIcons.slice(0, 10) }
);

/* ------------------------------------------------------------------ */
/* 3. The contact consent wiring (id ↔ htmlFor)                         */
/* ------------------------------------------------------------------ */

{
  const contactSrc = readFileSync("src/components/doco/page/contact-page.tsx", "utf8");
  check(
    "contact: consent Checkbox id + Label htmlFor pair (the label-for contract)",
    /id=\{`\$\{formId\}-consent`\}/.test(contactSrc) &&
      /htmlFor=\{`\$\{formId\}-consent`\}/.test(contactSrc)
  );
  check(
    "contact: the honeypot is aria-hidden (bots fill it, SRs skip it)",
    /aria-hidden="true"/.test(contactSrc)
  );
}

/* ------------------------------------------------------------------ */
/* 4. aria-label usage floor (the surfaces did not lose their names)    */
/* ------------------------------------------------------------------ */

{
  let ariaLabels = 0;
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    ariaLabels += (src.match(/aria-label/g) ?? []).length;
  }
  check(
    "floor sanity: aria-label usage across surfaces stays high",
    ariaLabels >= 400,
    { ariaLabels, files: files.length }
  );
}

/* ------------------------------------------------------------------ */
/* 5. Every surface's interactive file participates (no orphans)        */
/* ------------------------------------------------------------------ */

{
  // Every tool directory has at least one .tsx scanned.
  const toolDirs = readdirSync("tools").filter((d) => {
    try {
      return statSync(join("tools", d)).isDirectory();
    } catch {
      return false;
    }
  });
  const scanned = new Set(files.map((f) => f.split("/")[1]!).filter((_, i) => true));
  const noUi = toolDirs.filter((d) => {
    const has = files.some((f) => f.startsWith(`tools/${d}/`));
    return !has && !["create-invoice", "xml-invoice-to-pdf"].includes(d) || !has;
  }).filter((d) => !files.some((f) => f.startsWith(`tools/${d}/`)));
  check(
    "coverage: every tool directory has at least one scanned UI file",
    noUi.length === 0,
    { toolDirs: toolDirs.length, noUi: noUi.slice(0, 10) }
  );
  check(
    "coverage: scanned set is populated",
    scanned.size > 50,
    { scanned: scanned.size }
  );
}

console.log(`\na11y-names smoke: ${pass} passed, ${fail} failed${fail > 0 ? ` — ${failures.join(" | ")}` : ""}`);
process.exit(fail > 0 ? 1 : 0);
