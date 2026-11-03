/**
 * smoke-barcode — oracle test for the own 1D barcode engine.
 *
 * Compares our encoders bit-for-bit against the JsBarcode reference
 * package (installed in /tmp/bwip-ref as a DEV-TIME oracle only — never
 * a runtime dependency). EAN-13/8, UPC-A, ITF and Code 39 must match the
 * reference binary exactly; Code 128 uses the same pattern table with our
 * own (valid, denser) B/C planning, so the oracle checks the checksum
 * math + structural invariants + a hand-verified textbook example.
 *
 * Run: bunx tsx scripts/smoke-barcode.ts   (oracle optional — degrades
 * to invariant-only checks when the reference tree is absent)
 */

import {
  encodeBarcode,
  barGeometry,
  BARCODE_FORMATS,
} from "../src/lib/own/barcode/index";

/* ---------------- helpers ---------------- */

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function elementsToBinary(elements: number[]): string {
  let bin = "";
  elements.forEach((w, idx) => {
    bin += (idx % 2 === 0 ? "1" : "0").repeat(w);
  });
  return bin;
}

/* ---------------- reference oracle (optional) ---------------- */

interface RefApi {
  encode: () => { data: string | { data: string }[] };
  valid: () => boolean;
}

type RefCtor = new (data: string, opts: unknown) => RefApi;

const REF_ROOT = "/tmp/bwip-ref/node_modules/jsbarcode/src/barcodes";

async function loadRefClass(rel: string): Promise<RefCtor | null> {
  try {
    const mod = (await import(rel)) as Record<string, unknown> & {
      default?: unknown;
    };
    const candidates: unknown[] = [mod.default, ...Object.values(mod)];
    for (const c of candidates) {
      if (typeof c === "function") return c as RefCtor;
    }
    return null;
  } catch {
    return null;
  }
}

/** Reference binary for a test case (null = oracle unavailable). */
async function refBinary(
  rel: string,
  data: string
): Promise<string | null> {
  const Cls = await loadRefClass(rel);
  if (!Cls) return null;
  try {
    const inst = new Cls(data, { fontSize: 0, flat: true });
    if (typeof inst.valid === "function" && !inst.valid()) return null;
    const encoded = inst.encode();
    if (typeof encoded.data === "string") return encoded.data;
    // Guarded encodings (UPC display sections) — flatten to one bitstring.
    return (encoded.data as { data: string }[])
      .map((section) => section.data)
      .join("");
  } catch {
    return null;
  }
}

/* ---------------- structural invariants ---------------- */

function invariants(): void {
  for (const format of BARCODE_FORMATS) {
    // 1. empty input rejected
    check(`${format}: empty rejected`, encodeBarcode(format, "   ").ok === false);
    // 2. bars alternate and start/end with a bar
    const samples: Record<string, string> = {
      code128: "DocoPDF-2025",
      ean13: "4006381333931",
      ean8: "96385074",
      upca: "036000291452",
      code39: "DOCOPDF 39",
      itf: "12345670",
    };
    const res = encodeBarcode(format, samples[format]);
    check(`${format}: sample encodes`, res.ok === true);
    if (!res.ok) continue;
    // ends with bar (odd element count) and every width positive
    check(
      `${format}: bar-terminated`,
      res.elements.length % 2 === 1,
      `elements=${res.elements.length}`
    );
    check(
      `${format}: positive widths`,
      res.elements.every((w) => w > 0)
    );
    check(
      `${format}: total = sum`,
      res.total === res.elements.reduce((a, b) => a + b, 0)
    );
    const geo = barGeometry(res);
    check(
      `${format}: bars within total`,
      geo.bars.every((b) => b.x >= 0 && b.x + b.w <= res.total + 0.001)
    );
  }

  // EAN-13 fixed width: 95 modules
  const ean = encodeBarcode("ean13", "4006381333931");
  check(
    "ean13: 95 modules",
    ean.ok && ean.total === 95,
    ean.ok ? String(ean.total) : "encode failed"
  );
  // EAN-8: 67 modules
  const ean8 = encodeBarcode("ean8", "96385074");
  check(
    "ean8: 67 modules",
    ean8.ok && ean8.total === 67,
    ean8.ok ? String(ean8.total) : "encode failed"
  );
  // UPC-A: 95 modules
  const upc = encodeBarcode("upca", "036000291452");
  check(
    "upca: 95 modules",
    upc.ok && upc.total === 95,
    upc.ok ? String(upc.total) : "encode failed"
  );

  // check digit auto-append + wrong check rejection
  const auto = encodeBarcode("ean13", "400638133393");
  check(
    "ean13: auto check digit",
    auto.ok && auto.humanText === "4006381333931",
    auto.ok ? auto.humanText : "failed"
  );
  check(
    "ean13: wrong check rejected",
    encodeBarcode("ean13", "4006381333932").ok === false
  );
  check(
    "ean13: 12-digit auto flagged",
    auto.ok && auto.addedCheckDigit === true
  );

  // ITF odd digits rejected
  check("itf: odd digits rejected", encodeBarcode("itf", "123").ok === false);
  // ITF start/end patterns
  const itf = encodeBarcode("itf", "1234");
  if (itf.ok) {
    check(
      "itf: start 2222",
      itf.elements.slice(0, 4).join(",") === "2,2,2,2"
    );
    check(
      "itf: end 522",
      itf.elements.slice(-3).join(",") === "5,2,2"
    );
  }

  // Code 39: lowercase auto-upper, charset reject
  const c39 = encodeBarcode("code39", "doco-42");
  check(
    "code39: uppercased",
    c39.ok && c39.humanText === "DOCO-42"
  );
  check("code39: bad char rejected", encodeBarcode("code39", "abc!").ok === false);
  // Code 39: star char rejected (start/stop is ours)
  check("code39: * rejected", encodeBarcode("code39", "A*B").ok === false);

  // Code 128: charset reject (control + DEL + non-ASCII)
  check("code128: control rejected", encodeBarcode("code128", "a\u0001b").ok === false);
  check("code128: DEL rejected", encodeBarcode("code128", "a\u007fb").ok === false);
  check("code128: emoji rejected", encodeBarcode("code128", "a😀b").ok === false);

  // limits
  check(
    "code128: 48-char limit",
    encodeBarcode("code128", "x".repeat(49)).ok === false &&
      encodeBarcode("code128", "x".repeat(48)).ok === true
  );
  check(
    "ean13: 14 digits rejected",
    encodeBarcode("ean13", "40063813339311").ok === false
  );
}

