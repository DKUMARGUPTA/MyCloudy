/**
 * xml-invoice-to-pdf — a hand-rolled, namespace-aware XML parser.
 *
 * Why not DOMParser: the smoke script runs in bun (no DOM), and the tool
 * must parse in both the surface (live preview) and the worker (render)
 * with the EXACT same behaviour. One pure module, zero dependencies,
 * built for the two dialects this tool reads (UBL 2.1 and CII /
 * Cross-Industry-Invoice) — but a correct general well-formedness
 * parser: prolog, comments, CDATA, DOCTYPE skip, entity decoding,
 * prefixed + default namespaces, self-closing tags, BOM, UTF-8.
 *
 * Malformed input throws Error("xinv.errorXml") — an i18n key the
 * surface and worker translate. It never throws anything but that key.
 */

export interface XmlAttr {
  /** Namespace URI for prefixed attributes, "" for unprefixed. */
  ns: string;
  /** Local name (prefix stripped). */
  name: string;
  value: string;
}

export interface XmlNode {
  /** Namespace URI ("" when the element has no namespace). */
  ns: string;
  /** Local name — prefix stripped, namespace-resolved. */
  name: string;
  /** Attributes; unprefixed keys stored by local name. */
  attrs: Record<string, string>;
  attrList: XmlAttr[];
  children: XmlNode[];
  /** Concatenated character data (entities decoded, CDATA included). */
  text: string;
}

/* ------------------------------------------------------------------ */
/* Public lookup helpers (the dialect layers build on these)            */
/* ------------------------------------------------------------------ */

/** First child with the exact namespace + local name. */
export function child(
  node: XmlNode,
  ns: string,
  name: string
): XmlNode | undefined {
  return node.children.find((c) => c.ns === ns && c.name === name);
}

/** All children with the exact namespace + local name. */
export function children(
  node: XmlNode,
  ns: string,
  name: string
): XmlNode[] {
  return node.children.filter((c) => c.ns === ns && c.name === name);
}

/** Deep search: first descendant with ns+name (pre-order). */
export function descendant(
  node: XmlNode,
  ns: string,
  name: string
): XmlNode | undefined {
  for (const c of node.children) {
    if (c.ns === ns && c.name === name) return c;
    const hit = descendant(c, ns, name);
    if (hit) return hit;
  }
  return undefined;
}

/** Trimmed text of the FIRST child with ns+name, "" when absent. */
export function textOf(node: XmlNode, ns: string, name: string): string {
  const c = child(node, ns, name);
  return c ? c.text.trim() : "";
}

/* ------------------------------------------------------------------ */
/* Entity decoding                                                      */
/* ------------------------------------------------------------------ */

