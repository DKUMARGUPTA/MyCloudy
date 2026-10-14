/**
 * Generate QR code smoke (P4.2) — engine unit checks + real `qrcode`
 * renders. Covers every payload builder, every validator, the color /
 * contrast math, and renders real PNG (dataURL) + SVG bytes for one
 * payload per family so the renderer options (colors, margin, EC) are
 * exercised too. Exit code = failures.
 */
import QRCode from "qrcode";
import {
  buildEmailPayload,
  buildPhonePayload,
  buildTextPayload,
  buildUpiPayload,
  buildVcardPayload,
  buildWhatsappPayload,
  buildWifiPayload,
  clampMargin,
  cleanPhone,
  contrastRatio,
  ecFor,
  isEcLevel,
  isValidUpiAmount,
  isValidUpiPa,
  luminance,
  normalizeQrColor,
  normalizeUrl,
  qrFileName,
  type WifiInput,
} from "../tools/generate-qr-code/engine";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`  ✗ ${name}`);
  }
}

/* ---------------- URL ---------------- */
check("url: prepends https://", normalizeUrl("example.com/page") === "https://example.com/page");
check("url: keeps scheme", normalizeUrl("https://a.b/x?y=1") === "https://a.b/x?y=1");
check("url: trims", normalizeUrl("  https://a.b  ") === "https://a.b/");
check("url: empty → null", normalizeUrl("   ") === null);
check("url: spaces → null", normalizeUrl("not a url") === null);
// Non-web schemes without a hostname (mailto:) are rejected — the Email
// kind owns those. Schemes WITH a hostname (ftp:) pass through.
check("url: mailto → null (email kind owns it)", normalizeUrl("mailto:x@y.z") === null);
check("url: ftp with host kept", normalizeUrl("ftp://files.example.com/x") === "ftp://files.example.com/x");

/* ---------------- text ---------------- */
check("text: passes through trimmed", buildTextPayload("  hello world  ") === "hello world");
check("text: empty → null", buildTextPayload("   ") === null);
check("text: over cap → null", buildTextPayload("x".repeat(1501)) === null);
check("text: exactly at cap passes", buildTextPayload("x".repeat(1500)) === "x".repeat(1500));

/* ---------------- WiFi ---------------- */
const wifiBase: WifiInput = { ssid: "HomeNet", password: "pass123", encryption: "WPA", hidden: false };
check("wifi: WPA basic", buildWifiPayload(wifiBase) === "WIFI:T:WPA;P:pass123;S:HomeNet;;");
check("wifi: hidden adds H:true", buildWifiPayload({ ...wifiBase, hidden: true }) === "WIFI:T:WPA;P:pass123;S:HomeNet;H:true;;");
check("wifi: nopass drops P+T", buildWifiPayload({ ssid: "Cafe", password: "", encryption: "nopass", hidden: false }) === "WIFI:S:Cafe;;");
check("wifi: WEP label", buildWifiPayload({ ...wifiBase, encryption: "WEP" }) === "WIFI:T:WEP;P:pass123;S:HomeNet;;");
check("wifi: empty ssid → null", buildWifiPayload({ ...wifiBase, ssid: "  " }) === null);
check("wifi: missing password → null", buildWifiPayload({ ...wifiBase, password: "" }) === null);
check("wifi: escapes specials", buildWifiPayload({ ssid: "a;b,c", password: 'x"y\\z', encryption: "WPA", hidden: false }) === 'WIFI:T:WPA;P:x\\"y\\\\z;S:a\\;b\\,c;;');

/* ---------------- UPI ---------------- */
check("upi: full payload", buildUpiPayload({ pa: "name@okbank", pn: "Priya", am: "120.50", tn: "For lunch" }) === "upi://pay?pa=name%40okbank&pn=Priya&am=120.50&cu=INR&tn=For+lunch");
check("upi: minimal payload", buildUpiPayload({ pa: "name@okbank", pn: "", am: "", tn: "" }) === "upi://pay?pa=name%40okbank");
check("upi: no amount → no cu", buildUpiPayload({ pa: "ab@cd", pn: "N", am: "", tn: "note" }) === "upi://pay?pa=ab%40cd&pn=N&tn=note");
check("upi: bad PA → null", buildUpiPayload({ pa: "no-at-sign", pn: "", am: "", tn: "" }) === null);
check("upi: bad amount → null", buildUpiPayload({ pa: "ab@cd", pn: "", am: "12.345", tn: "" }) === null);
check("upi: negative amount → null", isValidUpiAmount("-5") === false && buildUpiPayload({ pa: "ab@cd", pn: "", am: "-5", tn: "" }) === null);
check("upi: PA validator", isValidUpiPa("user.pay-1@HDFC") && !isValidUpiPa("a@") && !isValidUpiPa("@b"));
check("upi: amount validator", isValidUpiAmount("") && isValidUpiAmount("100") && isValidUpiAmount("100.5") && isValidUpiAmount("100.55") && !isValidUpiAmount("100.555") && !isValidUpiAmount("abc"));

