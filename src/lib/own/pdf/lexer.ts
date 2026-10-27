/**
 * DocoPDF own PDF micro-engine — lexer (P6-a). Byte-level tokenizer per
 * PDF 32000-1:2008 §7 (lexical conventions). Own implementation, zero deps.
 *
 * Handles: whitespace variants (NUL TAB LF FF CR SP), comments, integers &
 * reals (integer flag kept for "N G R" reference lookahead), literal strings
 * (balanced parens + all §7.3.4.2 escapes incl. octal and backslash-EOL
 * continuation), hex strings (ws inside, odd-nibble pad), names (#xx
 * unescaped, Latin-1 byte semantics), << >> dicts, [ ] arrays, keywords
 * (obj/endobj/stream/endstream/xref/trailer/startxref/R/true/false/null).
 */

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([
  0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25,
]);

export type Token =
  | { t: "num"; n: number; isInt: boolean }
  | { t: "name"; v: string }
  | { t: "str"; b: Uint8Array }
  | { t: "openArr" }
  | { t: "closeArr" }
  | { t: "openDict" }
  | { t: "closeDict" }
  | { t: "kw"; v: string }
  | { t: "eof" };

export class PdfSyntaxError extends Error {
  constructor(message: string, public readonly pos: number) {
    super(`${message} (at byte ${pos})`);
    this.name = "PdfSyntaxError";
  }
}

const KEYWORDS = new Set([
  "obj", "endobj", "stream", "endstream", "xref", "trailer", "startxref",
  "R", "true", "false", "null",
]);

export class Lexer {
  constructor(public readonly data: Uint8Array, public pos: number = 0) {}

  private at(i: number): number {
    return this.data[i] ?? -1;
  }

  /** Skip whitespace and %-comments (comments run to EOL and are ignored). */
  skipWsAndComments(): void {
    for (;;) {
      const c = this.at(this.pos);
      if (c === 0x25 /* % */) {
        while (this.pos < this.data.length) {
          const e = this.data[this.pos]!;
          if (e === 0x0a || e === 0x0d) break;
          this.pos++;
        }
        continue;
      }
      if (c >= 0 && WS.has(c)) {
        this.pos++;
        continue;
      }
      return;
    }
  }

  isEof(): boolean {
    this.skipWsAndComments();
    return this.pos >= this.data.length;
  }

  readToken(): Token {
    this.skipWsAndComments();
    const start = this.pos;
    if (start >= this.data.length) return { t: "eof" };
    const c = this.at(start);

    // Dict delimiters first: << and >>
    if (c === 0x3c && this.at(start + 1) === 0x3c) {
      this.pos = start + 2;
      return { t: "openDict" };
    }
    if (c === 0x3e && this.at(start + 1) === 0x3e) {
      this.pos = start + 2;
      return { t: "closeDict" };
    }

    switch (c) {
      case 0x5b: this.pos++; return { t: "openArr" };  // [
      case 0x5d: this.pos++; return { t: "closeArr" }; // ]
      case 0x3c: this.pos++; return { t: "str", b: this.readHexString(start) };
      default:
        break;
    }

    if (c === 0x28 /* ( */) {
      this.pos++;
      return { t: "str", b: this.readLiteralString(start) };
    }

    if (c === 0x2f /* / */) {
      this.pos++;
      return { t: "name", v: this.readName() };
    }

    if (
      (c >= 0x30 && c <= 0x39) /* digit */ ||
      c === 0x2b /* + */ || c === 0x2d /* - */ || c === 0x2e /* . */
    ) {
      return this.readNumber();
    }

    // Keyword: [A-Za-z]+ run ('R' included; spec keywords are pure alpha).
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) {
      let end = start;
      while (end < this.data.length) {
        const w = this.data[end]!;
        const isAlpha = (w >= 0x41 && w <= 0x5a) || (w >= 0x61 && w <= 0x7a);
        if (!isAlpha) break;
        end++;
      }
      const word = latin1(this.data, start, end);
      this.pos = end;
      if (KEYWORDS.has(word)) return { t: "kw", v: word };
      throw new PdfSyntaxError(`unknown keyword "${word}"`, start);
    }

