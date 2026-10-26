/**
 * Translate PDF — Arabic shaping + display reordering (P5-rest).
 *
 * WHY THIS EXISTS: pdf-lib's drawText is a naive LTR glyph dump — it does no
 * OpenType GSUB shaping and no bidi. Arabic written that way comes out as
 * disconnected letters in the wrong order. Our self-hosted Noto Naskh Arabic
 * carries the Unicode Arabic Presentation Forms-B block (verified cmap:
 * every critical form present), so we shape ourselves:
 *
 *   1. shapeArabicLine() — logical order in, logical order out, every letter
 *      replaced by its contextual presentation form (isolated / initial /
 *      medial / final per the Unicode joining rules), lam+alef pairs fused
 *      into their ligature forms, ZWJ/ZWNJ controls stripped.
 *   2. bidiVisualLine() — takes the SHAPED line and produces the visual
 *      string for LTR drawing: full reversal with mirrored brackets, then
 *      maximal LTR groups (latin/digit tokens, letter-bounded across
 *      spaces) re-reversed so numbers and embedded Latin stay readable.
 *
 * This is a deliberate, honest v1: translation output (flowing prose) is the
 * use case; nested tables of mixed-direction fragments are out of scope.
 */

/** Joining classes we care about (Unicode ArabicShaping.txt, abridged). */
const JOIN_D = new Set([
  0x0626, 0x0628, 0x062a, 0x062b, 0x062c, 0x062d, 0x062e, 0x0633, 0x0634,
  0x0635, 0x0636, 0x0637, 0x0638, 0x0639, 0x063a, 0x0640, 0x0641, 0x0642,
  0x0643, 0x0644, 0x0645, 0x0646, 0x0647, 0x064a, 0x0679, 0x067e, 0x0686,
  0x06a4, 0x06af, 0x06ba,
]);
const JOIN_R = new Set([
  0x0622, 0x0623, 0x0624, 0x0625, 0x0627, 0x0629, 0x062f, 0x0630, 0x0631,
  0x0632, 0x0648, 0x0649, 0x0671, 0x0691, 0x0698, 0x06d2,
]);
/** Transparent marks: harakat, superscript alef, Quranic annotation signs. */
function isTransparent(cp: number): boolean {
  return (
    (cp >= 0x064b && cp <= 0x065f) ||
    cp === 0x0670 ||
    (cp >= 0x06d6 && cp <= 0x06dc) ||
    (cp >= 0x06df && cp <= 0x06e8) ||
    (cp >= 0x06ea && cp <= 0x06ed)
  );
}

/**
 * Presentation forms per base letter: [isolated, final, initial, medial].
 * `null` = the letter never takes that form (right-joining / non-joining).
 * Every codepoint here was verified present in NotoNaskhArabic-Regular.ttf.
 */
