/**
 * P9 batch 3 smoke: validate-pdfa check logic + webpage-to-pdf helpers.
 * Run: bun scripts/smoke-p9-d4.ts
 */
import {
  countAll,
  renderReport,
  toLatin1,
  validateFile,
} from "../tools/validate-pdfa/checks";

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, extra = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

console.log("validate-pdfa checks");

// ---- toLatin1 round-trip ----
const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0xe9]);
check("toLatin1 decodes", toLatin1(bytes) === "%PDF-\u00e9");

// ---- countAll ----
check("countAll non-overlapping", countAll("ababab", "ab") === 3);
check("countAll zero", countAll("xyz", "ab") === 0);

// ---- A passing PDF/A-2B (Ghostscript style raw layout, no ObjStm) ----
const pdfa2b =
  "%PDF-1.7\n" +
  "1 0 obj\n<< /Type /Catalog /Pages 2 0 R /OutputIntents [<< /S /GTS_PDFA1 /OutputConditionIdentifier (sRGB) >>] >>\nendobj\n" +
  "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
  "3 0 obj\n<< /Type /Font /BaseFont /ABCDEF+Something /FontDescriptor 4 0 R >>\nendobj\n" +
  "4 0 obj\n<< /FontFile2 5 0 R >>\nendobj\n" +
  "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n123\n%%EOF";
const xmp2b =
  '<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/">' +
  "<rdf:RDF></rdf:RDF>" +
  '<pdfaid xmlns="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="2" pdfaid:conformance="B"/>' +
  "</x:xmpmeta><?xpacket end=\"w\"?>";
const v1 = validateFile(pdfa2b, 3, xmp2b, "1.7");
check("marker identifies PDF/A-2B", v1.pdfaLevel === "PDF/A-2B");
const byName = new Map(v1.checks.map((c) => [c.name, c]));
check("XMP pass", byName.get("XMP metadata packet")?.status === "pass");
check("identification pass", byName.get("PDF/A identification")?.status === "pass");
check("version pass (1.7 / part 2)", byName.get("PDF version compatibility")?.status === "pass");
check("encryption pass", byName.get("Encryption")?.status === "pass");
check("output intent pass", byName.get("Output intent")?.status === "pass");
check("fonts pass (FontFile2 present)", byName.get("Embedded fonts")?.status === "pass");
check("pages pass", byName.get("Page tree")?.status === "pass");
check("no failures", v1.failed === 0, `failed=${v1.failed}`);
check("report verdict line", renderReport("f.pdf", v1).includes("PDF/A-2B — all browser-visible checks passed"));
check("report hindi block", renderReport("f.pdf", v1).includes("हिंदी निष्कर्ष"));
check("report honest scope", renderReport("f.pdf", v1).includes("not a full ISO 19005"));

// ---- A normal (non-PDF/A) PDF ----
const plain = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF";
const v2 = validateFile(plain, 1, null, null);
check("no marker → empty level", v2.pdfaLevel === "");
check("identification fail", v2.checks.find((c) => c.name === "PDF/A identification")?.status === "fail");
check("XMP fail (no packet)", v2.checks.find((c) => c.name === "XMP metadata packet")?.status === "fail");
check("output intent fail", v2.checks.find((c) => c.name === "Output intent")?.status === "fail");
check("not-pdfa report", renderReport("f.pdf", v2).includes("Does not identify as PDF/A"));

// ---- PDF/A-1 with 1.7 header (version mismatch → warn) ----
const xmp1 =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><pdfaid:part>1</pdfaid:part><pdfaid:conformance>A</pdfaid:conformance></x:xmpmeta>';
const v3 = validateFile(pdfa2b, 1, xmp1, "1.7");
check("part1 identifies PDF/A-1A", v3.pdfaLevel === "PDF/A-1A");
check("version mismatch warns", v3.checks.find((c) => c.name === "PDF version compatibility")?.status === "warn");
check("warnings counted", v3.warnings >= 1);

// ---- Encrypted "PDF/A" → marker pass but encryption fail ----
const encrypted = pdfa2b.replace("/Size 6", "/Encrypt 9 0 R /Size 6");
const v4 = validateFile(encrypted, 1, xmp2b, "1.7");
check("encryption detected", v4.checks.find((c) => c.name === "Encryption")?.status === "fail");
check("failed counted", v4.failed === 1);
check("issues report line", renderReport("f.pdf", v4).includes("1 check(s) failed"));

// ---- Object streams: hidden things degrade to warn/info ----
const hidden = "%PDF-1.7\n…/ObjStm…";
const v5 = validateFile(hidden, 2, xmp2b, "1.7");
check("output intent undetermined", v5.checks.find((c) => c.name === "Output intent")?.status === "warn");
check("objstm info note", v5.checks.some((c) => c.name === "Object streams" && c.status === "info"));

// ---- Fonts: dictionaries but no programs → fail (no ObjStm) ----
const noFonts = pdfa2b.replace("<< /FontFile2 5 0 R >>", "<< /StemV 80 >>");
const v6 = validateFile(noFonts, 1, xmp2b, "1.7");
check("unembedded fonts fail", v6.checks.find((c) => c.name === "Embedded fonts")?.status === "fail");

// ---- pdfaid:part as element text (Ghostscript element form) ----
const xmpElem =
  '<x:xmpmeta><rdf:RDF><rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">' +
  "<pdfaid:part>3</pdfaid:part><pdfaid:conformance>U</pdfaid:conformance></rdf:Description></rdf:RDF></x:xmpmeta>";
const v7 = validateFile(pdfa2b, 1, xmpElem, "1.7");
check("element-form marker PDF/A-3U", v7.pdfaLevel === "PDF/A-3U");

// ---- PDF/UA flavour key seen in the wild: no conformance → fail ----
const xmpNoConf = xmp2b.replace('pdfaid:conformance="B"', "");
const v8 = validateFile(pdfa2b, 1, xmpNoConf, "1.7");
check("missing conformance → not identified", v8.pdfaLevel === "");

/* ---------------- webpage-to-pdf helpers ---------------- */
console.log("webpage-to-pdf helpers");

// The helper is inside surface.tsx (React, not importable here) — mirror
// its exact algorithm to lock the contract.
function domainFileName(url: URL): string {
  const host = url.hostname.replace(/^www\./, "");
  const safe = host.replace(/[^a-z0-9.-]+/gi, "-").replace(/^-+|-+$/g, "");
  return safe.length > 0 ? safe.slice(0, 80) : "webpage";
}
check("domain basic", domainFileName(new URL("https://example.com/path")) === "example.com");
check("www stripped", domainFileName(new URL("https://www.bbc.co.uk/news")) === "bbc.co.uk");
check("punycode-ish safe", domainFileName(new URL("https://xn--bcher-kva.example")) === "xn--bcher-kva.example");
check("underscores dashed", domainFileName(new URL("https://my_site.io")) === "my-site.io");
check("trailing dash trimmed", !domainFileName(new URL("https://_a.io")).startsWith("-") && domainFileName(new URL("https://_a.io")) === "a.io");

// Normalization contract (mirrors surface useMemo).
function normalize(input: string): URL | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    return null;
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}
check("adds https", normalize("example.com/x")?.href === "https://example.com/x");
check("keeps http", normalize("http://example.com")?.protocol === "http:");
check("rejects ftp", normalize("ftp://example.com") === null);
check("rejects junk", normalize("not a url at all") === null);
check("empty null", normalize("   ") === null);

/* ------------------------- summary ------------------------- */
console.log(`\n${pass} passed, ${fail} failed (of ${pass + fail})`);
if (fail > 0) process.exit(1);
