import type { FillFieldScan } from "./scan";

/**
 * FDF / XFDF import-export (PRD §8.2 extension).
 *
 * The two classic "form answers" interchange formats Adobe defined for
 * AcroForms — small, text-based and portable:
 *
 *  FDF — a one-object PDF-ish file:
 *    %FDF-1.2
 *    1 0 obj
 *    << /FDF << /F (target.pdf) /Fields [
 *    << /T (applicant.name) /V (Arjun Mehta) >>
 *    << /T (consent.agree) /V /Yes >>
 *    << /T (skills.languages) /V [(Hindi) (Tamil)] >>
 *    ] >> >>
 *    endobj
 *    trailer
 *    << /Root 1 0 R >>
 *    %%EOF
 *
 *  XFDF — the XML variant:
 *    <xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">
 *      <f href="target.pdf"/>
 *      <fields>
 *        <field name="applicant.name"><value>Arjun Mehta</value></field>
 *        <field name="consent.agree"><value>Yes</value></field>
 *      </fields>
 *    </xfdf>
 *
 * PURE module (no DOM, no pdf-lib): the surface exports the current
 * effective answers, and imported entries are matched against the scan in
 * matchFdfEntries() — which owns the honesty rules (unknown name, read-only
 * field, kind mismatch and off-list option values are all counted as
 * skipped, never silently applied). Multi-select values join with "\n"
 * (the surface/worker's own convention).
 */

/** One field answer: string value (multi-select "\n"-joined) or checkbox state. */
export interface FdfEntry {
  name: string;
  value: string | boolean;
}

/** Raised by parseFdfOrXfdf when the text is neither format. */
export class FdfParseError extends Error {
  code: string;
  constructor(code = "fill.fdfBadFile") {
    super(code);
    this.name = "FdfParseError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* PDF literal-string escaping (shared by FDF build + parse)           */
/* ------------------------------------------------------------------ */

/** Escape \, (, ) and control chars for a PDF literal string. */
function escapePdfString(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\\") out += "\\\\";
    else if (ch === "(") out += "\\(";
    else if (ch === ")") out += "\\)";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) {
      // Octal form for the remaining control characters.
      out += `\\${code.toString(8).padStart(3, "0")}`;
    } else out += ch;
  }
  return out;
}

/**
 * PDF literal-string unescape: \n \r \t \b \f \( \) \\, octal \ddd
 * (1–3 digits) and the backslash-newline line continuation.
 */
function unescapePdfString(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) break; // trailing backslash — drop
    if (next === "n") {
      out += "\n";
      i += 1;
    } else if (next === "r") {
      out += "\r";
      i += 1;
    } else if (next === "t") {
      out += "\t";
      i += 1;
    } else if (next === "b") {
      out += "\b";
      i += 1;
    } else if (next === "f") {
      out += "\f";
      i += 1;
    } else if (next === "(" || next === ")" || next === "\\") {
      out += next;
      i += 1;
    } else if (next === "\n" || next === "\r") {
      // Line continuation — nothing emitted (swallow a following LF too).
      i += 1;
      if (next === "\r" && text[i + 1] === "\n") i += 1;
    } else if (next >= "0" && next <= "7") {
      let oct = "";
      let j = i + 1;
      while (j < text.length && oct.length < 3 && text[j] >= "0" && text[j] <= "7") {
        oct += text[j];
        j += 1;
      }
      out += String.fromCharCode(parseInt(oct, 8) & 0xff);
      i = j - 1;
    } else {
      // Unknown escape — per spec the character stands as itself.
      out += next;
      i += 1;
    }
  }
  return out;
}

/** End index (exclusive) of the literal string starting at `open` (a "("). */
function pdfStringEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      i += 1; // skip the escaped character
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1; // unterminated — caller decides
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

/**
 * The exportable answers of a scanned form. `valueOf` supplies the
 * EFFECTIVE value (user override or the file's own) exactly like the
 * surface inputs show. Read-only fields are skipped — they can never be
 * re-applied by an import, so shipping them would be dishonest; the empty
 * checkbox is the classic "absent = off" and is skipped too.
 */
export function buildFdfEntries(
  fields: FillFieldScan[],
  valueOf: (field: FillFieldScan) => string | boolean
): FdfEntry[] {
  const entries: FdfEntry[] = [];
  for (const field of fields) {
    if (field.readOnly) continue;
    const value = valueOf(field);
    if (field.kind === "checkbox") {
      if (value === true) entries.push({ name: field.name, value: true });
      continue;
    }
    const text = typeof value === "string" ? value : "";
    if (text !== "") entries.push({ name: field.name, value: text });
  }
  return entries;
}

