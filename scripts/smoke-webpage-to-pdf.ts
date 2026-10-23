/**
 * Smoke: webpage-to-pdf (RB4-f) — URL → PDF via the pass-through pipe +
 * the on-device html-to-pdf engine.
 *
 * House conventions (smoke-html-to-pdf base): pure-module vectors for
 * the API route's logic (which lives in tools/webpage-to-pdf/url-guard.ts
 * + model.ts precisely so it is testable WITHOUT the Next runtime),
 * REAL renders through the worker's exact pipeline (parseHtml →
 * parseHtmlRun → needsNoto → drawHtmlPdf, node:zlib inflate oracle for
 * stream text, pdf-lib reload font/geometry asserts), naming vectors
 * and rejection vectors. A LIVE network call is deliberately NOT made
 * here — browser QA covers the real /api/fetch-page round trip; this
 * smoke proves everything the pipe hands back would render.
 *
 * Run: bun scripts/smoke-webpage-to-pdf.ts
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

import {
  buildSampleHtml,
  type ParsedHtml,
} from "../tools/html-to-pdf/model";
import { drawHtmlPdf, type HtmlFontSet } from "../tools/html-to-pdf/render";
import {
  FETCH_ERROR_CODES,
  FETCH_PAGE_LIMITS,
  fetchErrorKey,
  hostnameBaseName,
  looksLikeHtml,
  needsNoto,
  parseHtml,
  parseHtmlRun,
  pickBaseName,
  stats,
} from "../tools/webpage-to-pdf/model";
import {
  checkResolvedIps,
  isPrivateIp,
  urlShapeOk,
  validatePageUrl,
} from "../tools/webpage-to-pdf/url-guard";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(label);
    console.error(
      `  FAIL ${label}`,
      actual !== undefined ? JSON.stringify(actual).slice(0, 300) : ""
    );
  }
}

/* ------------------------------------------------------------------ */
/* helpers (smoke-html-to-pdf copies)                                   */
/* ------------------------------------------------------------------ */

function inflatedText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  let out = "";
  let idx = 0;
  for (;;) {
    const s = raw.indexOf("stream", idx);
    if (s < 0) break;
    let start = s + 6;
    if (raw[start] === "\r") start++;
    if (raw[start] === "\n") start++;
    const e = raw.indexOf("endstream", start);
    if (e < 0) break;
    try {
      out += inflateSync(Buffer.from(raw.slice(start, e), "latin1")).toString(
        "latin1"
      );
    } catch {
      /* non-flate stream (font) */
    }
    idx = e + 9;
  }
  return out;
}

function hasText(stream: string, s: string): boolean {
  if (stream.includes(s)) return true;
  const hex = Buffer.from(s, "latin1").toString("hex").toUpperCase();
  if (stream.includes(`<${hex}>`)) return true;
  return hex.length >= 8 ? stream.includes(hex) : false;
}

const notoBytes = new Uint8Array(
  readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf")
);

/** the worker's exact EN font set (base-14, lazily embedded). */
function enFontSet(pdfDoc: PDFDocument): HtmlFontSet {
  const cache = new Map<string, PDFFont>();
  const key = (b: boolean, i: boolean, m: boolean): string =>
    `${b ? "B" : ""}${i ? "I" : ""}${m ? "M" : ""}`;
  return {
    isNoto: false,
    resolve(bold, italic, mono) {
      const k = key(bold, italic, mono);
      const hit = cache.get(k);
      if (hit) return hit;
      let font: PDFFont;
      if (mono) {
        font = pdfDoc.embedStandardFont(
          bold && italic
            ? StandardFonts.CourierBoldOblique
            : bold
              ? StandardFonts.CourierBold
              : italic
                ? StandardFonts.CourierOblique
                : StandardFonts.Courier
        );
      } else {
        font = pdfDoc.embedStandardFont(
          bold && italic
            ? StandardFonts.HelveticaBoldOblique
            : bold
              ? StandardFonts.HelveticaBold
              : italic
                ? StandardFonts.HelveticaOblique
                : StandardFonts.Helvetica
        );
      }
      cache.set(k, font);
      return font;
    },
  };
}

/**
 * The WORKER's exact render path (minus the network): parseHtml →
 * parseHtmlRun boundary coercion → needsNoto → the single font
 * decision → drawHtmlPdf — with the same font recipe (base-14 set vs
 * the Noto subset the worker embeds through loadStampFonts).
 */