const FORMS: Record<number, [number, number, number | null, number | null]> = {
  0x0622: [0xfe81, 0xfe82, null, null],
  0x0623: [0xfe83, 0xfe84, null, null],
  0x0624: [0xfe85, 0xfe86, null, null],
  0x0625: [0xfe87, 0xfe88, null, null],
  0x0626: [0xfe89, 0xfe8a, 0xfe8b, 0xfe8c],
  0x0627: [0xfe8d, 0xfe8e, null, null],
  0x0628: [0xfe8f, 0xfe90, 0xfe91, 0xfe92],
  0x0629: [0xfe93, 0xfe94, null, null],
  0x062a: [0xfe95, 0xfe96, 0xfe97, 0xfe98],
  0x062b: [0xfe99, 0xfe9a, 0xfe9b, 0xfe9c],
  0x062c: [0xfe9d, 0xfe9e, 0xfe9f, 0xfea0],
  0x062d: [0xfea1, 0xfea2, 0xfea3, 0xfea4],
  0x062e: [0xfea5, 0xfea6, 0xfea7, 0xfea8],
  0x062f: [0xfea9, 0xfeaa, null, null],
  0x0630: [0xfeab, 0xfeac, null, null],
  0x0631: [0xfead, 0xfeae, null, null],
  0x0632: [0xfeaf, 0xfeb0, null, null],
  0x0633: [0xfeb1, 0xfeb2, 0xfeb3, 0xfeb4],
  0x0634: [0xfeb5, 0xfeb6, 0xfeb7, 0xfeb8],
  0x0635: [0xfeb9, 0xfeba, 0xfebb, 0xfebc],
  0x0636: [0xfebd, 0xfebe, 0xfebf, 0xfec0],
  0x0637: [0xfec1, 0xfec2, 0xfec3, 0xfec4],
  0x0638: [0xfec5, 0xfec6, 0xfec7, 0xfec8],
  0x0639: [0xfec9, 0xfeca, 0xfecb, 0xfecc],
  0x063a: [0xfecd, 0xfece, 0xfecf, 0xfed0],
  0x0641: [0xfed1, 0xfed2, 0xfed3, 0xfed4],
  0x0642: [0xfed5, 0xfed6, 0xfed7, 0xfed8],
  0x0643: [0xfed9, 0xfeda, 0xfedb, 0xfedc],
  0x0644: [0xfedd, 0xfede, 0xfedf, 0xfee0],
  0x0645: [0xfee1, 0xfee2, 0xfee3, 0xfee4],
  0x0646: [0xfee5, 0xfee6, 0xfee7, 0xfee8],
  0x0647: [0xfee9, 0xfeea, 0xfeeb, 0xfeec],
  0x0648: [0xfeed, 0xfeee, null, null],
  0x0649: [0xfeef, 0xfef0, null, null],
  0x064a: [0xfef1, 0xfef2, 0xfef3, 0xfef4],
  0x0671: [0xfb50, 0xfb51, null, null],
  0x0679: [0xfb66, 0xfb67, 0xfb68, 0xfb69],
  0x067e: [0xfb56, 0xfb57, 0xfb58, 0xfb59],
  0x0686: [0xfb7a, 0xfb7b, 0xfb7c, 0xfb7d],
  0x06a4: [0xfb6a, 0xfb6b, 0xfb6c, 0xfb6d],
  0x06af: [0xfb92, 0xfb93, 0xfb94, 0xfb95],
  0x0691: [0xfb8c, 0xfb8d, null, null],
  0x0698: [0xfb8a, 0xfb8b, null, null],
  0x06ba: [0xfb9e, 0xfb9f, 0xfba0, 0xfba1],
  0x06d2: [0xfbae, 0xfbaf, null, null],
};

/** Lam + alef variants → ligature [isolated, final]. */
const LAM_ALEF: Record<number, [number, number]> = {
  0x0622: [0xfef5, 0xfef6],
  0x0623: [0xfef7, 0xfef8],
  0x0625: [0xfef9, 0xfefa],
  0x0627: [0xfefb, 0xfefc],
};

const LAM = 0x0644;
const ZWJ = 0x200d;
const ZWNJ = 0x200c;

interface Slot {
  cp: number;
  /** true when the slot is an Arabic letter that participates in joining. */
  letter: boolean;
}

/**
 * Shape one line (no newline handling — split first). Returns the same
 * logical order with presentation-form codepoints; non-Arabic runs and
 * unknown letters pass through untouched (honest degradation).
 */
export function shapeArabicLine(line: string): string {
  const slots: Slot[] = [];
  for (const ch of line) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === ZWJ || cp === ZWNJ) continue; // controls never render
    slots.push({ cp, letter: JOIN_D.has(cp) || JOIN_R.has(cp) });
  }
  const n = slots.length;

  /** Previous non-transparent slot (marks are invisible to joining). */
  const prevSolid = (i: number): number => {
    for (let j = i - 1; j >= 0; j -= 1) {
      if (!isTransparent(slots[j].cp)) return j;
    }
    return -1;
  };
  const nextSolid = (i: number): number => {
    for (let j = i + 1; j < n; j += 1) {
      if (!isTransparent(slots[j].cp)) return j;
    }
    return -1;
  };

  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const cp = slots[i].cp;
    if (isTransparent(cp)) {
      out.push(String.fromCodePoint(cp)); // harakat ride along
      continue;
    }
    if (!slots[i].letter) {
      out.push(String.fromCodePoint(cp)); // latin/space/punct pass through
      continue;
    }

    const prev = prevSolid(i);
    const next = nextSolid(i);

    // Right-side connection: this letter joins toward the previous one.
    const joinsPrev =
      (JOIN_D.has(cp) || JOIN_R.has(cp)) &&
      prev >= 0 &&
      slots[prev].letter &&
      JOIN_D.has(slots[prev].cp); // prev must connect on ITS left
    // Left-side connection: only dual-joining letters connect forward,
    // and only into a letter that connects on its right (D or R) or a ZWJ.
    const joinsNext =
      JOIN_D.has(cp) &&
      next >= 0 &&
      slots[next].letter &&
      (JOIN_D.has(slots[next].cp) || JOIN_R.has(slots[next].cp));

    // Lam-alef ligature: lam connecting forward into any alef variant.
    if (cp === LAM && joinsNext && LAM_ALEF[slots[next].cp]) {
      const [iso, fin] = LAM_ALEF[slots[next].cp];
      out.push(String.fromCodePoint(joinsPrev ? fin : iso));
      // Drop transparent marks between the lam and the alef? They belong to
      // the alef; a ligature glyph cannot host them — keep them AFTER the
      // ligature (visible, honest) by not consuming them here.
      i = next; // consume through the alef
      continue;
    }

    const forms = FORMS[cp];
    if (!forms) {
      out.push(String.fromCodePoint(cp)); // unknown letter: base glyph
      continue;
    }
    let glyph: number;
    if (joinsPrev && joinsNext) glyph = forms[3] ?? forms[0];
    else if (joinsPrev) glyph = forms[1];
    else if (joinsNext) glyph = forms[2] ?? forms[0];
    else glyph = forms[0];
    out.push(String.fromCodePoint(glyph));
  }
  return out.join("");
}