/** Classic FDF document for the entries (pdfName = the source PDF's file name). */
export function buildFdf(entries: FdfEntry[], pdfName: string): string {
  const lines: string[] = [
    "%FDF-1.2",
    "1 0 obj",
    `<< /FDF << /F (${escapePdfString(pdfName)}) /Fields [`,
  ];
  for (const entry of entries) {
    const name = escapePdfString(entry.name);
    if (entry.value === true) {
      lines.push(`<< /T (${name}) /V /Yes >>`);
      continue;
    }
    if (typeof entry.value === "boolean") {
      lines.push(`<< /T (${name}) /V /Off >>`);
      continue;
    }
    const parts = entry.value.split("\n").filter((part) => part !== "");
    if (parts.length > 1) {
      // Multi-select list: an array of literal strings.
      lines.push(
        `<< /T (${name}) /V [${parts
          .map((part) => `(${escapePdfString(part)})`)
          .join(" ")}] >>`
      );
    } else {
      lines.push(`<< /T (${name}) /V (${escapePdfString(entry.value)}) >>`);
    }
  }
  lines.push("] >> >>", "endobj", "trailer", "<< /Root 1 0 R >>", "%%EOF", "");
  return lines.join("\n");
}

/** XFDF (XML variant) for the entries. */
export function buildXfdf(entries: FdfEntry[], pdfName: string): string {
  const esc = (text: string): string =>
    text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">',
    `  <f href="${esc(pdfName)}"/>`,
    "  <fields>",
  ];
  for (const entry of entries) {
    const name = esc(entry.name);
    if (entry.value === true) {
      lines.push(`    <field name="${name}"><value>Yes</value></field>`);
      continue;
    }
    if (typeof entry.value === "boolean") {
      lines.push(`    <field name="${name}"><value>Off</value></field>`);
      continue;
    }
    const parts = entry.value.split("\n").filter((part) => part !== "");
    const values = (parts.length ? parts : [""])
      .map((part) => `      <value>${esc(part)}</value>`)
      .join("\n");
    lines.push(`    <field name="${name}">`, values, `    </field>`);
  }
  lines.push("  </fields>", "</xfdf>", "");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Parse                                                               */
/* ------------------------------------------------------------------ */

/** Skip whitespace from `pos`; return the index of the next non-space. */
function skipWs(text: string, pos: number): number {
  while (pos < text.length && /\s/.test(text[pos])) pos += 1;
  return pos;
}

/** Parse one field dict body (between << and >>) into an entry, or null. */
function parseFdfDict(body: string): FdfEntry | null {
  let name: string | null = null;
  const values: (string | boolean)[] = [];
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== "/") continue;
    const key = body[i + 1];
    if (key !== "T" && key !== "V") continue;
    // Only whole /T and /V keys (not /Type etc. — check the next char).
    const after = body[i + 2];
    if (after !== undefined && !/[\s/[\](<]/.test(after)) continue;
    let pos = skipWs(body, i + 2);
    if (pos >= body.length) continue;
    if (body[pos] === "(") {
      const end = pdfStringEnd(body, pos);
      if (end === -1) continue;
      const text = unescapePdfString(body.slice(pos + 1, end - 1));
      if (key === "T") name = text;
      else values.push(text);
      i = end - 1;
    } else if (body[pos] === "/") {
      // A name value (checkbox export state, sometimes radio values).
      let end = pos + 1;
      while (end < body.length && !/[\s/>\]]/.test(body[end])) end += 1;
      const nm = body.slice(pos + 1, end);
      if (key === "V") values.push(nm === "Off" ? false : true);
      i = end - 1;
    } else if (body[pos] === "[") {
      // An array of literal strings (multi-select list values).
      const close = body.indexOf("]", pos);
      if (close === -1) continue;
      const inner = body.slice(pos + 1, close);
      const parts: string[] = [];
      let p = 0;
      while (p < inner.length) {
        const open = inner.indexOf("(", p);
        if (open === -1) break;
        const end = pdfStringEnd(inner, open);
        if (end === -1) break;
        parts.push(unescapePdfString(inner.slice(open + 1, end - 1)));
        p = end;
      }
      if (key === "V" && parts.length) values.push(parts.join("\n"));
      i = close - 1;
    }
  }
  if (name === null || values.length === 0) return null;
  // A checkbox entry carries its boolean; anything else joins as text
  // (multi-value strings keep the "\n" convention of the surface).
  if (values.every((v) => typeof v === "boolean")) {
    return { name, value: values[values.length - 1] };
  }
  return { name, value: values.filter((v) => typeof v === "string").join("\n") };
}