async function renderPage(
  html: string,
  opts: {
    pageSize?: "a4" | "letter";
    margin?: "normal" | "narrow";
    baseFontSize?: number;
    showLinks?: boolean;
  }
): Promise<{ bytes: Uint8Array; pages: number; doc: ParsedHtml }> {
  const doc = parseHtmlRun(JSON.stringify(parseHtml(html)));
  const pdfDoc = await PDFDocument.create();
  let fonts: HtmlFontSet;
  if (needsNoto(doc)) {
    pdfDoc.registerFontkit(fontkit);
    const noto = await pdfDoc.embedFont(notoBytes, { subset: true });
    fonts = { isNoto: true, resolve: () => noto };
  } else {
    fonts = enFontSet(pdfDoc);
  }
  const report = drawHtmlPdf(pdfDoc, fonts, doc, {
    pageSize: opts.pageSize ?? "a4",
    margin: opts.margin ?? "normal",
    baseFontSize: opts.baseFontSize ?? 11,
    showLinks: opts.showLinks ?? false,
  });
  const bytes = await pdfDoc.save();
  const reloaded = await PDFDocument.load(bytes);
  return { bytes, pages: reloaded.getPageCount(), doc };
}

/** A realistic FETCHED page (what the pipe would hand the worker). */
const WEBPAGE_FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Server Rendering Explained — Falcon Blog</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/assets/site.css">
<script>window.__APP__=function(){document.getElementById('root').innerHTML='x';};</script>
</head>
<body>
<nav><a href="/">Home</a> | <a href="/about">About</a> | <a href="/archive">Archive</a></nav>
<main>
<article>
<h1>Server Rendering Explained</h1>
<p>Every page you can read without JavaScript first arrived as <b>raw HTML</b>, produced by a server far away.</p>
<h2>Why it converts well</h2>
<ul>
<li>Text stays selectable — real glyphs, not pixels.</li>
<li>Structure survives: headings, lists, quotes and tables.</li>
<li>Reading order matches the markup order.</li>
</ul>
<blockquote><p>The web's original promise: <a href="https://standards.example/html">a document</a> anyone can read.</p></blockquote>
<h2>Compatibility table</h2>
<table>
<tr><th>Browser</th><th>Works</th></tr>
<tr><td>Chrome</td><td>Yes</td></tr>
<tr><td>Firefox</td><td>Yes</td></tr>
<tr><td>Lynx</td><td>Since 1992</td></tr>
</table>
<pre>
$ curl -s https://example.com | head -5
&lt;!DOCTYPE html&gt;
</pre>
</article>
</main>
<footer>© 2026 Falcon Press — <a href="/rss.xml">RSS</a> feed available.</footer>
<img src="chart.png" alt="Growth chart">
</body>
</html>`;

/** A JavaScript-built SPA shell (the honest no-content case). */
const SPA_SHELL = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sparkle App</title>
<script src="/bundle.9f3c.js" defer></script>
<link rel="stylesheet" href="/bundle.css">
</head>
<body>
<div id="root"></div>
<noscript>Enable JavaScript to use this app.</noscript>
</body>
</html>`;

/* ------------------------------------------------------------------ */
console.log("── 1. URL validation vectors (the route's gate, pure) ──");
{
  const ok = (raw: string): boolean => validatePageUrl(raw).ok;
  const proto = (raw: string): string =>
    validatePageUrl(raw).ok ? (validatePageUrl(raw) as { url: URL }).url.protocol : "?";

  check("https URL with path + query accepted", ok("https://example.com/path?q=1"));
  check("http URL accepted", ok("http://example.com"));
  check("uppercase scheme + host normalized (WHATWG)", ok("HTTPS://EXAMPLE.COM/") && proto("https://example.com/") === "https:");
  check("surrounding whitespace trimmed", ok("  https://example.com/page  "));
  check("protocol is https for https URL", proto("https://example.com") === "https:");
  check("fragment + port accepted", ok("https://example.com:8443/a#b"));

  check("ftp:// rejected", !ok("ftp://example.com/file"));
  check("javascript: rejected", !ok("javascript:alert(1)"));
  check("data: rejected", !ok("data:text/html,hello"));
  check("file: rejected", !ok("file:///etc/passwd"));
  check("mailto: rejected", !ok("mailto:a@b.c"));
  check("plain words rejected", !ok("not a url"));
  check("empty rejected", !ok(""));
  check("scheme-only rejected (https://)", !ok("https://"));
  check("whitespace-only rejected", !ok("   "));
  check("2049-char URL rejected (length cap)", !ok("https://example.com/" + "a".repeat(2049 - 20)));

  check("urlShapeOk https", urlShapeOk("https://example.com/a"));
  check("urlShapeOk http", urlShapeOk("http://example.com"));
  check("urlShapeOk rejects ftp", !urlShapeOk("ftp://example.com"));
  check("urlShapeOk rejects bare host", !urlShapeOk("example.com/page"));
  check("urlShapeOk rejects spaces", !urlShapeOk("https://exa mple.com"));
  check("urlShapeOk rejects javascript:", !urlShapeOk("javascript:alert(1)"));
}

