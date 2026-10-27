/**
 * PDF/A structural checks (validate-pdfa, P9 batch 3) — pure logic
 * extracted so the smoke test runs in Node/Bun. The worker
 * (worker.ts) feeds raw latin-1 bytes + pdf.js metadata in and gets
 * checks + verdict + report out.
 *
 * Honest scope everywhere: a browser can only SEE so much of a PDF.
 * Compressed object streams hide dictionaries → those checks degrade
 * to "warn (undetermined)", never a silent pass.
 */

export type CheckStatus = "pass" | "warn" | "fail" | "info";

export interface CheckLine {
  name: string;
  status: CheckStatus;
  note: string;
}

export interface Verdict {
  checks: CheckLine[];
  /** "PDF/A-2B" when identified, "" when not. */
  pdfaLevel: string;
  failed: number;
  warnings: number;
}

/** Latin-1 decode in 64 KB slices (String.fromCharCode stack limits). */
export function toLatin1(bytes: Uint8Array): string {
  const CHUNK = 65536;
  let out = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

export function countAll(hay: string, needle: string): number {
  let n = 0;
  let at = hay.indexOf(needle);
  while (at !== -1) {
    n += 1;
    at = hay.indexOf(needle, at + needle.length);
  }
  return n;
}

export function validateFile(
  raw: string,
  numPages: number,
  xmp: string | null,
  pdfVersion: string | null
): Verdict {
  const checks: CheckLine[] = [];
  let failed = 0;
  let warnings = 0;

  const add = (name: string, status: CheckStatus, note: string) => {
    checks.push({ name, status, note });
    if (status === "fail") failed += 1;
    if (status === "warn") warnings += 1;
  };

  const hasObjStm = raw.includes("/ObjStm");

  /* 1 — XMP packet */
  if (xmp !== null && xmp.includes("x:xmpmeta")) {
    add("XMP metadata packet", "pass", "embedded XMP packet found");
  } else if (raw.includes("<?xpacket")) {
    add("XMP metadata packet", "pass", "XMP packet bytes found");
  } else {
    add("XMP metadata packet", "fail", "no XMP packet — PDF/A requires one");
  }

  /* 2 — pdfaid marker */
  const part = xmp?.match(/pdfaid:part[^0-9]{0,6}([1-4])/)?.[1];
  const conformance =
    xmp
      ?.match(/pdfaid:conformance[^A-Za-z]{0,6}([ABU])/i)?.[1]
      ?.toUpperCase() ?? null;
  let pdfaLevel = "";
  if (part && conformance) {
    pdfaLevel = `PDF/A-${part}${conformance}`;
    add(
      "PDF/A identification",
      "pass",
      `XMP declares ${pdfaLevel} (pdfaid:part=${part}, conformance=${conformance})`
    );
  } else {
    add(
      "PDF/A identification",
      "fail",
      "no pdfaid:part/conformance marker — this file does not identify as PDF/A"
    );
  }

  /* 3 — version compatibility */
  const header = raw.match(/^%PDF-(\d\.\d)/);
  const version = pdfVersion ?? header?.[1] ?? null;
  if (version && part) {
    const v = Number(version);
    const ok = part === "1" ? v <= 1.4 : v >= 1.4;
    add(
      "PDF version compatibility",
      ok ? "pass" : "warn",
      `header says PDF ${version}${ok ? "" : `; PDF/A-${part} expects ${part === "1" ? "1.4" : "1.7"}`}`
    );
  } else if (version) {
    add("PDF version", "info", `header says PDF ${version}`);
  }

  /* 4 — encryption */
  const encryptEntry = raw.includes("/Encrypt");
  add(
    "Encryption",
    encryptEntry ? "fail" : "pass",
    encryptEntry
      ? "/Encrypt dictionary present — PDF/A forbids encryption"
      : "no encryption dictionary found"
  );

  /* 5 — OutputIntent */
  if (raw.includes("/OutputIntents")) {
    add("Output intent", "pass", "OutputIntent dictionary present");
  } else if (hasObjStm) {
    add(
      "Output intent",
      "warn",
      "not visible — catalog may hide inside object streams"
    );
  } else {
    add(
      "Output intent",
      "fail",
      "no OutputIntent — PDF/A requires a device-independent output intent"
    );
  }

  /* 6 — embedded fonts */
  const fontPrograms =
    countAll(raw, "/FontFile2") +
    countAll(raw, "/FontFile3") +
    countAll(raw, "/FontFile ") +
    (countAll(raw, "/FontFile\n") + countAll(raw, "/FontFile\r") + countAll(raw, "/FontFile/"));
  const fontDicts = countAll(raw, "/Type/Font") + countAll(raw, "/Type /Font");
  if (fontPrograms > 0) {
    add(
      "Embedded fonts",
      hasObjStm ? "warn" : "pass",
      `${fontPrograms} embedded font program(s) visible${hasObjStm ? " (object streams may hide more)" : ""}`
    );
  } else if (fontDicts > 0) {
    add(
      "Embedded fonts",
      hasObjStm ? "warn" : "fail",
      "font dictionaries exist but no embedded font programs are visible"
    );
  } else {
    add("Embedded fonts", "warn", "no fonts visible at byte level");
  }

  /* 7 — pages */
  add(
    "Page tree",
    numPages > 0 ? "pass" : "fail",
    numPages > 0 ? `${numPages} page(s) render and parse` : "no readable pages"
  );

  if (hasObjStm) {
    checks.push({
      name: "Object streams",
      status: "info",
      note: "file uses compressed object streams — some checks are limited to what a browser can see",
    });
  }

  return { checks, pdfaLevel, failed, warnings };
}

export function renderReport(fileName: string, verdict: Verdict): string {
  const icon: Record<CheckStatus, string> = {
    pass: "[PASS]",
    warn: "[WARN]",
    fail: "[FAIL]",
    info: "[INFO]",
  };
  const lines: string[] = [];
  lines.push("PDF/A STRUCTURAL CHECK REPORT");
  lines.push("Generated on-device by Sidocs — nothing was uploaded.");
  lines.push(`File: ${fileName}`);
  lines.push(
    `Verdict: ${
      verdict.pdfaLevel
        ? verdict.failed === 0
          ? `${verdict.pdfaLevel} — all browser-visible checks passed`
          : `${verdict.pdfaLevel} — ${verdict.failed} check(s) failed`
        : "Does not identify as PDF/A"
    }`
  );
  lines.push("");
  lines.push("CHECKS");
  for (const c of verdict.checks) {
    lines.push(`${icon[c.status]}  ${c.name}: ${c.note}`);
  }
  lines.push("");
  lines.push("हिंदी निष्कर्ष (Hindi verdict)");
  if (!verdict.pdfaLevel) {
    lines.push("यह फ़ाइल PDF/A नहीं है — इसमें pdfaid मार्कर नहीं मिला।");
  } else if (verdict.failed === 0) {
    lines.push(
      `फ़ाइल अपने आप को ${verdict.pdfaLevel} बताती है और ब्राउज़र में दिखने वाली सभी जाँचें पास हैं।`
    );
  } else {
    lines.push(
      `फ़ाइल अपने आप को ${verdict.pdfaLevel} बताती है, पर ${verdict.failed} जाँचें असफल रहीं — ऊपर देखें।`
    );
  }
  lines.push("");
  lines.push(
    "Honest scope: this is a browser-side structural check, not a full ISO 19005 conformance suite. 'Undetermined' means compressed object streams hid the structure."
  );
  return lines.join("\n") + "\n";
}
