/**
 * P9-F6A-UI smoke: the tool-layer contracts for digital-signature (#95)
 * and verify-pdf-signatures (#97) — the surface→worker option transport,
 * the p12 asset store cycle, the report renderer, i18n parity after the
 * merge, and full options→sign→verify round trips through the real pki
 * fixtures. No DOM, no dev server (the orchestrator runs browser E2E).
 * Run: bun scripts/smoke-p9-f6ui.ts
 */
import { readFileSync } from "node:fs";

import { PDFDocument } from "pdf-lib";
import { signPdf } from "../tools/pki-common/pdfsign";
import { verifyPdfSignatures } from "../tools/pki-common/verify";
import { P12Error } from "../tools/pki-common/p12";
import {
  parseSignOptions,
  p12ErrorDetail,
} from "../tools/digital-signature/worker";
import {
  renderReport,
  summarize,
} from "../tools/verify-pdf-signatures/worker";
import type { SignatureReport } from "../tools/pki-common/verify";

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

const PKI = "qa/pki";

/* ------------------------- p12 store cycle ------------------------- */
console.log("p12 store");

// The store notifies via window events — an EventTarget stands in (bun).
(globalThis as { window?: unknown }).window = new EventTarget();
const store = await import("../tools/digital-signature/p12-store");

check("store starts empty", store.getP12File() === null && store.getP12Cert() === null);

const fakeFile = new File([new Uint8Array([1, 2, 3])], "signer.p12", {
  type: "application/x-pkcs12",
});
const fakeCert = {
  cn: "Asha Verma",
  org: "Example Ltd",
  validTo: "2030-01-01T00:00:00.000Z",
  keyKind: "RSA",
  serial: "00aabbcc",
};

let notified = 0;
const unsubscribe = store.subscribeToP12(() => {
  notified += 1;
});
store.setP12Entry(fakeFile, fakeCert);
check("set → file identity", store.getP12File() === fakeFile);
check(
  "set → cert summary fields",
  store.getP12Cert()?.cn === "Asha Verma" &&
    store.getP12Cert()?.org === "Example Ltd" &&
    store.getP12Cert()?.keyKind === "RSA" &&
    store.getP12Cert()?.validTo === fakeCert.validTo &&
    store.getP12Cert()?.serial === fakeCert.serial
);
check("entry snapshot matches", store.getP12Entry().file === fakeFile && store.getP12Entry().cert?.cn === "Asha Verma");
check("subscribe notified once", notified === 1, `notified=${notified}`);

store.clearP12();
check("clear → empty again", store.getP12File() === null && store.getP12Cert() === null);
check("clear notified too", notified === 2, `notified=${notified}`);
unsubscribe();
store.setP12Entry(fakeFile, fakeCert);
check("unsubscribe stops delivery", notified === 2, `notified=${notified}`);
store.clearP12();

/* ------------------------- option transport ------------------------- */
console.log("option transport (surface → worker)");

const surfaceOptions = {
  pw: "test1234",
  reason: "Board approval",
  location: "New Delhi",
  name: "Asha Verma",
  stamp: "1",
  page: 2,
  locale: "hi",
};
const parsed = parseSignOptions(surfaceOptions);
check(
  "full surface shape parses",
  parsed.password === "test1234" &&
    parsed.reason === "Board approval" &&
    parsed.location === "New Delhi" &&
    parsed.name === "Asha Verma" &&
    parsed.visible === true &&
    parsed.page === 2 &&
    parsed.locale === "hi"
);

const empty = parseSignOptions({});
check(
  "empty options → defensive defaults",
  empty.password === "" &&
    empty.reason === "" &&
    empty.location === "" &&
    empty.name === "" &&
    empty.visible === false &&
    empty.page === 1 &&
    empty.locale === "en"
);

check("page clamps low", parseSignOptions({ page: 0 }).page === 1 && parseSignOptions({ page: -7 }).page === 1);
check("page floors + junk", parseSignOptions({ page: 2.7 }).page === 2 && parseSignOptions({ page: "abc" }).page === 1);
check(
  "text fields slice to their caps",
  parseSignOptions({ reason: "r".repeat(300) }).reason.length === 200 &&
    parseSignOptions({ location: "l".repeat(200) }).location.length === 120 &&
    parseSignOptions({ name: "n".repeat(100) }).name.length === 60
);
check(
  "stamp truthiness is exactly \"1\"",
  parseSignOptions({ stamp: "1" }).visible === true &&
    parseSignOptions({ stamp: "0" }).visible === false &&
    parseSignOptions({}).visible === false
);
check(
  "locale is hi only when hi",
  parseSignOptions({ locale: "hi" }).locale === "hi" &&
    parseSignOptions({ locale: "HI" }).locale === "en"
);