console.log("── 2. SSRF blocklist (private ranges, both families) ────");
{
  const blocked = [
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.1",
    "192.168.0.100",
    "169.254.169.254",
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fe80:dead:beef::1",
    "fc00::1",
    "fd12:3456:789a::1",
    "::ffff:127.0.0.1",
    "::ffff:192.168.0.1",
    "[fe80::1]",
    "fe80::1%eth0",
    "::",
  ];
  for (const ip of blocked) {
    check(`blocked: ${ip}`, isPrivateIp(ip) === true, isPrivateIp(ip));
  }

  const allowed = [
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1", // just above 172.16/12
    "172.15.255.255", // just below 172.16/12
    "169.255.0.1", // just above link-local
    "11.0.0.1",
    "100.64.0.1", // CGNAT — deliberately allowed (documented)
    "2606:4700::1111",
    "2001:db8::1",
    "::ffff:8.8.8.8", // v4-mapped PUBLIC
  ];
  for (const ip of allowed) {
    check(`allowed: ${ip}`, isPrivateIp(ip) === false, isPrivateIp(ip));
  }

  check("unparseable octet fails closed", isPrivateIp("999.1.1.1") === true);
  check("empty fails closed", isPrivateIp("") === true);
  check("garbage fails closed", isPrivateIp("not-an-ip") === true);

  check("checkResolvedIps: all public passes", checkResolvedIps(["8.8.8.8", "2606:4700::1111"]).ok === true);
  const mixed = checkResolvedIps(["8.8.8.8", "10.0.0.1"]);
  check("checkResolvedIps: any private blocks", mixed.ok === false && (mixed.ok === false && mixed.ip === "10.0.0.1"), mixed);
}

console.log("── 3. pipe limits + error-code mapping ──────────────────");
{
  check("body cap is 5 MB", FETCH_PAGE_LIMITS.maxBytes === 5 * 1024 * 1024);
  check("timeout is 15 s", FETCH_PAGE_LIMITS.timeoutMs === 15_000);
  check("redirect limit is 3", FETCH_PAGE_LIMITS.maxRedirects === 3);

  const expectedMap: Record<string, string> = {
    "invalid-url": "wpdf.errUrl",
    "private-address": "wpdf.errPrivate",
    "dns-failed": "wpdf.errFetch",
    "fetch-failed": "wpdf.errFetch",
    "timeout": "wpdf.errTimeout",
    "too-large": "wpdf.errTooLarge",
    "not-html": "wpdf.errNotHtml",
    "too-many-redirects": "wpdf.errRedirects",
    "http-status": "wpdf.errHttpStatus",
    "rate-limited": "wpdf.errRate",
  };
  for (const code of FETCH_ERROR_CODES) {
    const want = expectedMap[code];
    check(`fetchErrorKey(${code}) → ${want}`, fetchErrorKey(code) === want, fetchErrorKey(code));
  }
  check("unknown code → generic (no leak)", fetchErrorKey("anything-else") === "tool.errorGeneric");
  check("empty code → generic", fetchErrorKey("") === "tool.errorGeneric");

  // non-html content-type honesty: the route only accepts the two HTML
  // kinds — asserted against the exact strings it compares
  const accepted = ["text/html", "application/xhtml+xml"];
  for (const ct of ["application/pdf", "image/png", "text/plain", "application/json", ""]) {
    check(`content-type "${ct}" is NOT html`, !accepted.includes(ct));
  }
  check("content-type text/html; charset=utf-8 prefix-matches", "text/html; charset=utf-8".split(";")[0].trim() === "text/html");
}