    throw new PdfSyntaxError(`unexpected byte 0x${c.toString(16)}`, start);
  }

  /** Spec §7.3.4.2 literal string: nesting + escapes; result = raw bytes. */
  private readLiteralString(start: number): Uint8Array {
    const out: number[] = [];
    let depth = 1;
    while (this.pos < this.data.length) {
      const c = this.data[this.pos]!;
      if (c === 0x28 /* ( */) {
        depth++;
        out.push(c);
        this.pos++;
        continue;
      }
      if (c === 0x29 /* ) */) {
        depth--;
        if (depth === 0) {
          this.pos++;
          return Uint8Array.from(out);
        }
        out.push(c);
        this.pos++;
        continue;
      }
      if (c === 0x5c /* \ */) {
        this.pos++;
        const e = this.at(this.pos);
        switch (e) {
          case 0x6e: out.push(0x0a); this.pos++; break; // \n
          case 0x72: out.push(0x0d); this.pos++; break; // \r
          case 0x74: out.push(0x09); this.pos++; break; // \t
          case 0x62: out.push(0x08); this.pos++; break; // \b
          case 0x66: out.push(0x0c); this.pos++; break; // \f
          case 0x28: out.push(0x28); this.pos++; break; // \(
          case 0x29: out.push(0x29); this.pos++; break; // \)
          case 0x5c: out.push(0x5c); this.pos++; break; // \\
          case -1:
            throw new PdfSyntaxError("unterminated string escape", this.pos);
          case 0x0d: // backslash-EOL continuation (CRLF or CR)
            this.pos++;
            if (this.at(this.pos) === 0x0a) this.pos++;
            break;
          case 0x0a:
            this.pos++;
            break;
          default:
            if (e >= 0x30 && e <= 0x37) {
              // \ddd — up to 3 OCTAL digits (shortest-first is wrong; spec
              // says up to 3 digits, high-order overflow ignored → mask 0xff)
              let v = 0;
              let digits = 0;
              while (digits < 3) {
                const d = this.at(this.pos);
                if (d < 0x30 || d > 0x37) break;
                v = v * 8 + (d - 0x30);
                this.pos++;
                digits++;
              }
              out.push(v & 0xff);
            } else {
              // Unknown escape → the character itself (spec §7.3.4.2)
              out.push(e);
              this.pos++;
            }
        }
        continue;
      }
      out.push(c);
      this.pos++;
    }
    throw new PdfSyntaxError("unterminated literal string", start);
  }

  /** Hex string <...>: ws ignored, odd trailing nibble padded with 0. */
  private readHexString(start: number): Uint8Array {
    const nibbles: number[] = [];
    for (;;) {
      if (this.pos >= this.data.length) {
        throw new PdfSyntaxError("unterminated hex string", start);
      }
      const c = this.data[this.pos]!;
      if (c === 0x3e /* > */) {
        this.pos++;
        break;
      }
      const v = hexVal(c);
      if (v >= 0) nibbles.push(v);
      else if (!WS.has(c)) {
        throw new PdfSyntaxError(`invalid hex digit 0x${c.toString(16)}`, this.pos);
      }
      this.pos++;
    }
    const out = new Uint8Array(Math.ceil(nibbles.length / 2));
    for (let i = 0; i < nibbles.length; i += 2) {
      const hi = nibbles[i]!;
      const lo = i + 1 < nibbles.length ? nibbles[i + 1]! : 0;
      out[i >> 1] = (hi << 4) | lo;
    }
    return out;
  }

  /** Name after '/': regular chars + #xx (2 hex digits, byte semantics). */
  private readName(): string {
    const codes: number[] = [];
    for (;;) {
      const c = this.at(this.pos);
      if (c < 0) break;
      if (WS.has(c) || DELIM.has(c)) break;
      if (c === 0x23 /* # */) {
        const h = hexVal(this.at(this.pos + 1));
        const l = hexVal(this.at(this.pos + 2));
        if (h < 0 || l < 0) {
          // Spec says # must start a hex pair; tolerate literal # (rare).
          codes.push(c);
          this.pos++;
          continue;
        }
        codes.push((h << 4) | l);
        this.pos += 3;
        continue;
      }
      codes.push(c);
      this.pos++;
    }
    return String.fromCharCode(...codes);
  }

  /** Number: [+-]?digits[.digits] — isInt when no '.' present. */
  private readNumber(): Token {
    const start = this.pos;
    let isInt = true;
    if (this.at(this.pos) === 0x2b || this.at(this.pos) === 0x2d) this.pos++;
    for (;;) {
      const c = this.at(this.pos);
      if (c >= 0x30 && c <= 0x39) {
        this.pos++;
        continue;
      }
      if (c === 0x2e /* . */) {
        isInt = false;
        this.pos++;
        continue;
      }
      break;
    }
    if (this.pos === start) throw new PdfSyntaxError("empty number", start);
    const text = latin1(this.data, start, this.pos);
    const n = Number(text);
    if (!Number.isFinite(n)) throw new PdfSyntaxError(`bad number "${text}"`, start);
    return { t: "num", n, isInt };
  }

  /**
   * Read a stream body AFTER the "stream" keyword: one EOL, `length` raw
   * bytes, then "endstream". Falls back to scanning for the endstream
   * keyword when /Length lies (real-world files violate it).
   * Returns a subarray VIEW of the source bytes (no copy). On return this
   * pos sits just past the "endstream" keyword.
   */
  readStreamBody(length: number): Uint8Array {
    const afterKeyword = this.pos;
    // Exactly ONE EOL: CRLF | CR | LF (spec §7.3.8.1). Tolerate a missing
    // EOL (spec violation seen in the wild).
    if (this.at(this.pos) === 0x0d) {
      this.pos++;
      if (this.at(this.pos) === 0x0a) this.pos++;
    } else if (this.at(this.pos) === 0x0a) {
      this.pos++;
    }
    const bodyStart = this.pos;
    const strictEnd = bodyStart + length;
    if (
      length >= 0 &&
      strictEnd <= this.data.length &&
      this.matchEndstreamFrom(strictEnd)
    ) {
      return this.data.subarray(bodyStart, strictEnd);
    }
    // Fallback: scan for "endstream", trim at most ONE trailing EOL.
    const found = indexOfBytes(this.data, ENSTREAM, bodyStart);
    if (found < 0) {
      throw new PdfSyntaxError("endstream not found", afterKeyword);
    }
    let end = found;
    if (end > bodyStart && this.data[end - 1] === 0x0a) end--;
    if (end > bodyStart && this.data[end - 1] === 0x0d) end--;
    this.pos = found + ENSTREAM.length;
    return this.data.subarray(bodyStart, end);
  }

  /** From `pos`: skip ws/comments, then require the literal "endstream".
   *  On success leaves this.pos just past it; on failure restores pos. */
  private matchEndstreamFrom(pos: number): boolean {
    const save = this.pos;
    this.pos = pos;
    try {
      this.skipWsAndComments();
      if (this.pos + ENSTREAM.length > this.data.length) {
        this.pos = save;
        return false;
      }
      for (let i = 0; i < ENSTREAM.length; i++) {
        if (this.data[this.pos + i] !== ENSTREAM[i]) {
          this.pos = save;
          return false;
        }
      }
      this.pos += ENSTREAM.length;
      return true;
    } catch {
      this.pos = save;
      return false;
    }
  }

  /** Read the bytes between current pos and `to` (used by ObjStm pairing). */
  slice(from: number, to: number): Uint8Array {
    return this.data.subarray(from, Math.min(to, this.data.length));
  }
}