const codes = [
  "bad-password",
  "legacy-encryption",
  "not-p12",
  "no-key",
  "unsupported",
  "malformed",
];
const details = codes.map((c) => p12ErrorDetail(c));
check(
  "all six p12 codes map to honest lines",
  details.every((d) => d.startsWith("sign: ") && d.length > 20) &&
    p12ErrorDetail("bad-password").includes("password is wrong") &&
    p12ErrorDetail("legacy-encryption").includes("3DES/RC2") &&
    p12ErrorDetail("no-key").includes("no private key")
);
check("unknown code falls back honestly", p12ErrorDetail("whatever").startsWith("sign: "));

/* ------------------------- round trips via the contract ------------------------- */
console.log("sign → verify round trips (real fixtures)");

const rsaP12 = new Uint8Array(readFileSync(`${PKI}/signer-rsa.p12`));
const ecP12 = new Uint8Array(readFileSync(`${PKI}/signer-ec.p12`));

const doc = await PDFDocument.create();
doc.addPage([595, 842]);
doc.addPage([595, 842]);
const samplePdf = new Uint8Array(await doc.save());

async function signViaContract(
  p12: Uint8Array,
  options: Record<string, string>
): Promise<Uint8Array> {
  const o = parseSignOptions(options);
  const r = await signPdf(samplePdf, {
    p12,
    password: o.password,
    reason: o.reason,
    location: o.location,
    visible: o.visible
      ? {
          page: o.page,
          name: o.name,
          reason: o.reason,
          location: o.location,
          locale: o.locale,
        }
      : null,
  });
  return r.bytes;
}

const signedRsa = await signViaContract(rsaP12, {
  pw: "test1234",
  reason: "Annual report approved",
  location: "Mumbai",
  stamp: "0",
});
const rsaVerdict = await verifyPdfSignatures(signedRsa);
check(
  "RSA options→sign→verify round trip",
  rsaVerdict.found.length === 1 &&
    rsaVerdict.found[0].valid === true &&
    rsaVerdict.found[0].documentIntact === true &&
    rsaVerdict.found[0].signer?.subject.CN === "Asha Verma"
);

const signedEc = await signViaContract(ecP12, {
  pw: "test1234",
  stamp: "0",
});
const ecVerdict = await verifyPdfSignatures(signedEc);
check(
  "ECDSA options→sign→verify round trip",
  ecVerdict.found.length === 1 &&
    ecVerdict.found[0].valid === true &&
    ecVerdict.found[0].signer?.subject.CN === "Rahul Sharma"
);

// Visible stamp through the exact option shape. The name stays Latin here —
// bun has no Devanagari font fetch, so the engine falls back to Helvetica
// (the browser E2E owns the Hindi-stamp path, per the engine's own note).
const stamped = await signViaContract(rsaP12, {
  pw: "test1234",
  reason: "Release",
  name: "Asha Verma",
  stamp: "1",
  page: "2",
  locale: "en",
});
const stampVerdict = await verifyPdfSignatures(stamped);
check(
  "visible stamp via options still verifies",
  stampVerdict.found.length === 1 && stampVerdict.found[0].valid === true
);

let badPw: P12Error | null = null;
try {
  await signViaContract(rsaP12, { pw: "wrong-password", stamp: "0" });
} catch (e) {
  badPw = e instanceof P12Error ? e : null;
}
check(
  "wrong password through the contract → bad-password detail",
  badPw !== null &&
    badPw.code === "bad-password" &&
    p12ErrorDetail(badPw.code).includes("password is wrong")
);

// Tamper: flip one byte inside the covered region → digest must fail.
const tampered = new Uint8Array(signedRsa);
tampered[200] ^= 0x01;
const tamperVerdict = await verifyPdfSignatures(tampered);
check(
  "tamper detection through the verify engine",
  tamperVerdict.found.length === 1 &&
    tamperVerdict.found[0].valid === false &&
    tamperVerdict.found[0].documentIntact === false
);

/* ------------------------- verify report renderer ------------------------- */
console.log("verify report renderer");

const realReport = renderReport("annual-report.pdf", rsaVerdict);
check(
  "valid report renders signer + verdict + checks",
  realReport.includes("SIGNATURE 1 OF 1") &&
    realReport.includes("Asha Verma") &&
    realReport.includes("Verdict: VALID") &&
    realReport.includes("Document: INTACT") &&
    realReport.includes("[PASS]")
);
check(
  "report carries the Hindi verdict + honest scope",
  realReport.includes("हिंदी निष्कर्ष") &&
    realReport.includes("भरोसा (ट्रस्ट) का फ़ैसला") &&
    realReport.includes("Honest scope") &&
    realReport.includes("CRL/OCSP")
);