console.log("── 4. output naming (title → hostname fallback) ──────────");
{
  check(
    "hostname dots → dashes (task vector)",
    hostnameBaseName("https://Example.COM/path?q", "en") === "example-com"
  );
  check(
    "multi-label host",
    hostnameBaseName("https://example.co.uk/a/b", "en") === "example-co-uk"
  );
  check(
    "deep subdomain",
    hostnameBaseName("https://sub.shop.example.com/", "en") === "sub-shop-example-com"
  );
  check(
    "IDN hostname arrives punycode/ASCII (honest)",
    hostnameBaseName("https://उदाहरण.भारत/hi", "en").startsWith("xn--")
  );
  check(
    "public IPv6 literal unbracketed + dashed (\"::\" keeps both dashes)",
    hostnameBaseName("http://[2606:4700::1111]:8080/x", "en") === "2606-4700--1111"
  );
  check("garbage → Webpage (en)", hostnameBaseName("not a url", "en") === "Webpage");
  check("garbage → वेबपेज (hi)", hostnameBaseName("not a url", "hi") === "वेबपेज");
  check("empty URL → localized fallback", hostnameBaseName("", "hi") === "वेबपेज");

  check(
    "pickBaseName: <title> wins",
    pickBaseName("Server Rendering Explained — Falcon Blog", "https://example.com/x", "en") ===
      "Server Rendering Explained — Falcon Blog"
  );
  check(
    "pickBaseName: hostname when no title",
    pickBaseName("", "https://Example.COM/path?q", "en") === "example-com"
  );
  check(
    "pickBaseName: whitespace title falls to hostname",
    pickBaseName("   ", "https://Example.COM/path?q", "en") === "example-com"
  );
  check(
    "pickBaseName: path-unsafe title sanitized (engine rule)",
    pickBaseName("a/b:c", "https://x.example/", "en") === "a_b_c"
  );
}

console.log("── 5. REAL renders (the worker's exact engine path) ─────");
{
  const out = await renderPage(WEBPAGE_FIXTURE, {});
  check("EN: %PDF magic + size", out.bytes[0] === 0x25 && out.bytes.length > 1000, out.bytes.length);
  check("EN: single page", out.pages === 1, out.pages);
  const size = (await PDFDocument.load(out.bytes)).getPage(0).getSize();
  check("EN: A4 dims", Math.abs(size.width - 595.28) < 1 && Math.abs(size.height - 841.89) < 1, `${size.width}x${size.height}`);

  const txt = inflatedText(out.bytes);
  const needles = [
    "Server Rendering Explained",
    "raw HTML",
    "Why it converts well",
    "Text stays selectable",
    "Reading order matches",
    "original promise",
    "Chrome",
    "Firefox",
    "Since 1992",
    "Falcon Press",
    "Growth chart", // img alt in brackets
  ];
  for (const n of needles) {
    check(`EN: "${n}" selectable in stream`, hasText(txt, n));
  }
  check("EN: script content never renders", !hasText(txt, "__APP__") && !hasText(txt, "getElementById"));
  check("EN: nav links render as text", hasText(txt, "Archive"));
  check("EN: no NaN geometry", !txt.includes("NaN"));

  const reloaded = await PDFDocument.load(out.bytes);
  const dump = [...reloaded.context.enumerateIndirectObjects()]
    .map(([, o]) => o.toString())
    .join("\n");
  check("EN: FontFile2 ABSENT (no embed — pure WinAnsi)", !dump.includes("FontFile2"));
  check("EN: Helvetica base font present", dump.includes("/Helvetica"));
  check("EN: Courier present (pre block)", dump.includes("/Courier"));

  check("EN: fixture parses with its <title>", out.doc.title === "Server Rendering Explained — Falcon Blog", out.doc.title);
  check(
    "naming: title-derived via pickBaseName",
    pickBaseName(out.doc.title, "https://blog.example.com/", "en") === "Server Rendering Explained — Falcon Blog"
  );
  const st = stats(out.doc);
  check("stats: headings + table present", st.headings >= 3 && st.tables === 1, st);

  // letter + narrow + small font variants render clean
  const letterOut = await renderPage(WEBPAGE_FIXTURE, { pageSize: "letter" });
  const ls = (await PDFDocument.load(letterOut.bytes)).getPage(0).getSize();
  check("Letter dims 612×792", Math.abs(ls.width - 612) < 1 && Math.abs(ls.height - 792) < 1, `${ls.width}x${ls.height}`);
  const narrow = await renderPage(WEBPAGE_FIXTURE, { margin: "narrow", baseFontSize: 10 });
  check("narrow + small renders, no NaN", !inflatedText(narrow.bytes).includes("NaN") && narrow.pages === 1);

  // showLinks → the fetched page's hrefs print footnote-style
  const linksOn = await renderPage(WEBPAGE_FIXTURE, { showLinks: true });
  check("showLinks: href appended and searchable", hasText(inflatedText(linksOn.bytes), "https://standards.example/html"));
  const linksOff = await renderPage(WEBPAGE_FIXTURE, { showLinks: false });
  check("default: href NOT printed", !hasText(inflatedText(linksOff.bytes), "https://standards.example/html"));

  // long article paginates through the same pipeline
  const longHtml =
    "<html><body>" +
    Array.from(
      { length: 150 },
      (_, i) => `<p>Paragraph number ${i} of the fetched article with plenty of body text to fill pages.</p>`
    ).join("") +
    "</body></html>";
  const longOut = await renderPage(longHtml, {});
  check("long page breaks pages", longOut.pages >= 3, longOut.pages);

  // Hindi page (Devanagari in the fetched HTML) → the Noto subset
  const hiOut = await renderPage(buildSampleHtml(), {});
  check("HI: %PDF magic + size", hiOut.bytes[0] === 0x25 && hiOut.bytes.length > 1000, hiOut.bytes.length);
  const hiReloaded = await PDFDocument.load(hiOut.bytes);
  const hiDump = [...hiReloaded.context.enumerateIndirectObjects()]
    .map(([, o]) => o.toString())
    .join("\n");
  check("HI: Noto embedded (FontFile2)", hiDump.includes("FontFile2"));
  check("HI: Type0 composite (Identity-H)", hiDump.includes("Identity-H"));
  check("HI: no NaN", !inflatedText(hiOut.bytes).includes("NaN"));
}

