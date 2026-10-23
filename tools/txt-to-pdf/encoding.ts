/**
 * CP1252/Latin-1 recovery for mis-sniffed text files (ENH-1).
 *
 * readTextFile (engine.ts) decodes every file as UTF-8 with a TOLERANT
 * decoder, so a single-byte Western file — Windows-1252 Notepad export,
 * Latin-1 email dump — slips past the binary sniff whenever fewer than
 * 10% of the first 4 KB's characters decode to U+FFFD, and exports with
 * replacement-char mojibake where the accents used to be.
 *
 * The switch to windows-1252 fires ONLY when the evidence is strong,
 * i.e. ALL of the following hold:
 *
 *  1. the tolerant UTF-8 decode actually produced replacement chars
 *     (the visible mojibake — nothing to fix otherwise), and
 *  2. the raw bytes contain NO valid multi-byte UTF-8 sequence. A real
 *     UTF-8 file with ANY non-ASCII text always carries one (é = C3 A9,
 *     हिंदी = E0 A4 BF …), so their absence is the fingerprint of a
 *     single-byte encoding, and
 *  3. the windows-1252 re-decode STRICTLY reduces the replacement count.
 *     A WHATWG windows-1252 decode never emits U+FFFD — even the five
 *     bytes CP1252 leaves undefined (0x81 0x8D 0x8F 0x90 0x9D) are
 *     best-fitted to their C1 control characters — so a Western file
 *     always comes back cleaner, while any re-decode that is NOT
 *     cleaner (exotic runtime behaviour) keeps the UTF-8 reading.
 *
 * Deliberately NOT a trigger: "Ã©"/"â€"-style double-encoded text. Those
 * patterns mean the bytes are valid UTF-8 of already-mojibake text
 * (é → C3 83 C2 A9) — rule 2 correctly leaves them alone, and re-reading
 * the raw bytes as CP1252 would only make them worse. Symmetrically, a
 * CP1252 file that literally contains the bytes C3 A9 already renders
 * "é" under the UTF-8 decode — nothing to fix there either.
 *
 * Pure module — no imports, so scripts/smoke-txt2pdf.ts can drive every
 * rule headlessly.
 */

/** Counts U+FFFD replacement characters in a decoded string. */
export function countReplacementChars(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 0xfffd) count += 1;
  }
  return count;
}

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x80 && byte <= 0xbf;
}

/**
 * True when the bytes contain at least one VALID multi-byte UTF-8
 * sequence (2–4 bytes, overlong / surrogate / > U+10FFFF forms rejected)
 * — the "this file really is UTF-8" fingerprint. Early-exits on the
 * first hit.
 */
export function hasValidUtf8MultibyteSequence(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i += 1) {
    const lead = bytes[i];
    if (lead < 0xc2 || lead > 0xf4) continue; // ASCII / invalid lead
    if (lead <= 0xdf) {
      // 2-byte: C2..DF + continuation
      if (isContinuation(bytes[i + 1])) return true;
      continue;
    }
    if (lead <= 0xef) {
      // 3-byte: E0..EF + two continuations (no overlong E0 80..9F,
      // no surrogate ED A0..BF)
      const second = bytes[i + 1];
      const third = bytes[i + 2];
      if (!isContinuation(second) || !isContinuation(third)) continue;
      if (lead === 0xe0 && second < 0xa0) continue;
      if (lead === 0xed && second > 0x9f) continue;
      return true;
    }
    // 4-byte: F0..F4 + three continuations (no overlong F0 80..8F,
    // nothing above F4 8F — > U+10FFFF)
    const second = bytes[i + 1];
    const third = bytes[i + 2];
    const fourth = bytes[i + 3];
    if (
      !isContinuation(second) ||
      !isContinuation(third) ||
      !isContinuation(fourth)
    ) {
      continue;
    }
    if (lead === 0xf0 && second < 0x90) continue;
    if (lead === 0xf4 && second > 0x8f) continue;
    return true;
  }
  return false;
}

let cp1252Decoder: TextDecoder | null = null;

/** windows-1252 decode, or null when the runtime lacks the table. */
export function decodeWindows1252(bytes: Uint8Array): string | null {
  try {
    cp1252Decoder ??= new TextDecoder("windows-1252");
    return cp1252Decoder.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Re-decodes a mis-sniffed single-byte Western file as windows-1252 —
 * or hands the UTF-8 text back unchanged when the evidence isn't strong
 * (see the module header for the three rules).
 */
export function recoverCp1252Text(
  bytes: Uint8Array,
  utf8Text: string
): string {
  const utf8Replacements = countReplacementChars(utf8Text);
  if (utf8Replacements === 0) return utf8Text; // nothing to recover
  if (hasValidUtf8MultibyteSequence(bytes)) return utf8Text; // real UTF-8
  const cp1252 = decodeWindows1252(bytes);
  if (cp1252 === null) return utf8Text;
  // Only switch when the re-decode is genuinely cleaner.
  return countReplacementChars(cp1252) < utf8Replacements ? cp1252 : utf8Text;
}