const tamperedReport = renderReport("tampered.pdf", tamperVerdict);
check(
  "tampered report is loud",
  tamperedReport.includes("Document: TAMPERED") &&
    tamperedReport.includes("Verdict: INVALID") &&
    tamperedReport.includes("[FAIL]")
);

const unsignedReport = renderReport("plain.pdf", {
  found: [],
  hasSignature: false,
});
check(
  "unsigned report is a plain finding, not an error",
  unsignedReport.includes("No digital signature found") &&
    unsignedReport.includes("बिना हस्ताक्षर की है")
);

const fakeValid: SignatureReport = {
  byteRange: [0, 1, 2, 3],
  valid: true,
  signer: null,
  signingTime: new Date("2026-01-02T03:04:05.000Z"),
  checks: [{ id: "digest", status: "pass" }],
  documentIntact: true,
};
const fakeInvalid: SignatureReport = {
  byteRange: [0, 1, 2, 3],
  valid: false,
  signer: null,
  signingTime: null,
  checks: [{ id: "digest", status: "fail" }],
  documentIntact: false,
};
check(
  "summarize counts multi-signature verdicts",
  (() => {
    const s = summarize([fakeValid, fakeInvalid, fakeValid]);
    return (
      s.signatures === 3 && s.valid === 2 && s.failed === 1
    );
  })()
);
const multiReport = renderReport("multi.pdf", {
  found: [fakeValid, fakeInvalid],
  hasSignature: true,
});
check(
  "multi-signature report numbers each signature",
  multiReport.includes("SIGNATURE 1 OF 2") &&
    multiReport.includes("SIGNATURE 2 OF 2") &&
    multiReport.includes("2 signature(s) found — 1 valid, 1 invalid") &&
    multiReport.includes("Signer: unknown")
);

/* ------------------------- i18n parity (post-merge) ------------------------- */
console.log("i18n parity");

const en = JSON.parse(readFileSync("src/i18n/en.json", "utf8"));
const hi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8"));
function leaves(node: Record<string, unknown>): number {
  let n = 0;
  for (const value of Object.values(node)) {
    n += value !== null && typeof value === "object" ? leaves(value as Record<string, unknown>) : 1;
  }
  return n;
}
check(
  "whole-catalog leaf parity",
  leaves(en) === leaves(hi),
  `en=${leaves(en)} hi=${leaves(hi)}`
);
check(
  "dsig + vsig sections exist with matching key sets",
  JSON.stringify(Object.keys(en.dsig).sort()) ===
    JSON.stringify(Object.keys(hi.dsig).sort()) &&
    JSON.stringify(Object.keys(en.vsig).sort()) ===
      JSON.stringify(Object.keys(hi.vsig).sort()) &&
    Object.keys(en.dsig).length === 47 &&
    Object.keys(en.vsig).length === 4
);
const requiredKeys = [
  "dsig.how1",
  "dsig.how2",
  "dsig.how3",
  "vsig.how1",
  "vsig.how2",
  "vsig.how3",
  "dsig.needFile",
  "dsig.needCert",
];
check(
  "required keys present in both languages",
  requiredKeys.every((k) => {
    const [sec, leaf] = k.split(".");
    return leaf in en[sec] && leaf in hi[sec];
  })
);
const surfaceSrc = readFileSync(
  "tools/digital-signature/surface.tsx",
  "utf8"
);
const literalRe = /"dsig\.([a-zA-Z0-9]+)"/g;
const surfaceLiterals = new Set<string>();
for (const m of surfaceSrc.matchAll(literalRe)) surfaceLiterals.add(m[1]);
check(
  "every surface dsig literal exists in both catalogs",
  [...surfaceLiterals].every(
    (k) => k in en.dsig && k in hi.dsig && en.dsig[k].length > 0 && hi.dsig[k].length > 0
  ),
  `literals=${surfaceLiterals.size}`
);
const p12ErrKeys = [
  "errBadPassword",
  "errLegacy",
  "errNotP12",
  "errNoKey",
  "errUnsupported",
  "errMalformed",
];
check(
  "all six error keys localized in both languages",
  p12ErrKeys.every(
    (k) => k in en.dsig && k in hi.dsig && /[।.]/.test(hi.dsig[k])
  )
);

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail > 0) {
  process.exit(1);
}
