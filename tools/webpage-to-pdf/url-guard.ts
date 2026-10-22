/**
 * Webpage to PDF (RB4-f) — pure URL validation + SSRF guard helpers.
 *
 * ZERO runtime imports (no Node, no DOM, no Next): this module is the
 * single source of truth shared by
 *   - src/app/api/fetch-page/route.ts (the pass-through fetch pipe),
 *   - tools/webpage-to-pdf/worker.ts   (the on-device renderer),
 *   - tools/webpage-to-pdf/surface.tsx (the landing input + run gate),
 *   - scripts/smoke-webpage-to-pdf.ts  (the bun smoke — imports it
 *     WITHOUT any Next runtime, which is why it must stay pure).
 *
 * Policy (honest, documented):
 *  - only http: and https: URLs are accepted — ftp:, file:, data:,
 *    javascript: and everything else are rejected before any request;
 *  - the hostname is resolved by the CALLER (dns.promises.lookup all)
 *    and EVERY resolved IP must be public: loopback, private, link-
 *    local, unique-local and unspecified ranges are refused on both
 *    families (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 0/8
 *    plus ::1, fc00::/7, fe80::/10 and ::ffff:0:0/96-mapped v4);
 *  - WHATWG URL normalizes IDN hostnames to punycode (xn--…) so
 *    hostname-derived names are always ASCII — we keep that honest
 *    instead of inventing a unicode hostname story.
 */

/* ------------------------------------------------------------------ */
/* URL validation                                                       */
/* ------------------------------------------------------------------ */

export type UrlCheck =
  | { ok: true; url: URL }
  | { ok: false; code: "invalid-url" };

/**
 * Strict http(s) validation: explicit `new URL` parse (no regex guessing)
 * + protocol allowlist. Accepts anything the WHATWG URL parser accepts
 * with a hostname, rejects empty hosts ("https:///path") and every other
 * scheme.
 */
export function validatePageUrl(raw: string): UrlCheck {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "" || value.length > 2048) return { ok: false, code: "invalid-url" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, code: "invalid-url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, code: "invalid-url" };
  }
  if (url.hostname === "" || url.hostname === ".") {
    return { ok: false, code: "invalid-url" };
  }
  return { ok: true, url };
}

/** Cheap client-side shape check (regex + protocol) for instant feedback. */
export function urlShapeOk(raw: string): boolean {
  return /^https?:\/\/[^\s/$.?#][^\s]*$/i.test(raw.trim());
}

/* ------------------------------------------------------------------ */
/* IP parsing                                                           */
/* ------------------------------------------------------------------ */

/** "a.b.c.d" → uint32, or null when not a full dotted quad. */
function parseIpv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (part === "" || part.length > 3 || !/^\d+$/.test(part)) return null;
    const octet = Number.parseInt(part, 10);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/** IPv6 text → 8×16-bit groups, or null. Handles "::" and embedded v4 tails. */
function parseIpv6(ip: string): number[] | null {
  let text = ip.trim().toLowerCase();
  if (text === "") return null;
  // strip a zone id (fe80::1%eth0) — never routable, never a target
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  // strip the brackets the WHATWG URL keeps on literal v6 hostnames
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);

  // embedded IPv4 tail (::ffff:192.168.0.1) — it counts as TWO groups
  if (text.includes(".")) {
    const lastColon = text.lastIndexOf(":");
    if (lastColon >= 0) {
      const tail = text.slice(lastColon + 1);
      if (tail.includes(".")) {
        const v4 = parseIpv4(tail);
        if (v4 === null) return null;
        const v4tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
        return parseIpv6Core(text.slice(0, lastColon + 1), v4tail);
      }
    }
  }
  return parseIpv6Core(text, []);
}

function parseIpv6Core(text: string, v4tail: number[]): number[] | null {
  // a removed embedded v4 tail leaves one trailing ":" — strip it unless
  // it is the closing half of "::" ("::" + "1.2.3.4" must stay)
  if (v4tail.length > 0 && text.endsWith(":") && !text.endsWith("::")) {
    text = text.slice(0, -1);
  }
  const doubleColon = text.indexOf("::");
  if (doubleColon >= 0) {
    if (text.indexOf("::", doubleColon + 1) >= 0) return null; // only one "::"
    const headText = text.slice(0, doubleColon);
    const tailText = text.slice(doubleColon + 2);
    const head = headText === "" ? [] : hexGroups(headText);
    const tail = tailText === "" ? [] : hexGroups(tailText);
    if (head === null || tail === null) return null;
    const fill = 8 - head.length - tail.length - v4tail.length;
    if (fill < 1) return null; // "::" must stand for at least one zero group
    return [...head, ...new Array<number>(fill).fill(0), ...tail, ...v4tail];
  }
  const groups = hexGroups(text);
  if (groups === null) return null;
  if (groups.length + v4tail.length !== 8) return null;
  return [...groups, ...v4tail];
}