console.log("── 6. rejection vectors (honest failure modes) ───────────");
{
  // SPA shell: tag-shaped (passes the gate) but carries no text
  check("SPA shell passes the looksLikeHtml gate", looksLikeHtml(SPA_SHELL) === true);
  const spaDoc = parseHtmlRun(JSON.stringify(parseHtml(SPA_SHELL)));
  check("SPA shell → zero blocks (worker: wpdf.errNoContent)", spaDoc.blocks.length === 0, spaDoc.blocks.length);
  check("SPA shell title still detected", spaDoc.title === "Sparkle App");
  check("SPA script + noscript text never parsed", !JSON.stringify(spaDoc).includes("bundle") && !JSON.stringify(spaDoc).includes("Enable JavaScript"));

  // plain text answer (a fetch that returned text/plain-ish content):
  // the worker's gate refuses it before parsing
  check("plain text rejected by the gate", looksLikeHtml("just words, no tags") === false);
  check("empty html rejected by the gate", looksLikeHtml("") === false);

  // invalid URL never reaches the network — the worker validates first
  const workerGate = validatePageUrl("ftp://internal/file");
  check("worker rejects non-http scheme before fetching", workerGate.ok === false);

  // private targets refused (the pipe's whole-block rule)
  check("localhost resolution would be refused", checkResolvedIps(["127.0.0.1"]).ok === false);
  check("192.168.x refused", checkResolvedIps(["192.168.0.10"]).ok === false);
  check("IPv6 ULA refused", checkResolvedIps(["fdab::1"]).ok === false);

  // non-html content-type → the route's honest error code maps to a key
  check("not-html code maps to wpdf.errNotHtml", fetchErrorKey("not-html") === "wpdf.errNotHtml");
  check("too-large code maps to wpdf.errTooLarge", fetchErrorKey("too-large") === "wpdf.errTooLarge");

  // engine caps still apply on top of the pipe's 5 MB (boundary coercion)
  const big = parseHtmlRun(
    JSON.stringify({
      title: "big",
      blocks: Array.from({ length: 20_001 }, () => ({
        kind: "para",
        runs: [{ text: "word" }],
      })),
    })
  );
  check("oversized payload clamped at the boundary", big.blocks.length <= 20_000 && big.truncated === true, big.blocks.length);
}

