/**
 * Devanagari font loading for the OWN-engine stamp workers (P6-g) — the
 * pdf-lib-free slice of the old stamp-common/worker-lib. The TTF is fetched
 * from THIS ORIGIN (/fonts/…, self-hosted Noto Sans Devanagari, OFL — see
 * public/fonts/NotoSansDevanagari-OFL.txt), cached per worker lifetime, and
 * embedded as a shaped Type0/CIDFontType2 subset via our own engine.
 */

const DEVA_FONT_URL = "/fonts/NotoSansDevanagari-Regular.ttf";

let devaBytesPromise: Promise<Uint8Array> | null = null;

/**
 * Absolute URL for the font asset, resolved against the worker's REAL base:
 *
 * - Production / static workers are served over http(s), so resolving
 *   against `self.location.href` gives the right origin.
 * - Development (Turbopack) builds workers from `blob:` URLs, where a
 *   relative fetch("/fonts/…") throws "Failed to parse URL" (an opaque
 *   base) — but the blob URL itself embeds the origin, so we recover it
 *   from there.
 */
function devaFontUrl(): string {
  const selfRef = self as { location?: { href?: string } };
  if (!selfRef.location?.href) return DEVA_FONT_URL; // bare runtime (harness)
  try {
    const viaLocation = new URL(DEVA_FONT_URL, selfRef.location.href);
    if (viaLocation.protocol === "http:" || viaLocation.protocol === "https:") {
      return viaLocation.href;
    }
  } catch {
    // opaque base (blob: workers) — fall through to the blob-origin recovery
  }
  const blobOrigin = /^blob:(https?:\/\/[^/]+)/i.exec(selfRef.location.href);
  if (blobOrigin) return `${blobOrigin[1]}${DEVA_FONT_URL}`;
  return DEVA_FONT_URL; // last resort — let fetch try its own base
}

/** Fetches the self-hosted Devanagari TTF once per worker lifetime. */
export function loadDevanagariBytes(): Promise<Uint8Array> {
  if (!devaBytesPromise) {
    devaBytesPromise = fetch(devaFontUrl()).then(async (res) => {
      if (!res.ok) throw new Error("devanagari-font-fetch");
      return new Uint8Array(await res.arrayBuffer());
    });
    devaBytesPromise.catch(() => {
      devaBytesPromise = null; // retry on the next run
    });
  }
  return devaBytesPromise;
}

/** Strips path separators + unsafe chars from a download display name. */
export function safeStampBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}