const BUILTIN: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(input: string): string {
  if (!input.includes("&")) return input;
  let out = "";
  let i = 0;
  while (i < input.length) {
    const amp = input.indexOf("&", i);
    if (amp < 0) {
      out += input.slice(i);
      break;
    }
    out += input.slice(i, amp);
    const semi = input.indexOf(";", amp);
    // No terminator (or an absurdly long one): emit & literally.
    if (semi < 0 || semi - amp > 10) {
      out += "&";
      i = amp + 1;
      continue;
    }
    const ent = input.slice(amp + 1, semi);
    if (ent.startsWith("#x") || ent.startsWith("#X")) {
      const code = Number.parseInt(ent.slice(2), 16);
      out += Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : "";
    } else if (ent.startsWith("#")) {
      const code = Number.parseInt(ent.slice(1), 10);
      out += Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : "";
    } else if (BUILTIN[ent] !== undefined) {
      out += BUILTIN[ent];
    } else {
      // Unknown named entity: emit as-is (lenient — files in the wild
      // occasionally carry &nbsp; from sloppy exporters).
      out += "&" + ent + ";";
    }
    i = semi + 1;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The tokenizer                                                        */
/* ------------------------------------------------------------------ */

function fail(): never {
  throw new Error("xinv.errorXml");
}

/** prefix ("" = default) → namespace URI. */
type Bindings = Map<string, string>;

export function parseXml(bytes: Uint8Array): XmlNode {
  // UTF-8 with BOM strip; both e-invoice dialects are UTF-8 in
  // practice. Invalid bytes → U+FFFD replacement (never a crash).
  let src = new TextDecoder("utf-8").decode(bytes);
  if (src.startsWith("﻿")) src = src.slice(1);

  const n = src.length;
  let i = 0;
  const stack: XmlNode[] = [];
  /** Raw tag names (prefix included) of the open elements. */
  const openRaw: string[] = [];
  /** Namespace bindings of the open elements; [0] is the empty base. */
  const scopes: Bindings[] = [new Map()];
  let root: XmlNode | null = null;

  const skipWs = (): void => {
    while (i < n && /\s/.test(src[i])) i++;
  };

  const readName = (): string => {
    const start = i;
    while (i < n && /[^\s/>=]/.test(src[i])) i++;
    if (i === start) fail();
    return src.slice(start, i);
  };

  /** Resolve `prefix` against the binding chain (innermost last). */
  const lookup = (prefix: string, chain: Bindings[]): string | undefined => {
    for (let k = chain.length - 1; k >= 0; k--) {
      const uri = chain[k].get(prefix);
      if (uri !== undefined) return uri;
    }
    return undefined;
  };

  while (i < n) {
    if (src[i] !== "<") {
      // Character data until the next tag.
      const lt = src.indexOf("<", i);
      const stop = lt < 0 ? n : lt;
      const chunk = decodeEntities(src.slice(i, stop));
      if (stack.length > 0) stack[stack.length - 1].text += chunk;
      else if (chunk.trim() !== "") fail(); // text before the root
      i = stop;
      continue;
    }

    if (src.startsWith("<?", i)) {
      const close = src.indexOf("?>", i + 2);
      if (close < 0) fail();
      i = close + 2;
      continue;
    }

    if (src.startsWith("<!--", i)) {
      const close = src.indexOf("-->", i + 4);
      if (close < 0) fail();
      i = close + 3;
      continue;
    }

    if (src.startsWith("<![CDATA[", i)) {
      const close = src.indexOf("]]>", i + 9);
      if (close < 0) fail();
      if (stack.length > 0) stack[stack.length - 1].text += src.slice(i + 9, close);
      i = close + 3;
      continue;
    }

    if (src.startsWith("<!", i)) {
      // DOCTYPE — skip with quote + bracket matching. `>` only ends
      // the declaration OUTSIDE the internal subset's brackets.
      i += 2;
      let done = false;
      let brackets = 0;
      let inQuote: string | null = null;
      while (i < n && !done) {
        const ch = src[i];
        if (inQuote !== null) {
          if (ch === inQuote) inQuote = null;
        } else if (ch === '"' || ch === "'") inQuote = ch;
        else if (ch === "[") brackets++;
        else if (ch === "]") brackets = Math.max(0, brackets - 1);
        else if (ch === ">" && brackets === 0) done = true;
        i++;
      }
      if (!done) fail();
      continue;
    }

    if (src.startsWith("</", i)) {
      i += 2;
      skipWs();
      const raw = readName();
      skipWs();
      if (src[i] !== ">") fail();
      i++;
      const top = stack.pop();
      const expected = openRaw.pop();
      scopes.pop();
      if (top === undefined || expected === undefined || raw !== expected) fail();
      continue;
    }

    if (src[i] !== "<") fail();
    i++;
    const raw = readName();

    const parent = stack[stack.length - 1];
    /** This element's own scope: parent bindings + its xmlns decls. */
    const scope: Bindings = new Map(scopes[scopes.length - 1]);
    const rawAttrs: { raw: string; value: string }[] = [];

    // ---- Pass 1: read attributes; xmlns decls go straight into scope.
    for (;;) {
      const beforeWs = i;
      skipWs();
      if (i >= n) fail();
      if (src[i] === "/" || src[i] === ">") break;
      if (i === beforeWs) fail(); // garbage between attributes
      const rawAttr = readName();
      skipWs();
      if (src[i] !== "=") fail();
      i++;
      skipWs();
      const quote = src[i];
      if (quote !== '"' && quote !== "'") fail();
      i++;
      const close = src.indexOf(quote, i);
      if (close < 0) fail();
      const value = decodeEntities(src.slice(i, close));
      i = close + 1;

      if (rawAttr === "xmlns") scope.set("", value);
      else if (rawAttr.startsWith("xmlns:")) scope.set(rawAttr.slice(6), value);
      else rawAttrs.push({ raw: rawAttr, value });
    }

    const selfClosing = src[i] === "/";
    if (selfClosing) i++;
    if (src[i] !== ">") fail();
    i++;

    // ---- Pass 2: namespace-resolve the element + its attributes.
    const prefix = raw.includes(":") ? raw.slice(0, raw.indexOf(":")) : "";
    const local = raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : raw;
    const ownChain = [...scopes, scope];
    let ns = lookup(prefix, ownChain);
    if (ns === undefined) {
      if (prefix === "") ns = "";
      else fail(); // undeclared prefix
    }

    const attrList: XmlAttr[] = [];
    const attrs: Record<string, string> = {};
    for (const { raw: rawAttr, value } of rawAttrs) {
      const aPrefix = rawAttr.includes(":")
        ? rawAttr.slice(0, rawAttr.indexOf(":"))
        : "";
      const aLocal = rawAttr.includes(":")
        ? rawAttr.slice(rawAttr.indexOf(":") + 1)
        : rawAttr;
      let aNs = "";
      if (aPrefix !== "") {
        aNs = lookup(aPrefix, ownChain) ?? "";
      }
      attrList.push({ ns: aNs, name: aLocal, value });
      // The dialects only read unprefixed attributes (unitCode,
      // schemeID, format, currencyID…) — store those by local name.
      if (aPrefix === "") attrs[aLocal] = value;
    }

    const node: XmlNode = { ns, name: local, attrs, attrList, children: [], text: "" };
    if (parent !== undefined) parent.children.push(node);
    else {
      if (root !== null) fail(); // two root elements
      root = node;
    }

    if (!selfClosing) {
      stack.push(node);
      openRaw.push(raw);
      scopes.push(scope);
    }
  }

  if (stack.length > 0) fail(); // unclosed elements
  if (root === null) fail(); // no root element at all
  return root;
}