const ENSTREAM = new TextEncoder().encode("endstream");

function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from: number): number {
  if (needle.length === 0) return from;
  outer: for (let i = Math.max(0, from); i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export function hexVal(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return -1;
}

export function latin1(data: Uint8Array, from: number, to: number): string {
  let s = "";
  for (let i = from; i < to; i++) s += String.fromCharCode(data[i]!);
  return s;
}

/** Locate "N G obj" headers by brute scan (broken-xref recovery mode). */
export function scanObjectHeaders(data: Uint8Array): Array<{ num: number; gen: number; offset: number }> {
  const found: Array<{ num: number; gen: number; offset: number }> = [];
  const seen = new Set<number>();
  const digits = (i: number, max: number): [number, number] => {
    let v = 0;
    let used = 0;
    while (used < max) {
      const c = data[i + used];
      if (c === undefined || c < 0x30 || c > 0x39) break;
      v = v * 10 + (c - 0x30);
      used++;
    }
    return [v, used];
  };
  const wsAt = (i: number): number => {
    let n = 0;
    while (i + n < data.length && WS.has(data[i + n]!)) n++;
    return n;
  };
  for (let i = 0; i < data.length - 8; i++) {
    if (data[i] === 0x20 || data[i] === 0x0a || data[i] === 0x0d || i === 0) {
      // Only start matches at a token boundary (after ws/EOL).
      const [numV, numLen] = digits(i === 0 ? i : i + 1, 10);
      if (numLen === 0) continue;
      let p = (i === 0 ? i : i + 1) + numLen;
      p += wsAt(p);
      if (p === (i === 0 ? i : i + 1) + numLen) continue;
      const [genV, genLen] = digits(p, 6);
      if (genLen === 0) continue;
      p += genLen;
      p += wsAt(p);
      if (
        data[p] === 0x6f /* o */ && data[p + 1] === 0x62 /* b */ &&
        data[p + 2] === 0x6a /* j */ &&
        WS.has(data[p + 3] ?? 0x20)
      ) {
        if (!seen.has(numV)) {
          seen.add(numV);
          found.push({ num: numV, gen: genV, offset: i === 0 ? i : i + 1 });
        }
      }
    }
  }
  return found;
}