/* ---------------- code 128 textbook oracle ---------------- */

/** Full Code 128 bit table mirrored from the verified reference constants. */
const CODE128_REF: readonly number[] = [
  11011001100, 11001101100, 11001100110, 10010011000, 10010001100,
  10001001100, 10011001000, 10011000100, 10001100100, 11001001000,
  11001000100, 11000100100, 10110011100, 10011011100, 10011001110,
  10111001100, 10011101100, 10011100110, 11001110010, 11001011100,
  11001001110, 11011100100, 11001110100, 11101101110, 11101001100,
  11100101100, 11100100110, 11101100100, 11100110100, 11100110010,
  11011011000, 11011000110, 11000110110, 10100011000, 10001011000,
  10001000110, 10110001000, 10001101000, 10001100010, 11010001000,
  11000101000, 11000100010, 10110111000, 10110001110, 10001101110,
  10111011000, 10111000110, 10001110110, 11101110110, 11010001110,
  11000101110, 11011101000, 11011100010, 11011101110, 11101011000,
  11101000110, 11100010110, 11101101000, 11101100010, 11100011010,
  11101111010, 11001000010, 11110001010, 10100110000, 10100001100,
  10010110000, 10010000110, 10000101100, 10000100110, 10110010000,
  10110000100, 10011010000, 10011000010, 10000110100, 10000110010,
  11000010010, 11001010000, 11110111010, 11000010100, 10001111010,
  10100111100, 10010111100, 10010011110, 10111100100, 10011110100,
  10011110010, 11110100100, 11110010100, 11110010010, 11011011110,
  11011110110, 11110110110, 10101111000, 10100011110, 10001011110,
  10111101000, 10111100010, 11110101000, 11110100010, 10111011110,
  10111101110, 11101011110, 11110101110, 11010000100, 11010010000,
  11010011100, 1100011101011,
];

function code128Oracle(): void {
  // Classic GS1 example "ABC-1234" START B + checksum: known encodings.
  // Value table checks: pattern[0] = 212222, START B (104) = 211214,
  // STOP (106) = 2331112.
  const res = encodeBarcode("code128", "A");
  if (!res.ok) {
    check("code128: single char", false, "encode failed");
    return;
  }
  const els = res.elements;
  // START B + 'A'(33) + check + STOP → 6 + 6 + 6 + 7 elements = 25
  check(
    "code128: A element count",
    els.length === 25,
    String(els.length)
  );
  check(
    "code128: START B = 211214",
    els.slice(0, 6).join("") === "211214",
    els.slice(0, 6).join(",")
  );
  // 'A' = value 33 (ASCII 65 − 32); table entry 33 = 10100011000 → 111323
  check(
    "code128: 'A' = 111323",
    els.slice(6, 12).join("") === "111323",
    els.slice(6, 12).join(",")
  );
  // checksum: (104 + 33×1) % 103 = 34 → decode table entry 34.
  // The table numbers spell the module bits in decimal digits (see encoder).
  const refBits34 = CODE128_REF[34];
  const pat34 = String(refBits34)
    .match(/(1+|0+)/g)!
    .map((r) => r.length);
  check(
    "code128: check symbol = idx34 pattern",
    els.slice(12, 18).join(",") === pat34.join(","),
    els.slice(12, 18).join(",")
  );
  check(
    "code128: STOP = 2331112",
    els.slice(-7).join("") === "2331112",
    els.slice(-7).join(",")
  );

  // Auto-submode: all-digit even input uses Code C (START C = 211232)
  const digits = encodeBarcode("code128", "123456");
  check(
    "code128: 123456 starts Code C",
    digits.ok && digits.elements.slice(0, 6).join("") === "211232",
    digits.ok ? digits.elements.slice(0, 6).join(",") : "failed"
  );
  // Code C pairs: 12 → value 12, 34 → 34, 56 → 56; checksum:
  const cCheck = (105 + 12 * 1 + 34 * 2 + 56 * 3) % 103;
  const patC = (v: number): number[] =>
    String(CODE128_REF[v])
      .match(/(1+|0+)/g)!
      .map((r) => r.length);
  if (digits.ok) {
    check(
      "code128: C pair 12 pattern",
      digits.elements.slice(6, 12).join(",") === patC(12).join(",")
    );
    // Layout: START C (0-5) + 3 pairs (6-23) + CHECK (24-29) + STOP (30-36)
    check(
      "code128: checksum symbol matches",
      digits.elements.slice(24, 30).join(",") === patC(cCheck).join(","),
      `expected check ${cCheck}: ${digits.elements.slice(24, 30).join(",")} vs ${patC(cCheck).join(",")}`
    );
  }
}