/** Split on ":" and parse every group; null if ANY group is invalid. */
function hexGroups(rawText: string): number[] | null {
  const parts = rawText.split(":");
  const out: number[] = [];
  for (const p of parts) {
    const g = hexGroup(p);
    if (g === null) return null;
    out.push(g);
  }
  return out;
}

function hexGroup(raw: string): number | null {
  if (raw === "" || raw.length > 4 || !/^[0-9a-f]+$/.test(raw)) return null;
  return Number.parseInt(raw, 16);
}

/* ------------------------------------------------------------------ */
/* Range checks                                                         */
/* ------------------------------------------------------------------ */

const v4In = (ip: number, cidr: number, bits: number): boolean =>
  (ip >>> (32 - bits)) === (cidr >>> (32 - bits));

const V4_BLOCKLIST: { cidr: number; bits: number; name: string }[] = [
  { cidr: 0x00000000, bits: 8, name: "unspecified 0.0.0.0/8" },
  { cidr: 0x0a000000, bits: 8, name: "private 10.0.0.0/8" },
  { cidr: 0x7f000000, bits: 8, name: "loopback 127.0.0.0/8" },
  { cidr: 0xac100000, bits: 12, name: "private 172.16.0.0/12" },
  { cidr: 0xc0a80000, bits: 16, name: "private 192.168.0.0/16" },
  { cidr: 0xa9fe0000, bits: 16, name: "link-local 169.254.0.0/16" },
];

/**
 * true when the IP sits in a range that must never be fetched: v4
 * loopback/private/link-local/unspecified + the v6 equivalents (::1,
 * fc00::/7, fe80::/10) plus IPv4-mapped v6 (::ffff:0:0/96 → the v4
 * blocklist applies). Fail-closed: anything unparseable counts as
 * private. CGNAT 100.64/10 is deliberately NOT blocked — it is not
 * routable from inside this server and blocking it would break
 * legitimately carrier-hosted pages.
 */
export function isPrivateIp(ip: string): boolean {
  const text = ip.trim().toLowerCase();
  if (text === "") return true; // nothing resolved = nothing to allow

  const v4 = parseIpv4(text);
  if (v4 !== null) {
    for (const range of V4_BLOCKLIST) {
      if (v4In(v4, range.cidr, range.bits)) return true;
    }
    return false;
  }

  const v6 = parseIpv6(text);
  if (v6 === null) return true; // unparseable → refuse (honest fail-closed)
  const [g0, g1] = v6;
  if (g0 === undefined || g1 === undefined) return true;

  // ::1 exact loopback, :: unspecified — both all-zero families
  if (v6.every((g) => g === 0)) return true;
  if (v6[7] === 1 && v6.slice(0, 7).every((g) => g === 0)) return true;
  // IPv4-mapped ::ffff:0:0/96 → the embedded v4 must itself be public
  if (
    g0 === 0 && g1 === 0 && v6[2] === 0 && v6[3] === 0 &&
    v6[4] === 0 && v6[5] === 0xffff
  ) {
    const low = v6[6] ?? 0;
    const high = v6[7] ?? 0;
    return isPrivateIp(
      `${(high >>> 8) & 0xff}.${high & 0xff}.${(low >>> 8) & 0xff}.${low & 0xff}`
    );
  }
  // unique-local fc00::/7 (fc00.. fdff first group)
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfe80) return true;
  return false;
}

/**
 * Check a whole DNS resolution: any private IP in the list → blocked
 * with the offending address reported (fail-closed on the whole set —
 * dual-stack answers must be ALL public to pass).
 */
export function checkResolvedIps(
  ips: string[]
): { ok: true } | { ok: false; ip: string } {
  for (const ip of ips) {
    if (isPrivateIp(ip)) return { ok: false, ip };
  }
  return { ok: true };
}

/** true for a bare IP literal hostname (no scheme, no port). */
export function isIpLiteral(hostname: string): boolean {
  return parseIpv4(hostname) !== null || parseIpv6(hostname) !== null;
}