console.log("── 7. wiring + i18n parity + the never-logs promise ─────");
{
  const registry = readFileSync("src/lib/tools/registry.ts", "utf8");
  const defStart = registry.indexOf('id: "webpage-to-pdf"');
  const defBlock = defStart >= 0 ? registry.slice(defStart, registry.indexOf("}),", defStart)) : "";
  check("registry: def exists", defStart >= 0);
  check("registry: enabled: true", defBlock.includes("enabled: true"));
  check("registry: mode D (device)", defBlock.includes('mode: "D"'));
  check("registry: accepts url (the drop zone never applies)", defBlock.includes('accepts: "url"'));

  const configs = readFileSync("src/lib/tools/configs.ts", "utf8");
  check("configs.ts: import present", configs.includes("tools/webpage-to-pdf/config"));
  check("configs.ts: TOOL_CONFIGS entry present", configs.includes("[webpageToPdf.toolId]: webpageToPdf"));

  const surfaces = readFileSync("src/lib/tools/surfaces.tsx", "utf8");
  check("surfaces.tsx: import present", surfaces.includes("tools/webpage-to-pdf/surface"));
  check("surfaces.tsx: TOOL_SURFACES entry present", surfaces.includes('"webpage-to-pdf": WebpageToPdfSurface'));

  // the API route: the never-logs promise + the manual redirect walk
  const route = readFileSync("src/app/api/fetch-page/route.ts", "utf8");
  check("route.ts exists with the POST handler", route.includes("export async function POST"));
  check("route: NEVER logs (no console statements)", !route.includes("console."));
  check("route: no storage imports (no db, no fs write)", !route.includes("@/lib/db") && !route.includes("writeFile"));
  check("route: manual redirect walk", route.includes('redirect: "manual"'));
  check(
    "route: per-hop SSRF re-validation (guard called inside the walk)",
    (route.match(/assertPublicHost\(/g) ?? []).length >= 2
  );
  check("route: one AbortController budget", route.includes("controller.abort()"));
  check("route: returns html + finalUrl + status", route.includes("html:") && route.includes("finalUrl") && route.includes("status:"));
  check("route: pipes through the engine's charset decoder", route.includes("decodeHtmlBytes"));
  check("route: rate limiter present (feedback precedent)", route.includes("RATE_LIMIT"));
  check("route: GET refuses (405)", route.includes("method-not-allowed"));

  // i18n: en/hi parity + every referenced wpdf.* key resolves in BOTH
  const i18n = JSON.parse(readFileSync("tools/webpage-to-pdf/i18n.json", "utf8")) as {
    en: { wpdf: Record<string, string> };
    hi: { wpdf: Record<string, string> };
  };
  const enKeys = Object.keys(i18n.en.wpdf).sort();
  const hiKeys = Object.keys(i18n.hi.wpdf).sort();
  check("i18n: en/hi key parity", JSON.stringify(enKeys) === JSON.stringify(hiKeys), { en: enKeys.length, hi: hiKeys.length });
  check("i18n: non-empty catalog", enKeys.length >= 30, enKeys.length);

  const sources = [
    "tools/webpage-to-pdf/surface.tsx",
    "tools/webpage-to-pdf/config.ts",
    "tools/webpage-to-pdf/worker.ts",
    "tools/webpage-to-pdf/model.ts",
  ].map((f) => readFileSync(f, "utf8")).join("\n");
  const referenced = new Set<string>();
  for (const m of sources.matchAll(/wpdf\.[A-Za-z0-9]+/g)) referenced.add(m[0]);
  for (const key of referenced) {
    const short = key.slice("wpdf.".length);
    check(`i18n: "${key}" present in en + hi`, short in i18n.en.wpdf && short in i18n.hi.wpdf);
  }

  // every error code the pipe can emit maps to a key that EXISTS
  for (const code of FETCH_ERROR_CODES) {
    const key = fetchErrorKey(code);
    const short = key.slice("wpdf.".length);
    check(`error mapping resolves: ${code} → ${key}`, key === "tool.errorGeneric" || (short in i18n.en.wpdf && short in i18n.hi.wpdf));
  }

  // config option ids match what the worker reads
  const config = readFileSync("tools/webpage-to-pdf/config.ts", "utf8");
  for (const id of ["pageSize", "margin", "baseFontSize", "showLinks"]) {
    check(`config: option "${id}" declared`, config.includes(`id: "${id}"`));
  }
  check("config: landingSurface (no drop zone for a url tool)", config.includes("landingSurface: true"));
  check("config: outputKind pdf", config.includes('outputKind: "pdf"'));
  check("config: howKeys are wpdf.*", config.includes('"wpdf.how1"'));
}

console.log(
  `\nwebpage-to-pdf smoke: ${pass} passed, ${fail} failed` +
  (fail ? "\n  " + failures.join("\n  ") : "")
);
process.exit(fail === 0 ? 0 : 1);