/* ---------------- vCard ---------------- */
const vc = buildVcardPayload({ first: "Asha", last: "Verma", org: "Acme", phone: "+919876543210", email: "asha@acme.in", url: "acme.in", address: "12 MG Road", note: "Hello\nthere" });
check("vcard: header+footer", vc !== null && vc.startsWith("BEGIN:VCARD\nVERSION:3.0\n") && vc.endsWith("\nEND:VCARD"));
check("vcard: N and FN lines", vc !== null && vc.includes("N:Verma;Asha;;;") && vc.includes("FN:Asha Verma"));
check("vcard: org/phone/email/url/adr", vc !== null && vc.includes("ORG:Acme") && vc.includes("TEL;TYPE=CELL:+919876543210") && vc.includes("EMAIL:asha@acme.in") && vc.includes("URL:acme.in") && vc.includes("ADR;TYPE=HOME:;;12 MG Road;;;;"));
check("vcard: note newline folded", vc !== null && vc.includes("NOTE:Hello\\nthere"));
check("vcard: no names → null", buildVcardPayload({ first: " ", last: "", org: "", phone: "", email: "", url: "", address: "", note: "" }) === null);
check("vcard: bad phone omitted", !buildVcardPayload({ first: "A", last: "", org: "", phone: "12", email: "", url: "", address: "", note: "" })!.includes("TEL"));
check("vcard: bad email omitted", !buildVcardPayload({ first: "A", last: "", org: "", phone: "", email: "nope", url: "", address: "", note: "" })!.includes("EMAIL"));

/* ---------------- email ---------------- */
check("email: plain", buildEmailPayload({ address: "a@b.co", subject: "", body: "" }) === "mailto:a@b.co");
check("email: subject+body encoded", buildEmailPayload({ address: "a@b.co", subject: "Hi there", body: "Line 1" }) === "mailto:a@b.co?subject=Hi+there&body=Line+1");
check("email: bad address → null", buildEmailPayload({ address: "a b@c", subject: "", body: "" }) === null);

/* ---------------- phone ---------------- */
check("phone: keeps +", buildPhonePayload("+91 98765 43210") === "tel:+919876543210");
check("phone: no plus is fine", buildPhonePayload("0801234567") === "tel:0801234567");
check("phone: too short → null", buildPhonePayload("123") === null);
check("phone: cleanPhone", cleanPhone("+91-98") === null && cleanPhone("+91987654321") === "+91987654321");

/* ---------------- WhatsApp ---------------- */
check("wa: plain number", buildWhatsappPayload({ phone: "+91 98765 43210", message: "" }) === "https://wa.me/919876543210");
check("wa: message encoded", buildWhatsappPayload({ phone: "919876543210", message: "Hi there" }) === "https://wa.me/919876543210?text=Hi+there");
check("wa: too short → null", buildWhatsappPayload({ phone: "1234567", message: "" }) === null);

/* ---------------- style / colors ---------------- */
check("clampMargin: bounds", clampMargin(0) === 1 && clampMargin(99) === 8 && clampMargin(NaN) === 4 && clampMargin(4.6) === 5);
check("ecFor: logo forces H", ecFor(true, "L") === "H" && ecFor(false, "L") === "L");
check("isEcLevel", isEcLevel("H") && !isEcLevel("X"));
check("color: 6-digit passthrough", normalizeQrColor("#AbCdEf") === "#abcdef");
check("color: 3-digit expands", normalizeQrColor("#F0A") === "#ff00aa");
check("color: garbage → null", normalizeQrColor("red") === null && normalizeQrColor("#12345") === null);
check("luminance: black is 0, white ~1", luminance("#000000") === 0 && Math.abs(luminance("#ffffff") - 1) < 1e-9);
const ratio = contrastRatio("#000000", "#ffffff");
check("contrast: black/white = 21", Math.abs(ratio - 21) < 1e-9);
check("contrast: same color = 1", contrastRatio("#0f766e", "#0f766e") === 1);
check("contrast: gray pair between", contrastRatio("#777777", "#ffffff") > 4 && contrastRatio("#777777", "#ffffff") < 5);
check("filename", qrFileName("upi", "png") === "qr-upi.png");

/* ---------------- real renders (qrcode package) ---------------- */
const pngDataUrl = await QRCode.toDataURL("https://docopdf.example/hello", {
  errorCorrectionLevel: "H",
  margin: 4,
  width: 512,
  color: { dark: "#0f766e", light: "#ffffff" },
});
check("render: PNG dataURL prefix", pngDataUrl.startsWith("data:image/png;base64,"));
const pngBytes = Buffer.from(pngDataUrl.split(",")[1]!, "base64");
check("render: PNG magic", pngBytes[0] === 0x89 && pngBytes[1] === 0x50 && pngBytes[2] === 0x4e && pngBytes[3] === 0x47);
check("render: PNG size plausible", pngBytes.length > 1000 && pngBytes.length < 20000);

const svgWifi = await QRCode.toString("WIFI:T:WPA;P:pass123;S:HomeNet;;", {
  type: "svg",
  errorCorrectionLevel: "M",
  margin: 2,
  color: { dark: "#1e293b", light: "#e2e8f0" },
});
check("render: SVG is svg", svgWifi.startsWith("<?xml") || svgWifi.startsWith("<svg"));
check("render: SVG carries viewBox", svgWifi.includes("viewBox"));
check("render: SVG carries fill", svgWifi.includes("#1e293b"));

const svgUpi = await QRCode.toString("upi://pay?pa=name%40okbank&am=120.50&cu=INR", { type: "svg", margin: 4 });
check("render: SVG upi renders too", svgUpi.includes("<svg") || svgUpi.includes("<?xml"));

// A long-text render at level H must still succeed (data capacity sanity).
const longText = "DocoPDF smoke test ".repeat(40); // 380 chars
const longPng = await QRCode.toDataURL(longText, { errorCorrectionLevel: "H", width: 1024 });
check("render: 380-char text at H", longPng.startsWith("data:image/png;base64,"));

console.log(`qr smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