/** Parse an FDF document into entries (FdfParseError when malformed). */
export function parseFdf(text: string): FdfEntry[] {
  const fieldsIdx = text.indexOf("/Fields");
  if (fieldsIdx === -1) return [];
  const open = text.indexOf("[", fieldsIdx);
  if (open === -1) throw new FdfParseError();
  // Find the matching ] (strings may contain brackets — skip their bodies).
  let depth = 0;
  let close = -1;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "(") {
      const end = pdfStringEnd(text, i);
      if (end === -1) break;
      i = end - 1;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) throw new FdfParseError();
  const body = text.slice(open + 1, close);

  const entries: FdfEntry[] = [];
  let pos = 0;
  while (true) {
    const dictOpen = body.indexOf("<<", pos);
    if (dictOpen === -1) break;
    // Find the closing >> outside strings (field dicts here are flat).
    let dictClose = -1;
    for (let i = dictOpen + 2; i < body.length; i += 1) {
      const ch = body[i];
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === "(") {
        const end = pdfStringEnd(body, i);
        if (end === -1) break;
        i = end - 1;
        continue;
      }
      if (ch === ">" && body[i + 1] === ">") {
        dictClose = i;
        break;
      }
    }
    if (dictClose === -1) break;
    const entry = parseFdfDict(body.slice(dictOpen + 2, dictClose));
    if (entry !== null) entries.push(entry);
    pos = dictClose + 2;
  }
  return entries;
}

function xmlUnescape(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(Number(dec))
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Parse an XFDF document into entries. Regexes cover the narrow XFDF
 * grammar (attribute-quoted <field name="…"> with <value> children) —
 * tolerant of attribute order and whitespace, the same output Acrobat
 * itself produces.
 */
export function parseXfdf(text: string): FdfEntry[] {
  const entries: FdfEntry[] = [];
  const fieldRe = /<field\b[^>]*?name\s*=\s*(["'])((?:[^\\]|\\.)*?)\1[^>]*>([\s\S]*?)<\/field\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = fieldRe.exec(text)) !== null) {
    const name = xmlUnescape(match[2]);
    const inner = match[3];
    const values: string[] = [];
    const valueRe = /<value\b[^>]*>([\s\S]*?)<\/value\s*>/gi;
    let vm: RegExpExecArray | null;
    while ((vm = valueRe.exec(inner)) !== null) {
      values.push(xmlUnescape(vm[1]));
    }
    if (name === "" || values.length === 0) continue;
    // "Yes"/"Off" is the XFDF checkbox convention — but the entry layer
    // cannot know the field kind, so keep the string; matchFdfEntries
    // resolves it against the scan (kind-aware).
    entries.push({ name, value: values.join("\n") });
  }
  return entries;
}

/** Sniff the text and parse it as FDF or XFDF (else FdfParseError). */
export function parseFdfOrXfdf(text: string): FdfEntry[] {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("%FDF")) return parseFdf(trimmed);
  if (/<\?xml[\s\S]*?<fields?/i.test(trimmed) || /<xfdf/i.test(trimmed)) {
    const entries = parseXfdf(trimmed);
    if (entries.length > 0 || /<xfdf/i.test(trimmed)) return entries;
  }
  throw new FdfParseError();
}

/* ------------------------------------------------------------------ */
/* Import matching (the honesty rules — pure + testable)               */
/* ------------------------------------------------------------------ */

export interface FdfApply {
  name: string;
  value: string | boolean;
}

export interface FdfMatch {
  applies: FdfApply[];
  /** Unknown name / read-only / kind mismatch / off-list value / over-length empty. */
  skipped: number;
}

/** Checkbox truthy spellings an imported string may carry. */
function checkboxState(text: string): boolean {
  const v = text.trim().toLowerCase();
  return v !== "" && v !== "off" && v !== "false" && v !== "0";
}

/**
 * Match imported entries against the scanned fields. Every entry is either
 * applied (exact field-name match, editable, kind-compatible, value on the
 * option list for choice fields, text truncated to maxLength) or counted
 * in `skipped` — nothing is silently dropped or guessed.
 */
export function matchFdfEntries(
  entries: FdfEntry[],
  fields: FillFieldScan[]
): FdfMatch {
  const byName = new Map(fields.map((field) => [field.name, field]));
  const applies: FdfApply[] = [];
  let skipped = 0;
  for (const entry of entries) {
    const field = byName.get(entry.name);
    if (!field || field.readOnly) {
      skipped += 1;
      continue;
    }
    if (field.kind === "checkbox") {
      if (typeof entry.value === "boolean") {
        applies.push({ name: field.name, value: entry.value });
      } else {
        // XFDF carries checkbox state as the string "Yes"/"Off".
        applies.push({ name: field.name, value: checkboxState(entry.value) });
      }
      continue;
    }
    if (typeof entry.value === "boolean") {
      skipped += 1; // a checkbox-style value for a non-checkbox field
      continue;
    }
    let text = entry.value;
    if (field.kind === "text") {
      if (field.maxLength !== null && field.maxLength >= 0) {
        text = text.slice(0, field.maxLength);
      }
    } else if (text !== "") {
      // Radio / dropdown / optionlist: every part must be a real option.
      const parts = text.split("\n").filter((part) => part !== "");
      if (
        parts.length === 0 ||
        parts.some((part) => !field.options.includes(part))
      ) {
        skipped += 1;
        continue;
      }
    }
    applies.push({ name: field.name, value: text });
  }
  return { applies, skipped };
}