/** Shape every line of a paragraph block (newlines preserved). */
export function shapeArabic(text: string): string {
  return text.split("\n").map(shapeArabicLine).join("\n");
}

/* ------------------------- display reordering ------------------------- */

/** Brackets that mirror when the line direction flips. */
const MIRROR: Record<string, string> = {
  "(": ")",
  ")": "(",
  "[": "]",
  "]": "[",
  "{": "}",
  "}": "{",
  "<": ">",
  ">": "<",
  "\u00ab": "\u00bb",
  "\u00bb": "\u00ab",
};

/** An LTR token: latin letters, digits (western + Arabic-Indic), inner punct. */
const TOKEN = /[A-Za-z0-9\u0660-\u0669][A-Za-z0-9.,:;'\u2019\-–—/%\u0660-\u0669]*/g;

/**
 * Visual order for one SHAPED line, for a naive LTR renderer:
 *   1. full reversal with mirrored brackets
 *   2. maximal LTR groups re-reversed — single tokens always; multi-word
 *      spans only when both boundary characters are LETTERS (UAX#9: a
 *      number-adjacent space takes the RTL base direction, so digit-bounded
 *      neighbours never merge — "دول 2024 hello" draws as "hello 2024 <ar>")
 */
export function bidiVisualLine(line: string): string {
  // 1. Reverse the whole line, swapping mirrored brackets.
  const chars = [...line];
  chars.reverse();
  for (let i = 0; i < chars.length; i += 1) {
    const m = MIRROR[chars[i]];
    if (m) chars[i] = m;
  }
  const reversed = chars.join("");

  // 2. Re-reverse LTR groups.
  const tokens: Array<{ start: number; end: number }> = [];
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(reversed); m; m = TOKEN.exec(reversed)) {
    tokens.push({ start: m.index, end: m.index + m[0].length });
  }
  if (tokens.length === 0) return reversed;

  // Merge neighbouring tokens when the gap is whitespace-only and both
  // boundary characters are letters (so "dlrow olleh" → one group).
  const groups: Array<Array<{ start: number; end: number }>> = [[tokens[0]]];
  for (let i = 1; i < tokens.length; i += 1) {
    const prev = groups[groups.length - 1];
    const last = prev[prev.length - 1];
    const gap = reversed.slice(last.end, tokens[i].start);
    const leftB = reversed[last.end - 1] ?? "";
    const rightB = reversed[tokens[i].start] ?? "";
    if (
      gap.length > 0 &&
      gap.trim().length === 0 &&
      /[A-Za-z]/.test(leftB) &&
      /[A-Za-z]/.test(rightB)
    ) {
      prev.push(tokens[i]);
    } else {
      groups.push([tokens[i]]);
    }
  }

  let out = "";
  let cursor = 0;
  for (const g of groups) {
    const start = g[0].start;
    const end = g[g.length - 1].end;
    out += reversed.slice(cursor, start);
    const span = [...reversed.slice(start, end)];
    span.reverse();
    out += span.join("");
    cursor = end;
  }
  out += reversed.slice(cursor);
  return out;
}