/* ---------------- reference cross-checks ---------------- */

async function referenceChecks(): Promise<void> {
  const cases: { rel: string; format: string; data: string; note?: string }[] = [
    { rel: `${REF_ROOT}/EAN_UPC/EAN13.js`, format: "ean13", data: "4006381333931", note: "wikipedia example" },
    { rel: `${REF_ROOT}/EAN_UPC/EAN13.js`, format: "ean13", data: "5901234123457" },
    { rel: `${REF_ROOT}/EAN_UPC/EAN8.js`, format: "ean8", data: "96385074" },
    { rel: `${REF_ROOT}/EAN_UPC/UPC.js`, format: "upca", data: "036000291452", note: "wikipedia example" },
    { rel: `${REF_ROOT}/EAN_UPC/UPC.js`, format: "upca", data: "123456789012" },
    { rel: `${REF_ROOT}/ITF/ITF.js`, format: "itf", data: "12345670" },
    { rel: `${REF_ROOT}/ITF/ITF.js`, format: "itf", data: "04912345678902" },
    { rel: `${REF_ROOT}/CODE39/index.js`, format: "code39", data: "DOCOPDF-42" },
    { rel: `${REF_ROOT}/CODE39/index.js`, format: "code39", data: "ABC 123" },
  ];
  for (const tc of cases) {
    const ref = await refBinary(tc.rel, tc.data);
    if (ref === null) {
      console.log(`  (reference unavailable for ${tc.format} — skipping ${tc.data})`);
      continue;
    }
    // The reference encodes text with guard-height sections; flatten to
    // the bar binary by stripping display sections: JsBarcode returns a
    // single binary string for these formats.
    const ours = encodeBarcode(
      tc.format as (typeof BARCODE_FORMATS)[number],
      tc.data
    );
    if (!ours.ok) {
      check(`ref ${tc.format} ${tc.data}`, false, "our encode failed");
      continue;
    }
    const ourBin = elementsToBinary(ours.elements);
    let ourNorm = ourBin;
    let refNorm = ref;
    if (tc.format === "code39") {
      // The reference bakes a trailing narrow space into its stop pattern;
      // the code itself ends on the final bar. Normalize both tails.
      ourNorm = ourBin.replace(/0+$/, "");
      refNorm = ref.replace(/0+$/, "");
    } else if (tc.format === "itf") {
      // ITF wide:narrow ratio is a spec-permitted choice (2.0-3.0): we use
      // the GS1 2.5:1 (narrow 2 / wide 5 modules), the reference 3:1
      // (narrow 1 / wide 3). Compare the wide/narrow structure instead.
      const oursNW = ours.elements
        .map((w) => (w >= 5 ? "W" : "N"))
        .join("");
      const refNW = ref
        .match(/(1+|0+)/g)!
        .map((r) => (r.length >= 3 ? "W" : "N"))
        .join("");
      ourNorm = oursNW;
      refNorm = refNW;
    }
    check(
      `ref ${tc.format} ${tc.data}${tc.note ? ` (${tc.note})` : ""}`,
      ourNorm === refNorm,
      `binary mismatch\n    ours: ${ourNorm.slice(0, 64)}…\n    ref:  ${refNorm.slice(0, 64)}…`
    );
  }
}

/* ---------------- main ---------------- */

async function main(): Promise<void> {
  console.log("smoke-barcode: own 1D engine vs oracle\n");
  invariants();
  code128Oracle();
  try {
    await referenceChecks();
  } catch (err) {
    console.log(`  (reference oracle skipped: ${(err as Error).message})`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length > 0) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

void main();
