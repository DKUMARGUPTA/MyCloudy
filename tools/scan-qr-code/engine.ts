/**
 * Scan QR code engine — payload interpretation (100% PURE).
 *
 * Takes the raw string a decoded QR carries and explains it the way the
 * Generate QR tool builds it: URL, WiFi login, UPI payment, vCard
 * contact, email, phone, WhatsApp, geo location — or honest plain text.
 * The decoder itself (jsQR) lives in the surface because it needs the
 * canvas; everything decidable without the DOM is here, smoke-testable.
 */

export const SCAN_KINDS = [
  "url",
  "wifi",
  "vcard",
  "upi",
  "email",
  "phone",
  "whatsapp",
  "geo",
  "text",
] as const;

export type ScanKind = (typeof SCAN_KINDS)[number];

export interface ScanField {
  /** i18n key suffix under scanqr.field* — resolved by the surface. */
  key: string;
  value: string;
}

export interface ScanParsed {
  kind: ScanKind;
  /** Primary human line (the payload itself, trimmed). */
  primary: string;
  fields: ScanField[];
  /** Safe follow-up link when the payload is a URL (http/https only). */
  actionUrl: string | null;
}

function unescapeWifi(value: string): string {
  // WIFI: values escape \; \, \: \\ — unescape for display.
  return value.replace(/\\([;,:\\])/g, "$1");
}

function parseWifi(data: string): ScanParsed {
  const fields: ScanField[] = [];
  const ssid = /(?:^|;)S:((?:[^\\;]|\\.)*)/.exec(data);
  const pass = /(?:^|;)P:((?:[^\\;]|\\.)*)/.exec(data);
  const type = /(?:^|;)T:((?:[^\\;]|\\.)*)/.exec(data);
  const hidden = /(?:^|;)H:(true|false)/i.exec(data);
  if (ssid) fields.push({ key: "ssid", value: unescapeWifi(ssid[1]) });
  if (type) fields.push({ key: "security", value: type[1] });
  if (pass && pass[1].length > 0)
    fields.push({ key: "password", value: unescapeWifi(pass[1]) });
  if (hidden) fields.push({ key: "hidden", value: hidden[1] });
  return { kind: "wifi", primary: data, fields, actionUrl: null };
}

function parseVcard(data: string): ScanParsed {
  const fields: ScanField[] = [];
  const pick = (key: string): string | null => {
    const re = new RegExp(`^${key}[^:\\r\\n]*:(.*)$`, "mi");
    const m = re.exec(data);
    return m ? m[1].trim() : null;
  };
  const name = pick("FN") ?? pick("N");
  if (name) fields.push({ key: "name", value: name });
  const org = pick("ORG");
  if (org) fields.push({ key: "org", value: org });
  const tel = pick("TEL");
  if (tel) fields.push({ key: "phone", value: tel });
  const email = pick("EMAIL");
  if (email) fields.push({ key: "email", value: email });
  const url = pick("URL");
  if (url) fields.push({ key: "website", value: url });
  return { kind: "vcard", primary: data, fields, actionUrl: null };
}

function parseUpi(data: string): ScanParsed {
  const fields: ScanField[] = [];
  let pa: string | null = null;
  try {
    const url = new URL(data);
    pa = url.searchParams.get("pa");
    const pn = url.searchParams.get("pn");
    const am = url.searchParams.get("am");
    const cu = url.searchParams.get("cu");
    const tn = url.searchParams.get("tn");
    if (pa) fields.push({ key: "upiId", value: pa });
    if (pn) fields.push({ key: "payee", value: pn });
    if (am) fields.push({ key: "amount", value: `${am} ${cu ?? "INR"}` });
    if (tn) fields.push({ key: "note", value: tn });
  } catch {
    if (data.length <= 120) fields.push({ key: "raw", value: data });
  }
  return { kind: "upi", primary: data, fields, actionUrl: null };
}

function parseMailto(data: string): ScanParsed {
  const rest = data.replace(/^mailto:/i, "");
  const [to, query = ""] = rest.split("?");
  const fields: ScanField[] = [];
  if (to) fields.push({ key: "to", value: decodeURIComponent(to) });
  for (const pair of query.split("&")) {
    const [k, v = ""] = pair.split("=");
    if (!k) continue;
    const value = decodeURIComponent(v.replace(/\+/g, " "));
    if (/^subject$/i.test(k) && value) fields.push({ key: "subject", value });
    if (/^body$/i.test(k) && value) fields.push({ key: "body", value });
  }
  return { kind: "email", primary: data, fields, actionUrl: null };
}

function parseQueryFields(data: string, kind: ScanKind): ScanParsed {
  const fields: ScanField[] = [];
  let actionUrl: string | null = null;
  try {
    const url = new URL(data);
    if (kind === "whatsapp") {
      const phone = url.pathname.replace(/^\/+/, "").split("/")[0];
      if (phone) fields.push({ key: "phone", value: `+${phone}` });
      const msg = url.searchParams.get("text");
      if (msg) fields.push({ key: "message", value: msg });
      actionUrl = /^https:\/\/(wa\.me|api\.whatsapp\.com)\//i.test(data)
        ? data
        : null;
    } else if (kind === "geo") {
      const [lat = "", lon = ""] = data.replace(/^geo:/i, "").split(/[?,]/);
      fields.push({ key: "lat", value: lat });
      fields.push({ key: "lon", value: lon });
    } else {
      actionUrl = data;
    }
  } catch {
    actionUrl = null;
  }
  return { kind, primary: data, fields, actionUrl };
}

/** Interpret a decoded QR payload for display. */
export function parseQrPayload(raw: string): ScanParsed {
  const data = raw.trim();
  const lower = data.toLowerCase();
  if (/^wifi:/i.test(data)) return parseWifi(data);
  if (/^begin:vcard/i.test(data)) return parseVcard(data);
  if (/^upi:\/\/pay\?/i.test(data)) return parseUpi(data);
  if (/^mailto:/i.test(data)) return parseMailto(data);
  if (/^tel:/i.test(data)) {
    return {
      kind: "phone",
      primary: data,
      fields: [{ key: "phone", value: data.replace(/^tel:/i, "") }],
      actionUrl: null,
    };
  }
  if (/^(https?:\/\/)?(wa\.me|api\.whatsapp\.com)\//i.test(data)) {
    const normalized = lower.startsWith("http") ? data : `https://${data}`;
    return parseQueryFields(normalized, "whatsapp");
  }
  if (/^geo:/i.test(data)) return parseQueryFields(data, "geo");
  if (/^https?:\/\/[^\s]+$/i.test(data)) {
    return parseQueryFields(data, "url");
  }
  if (/^www\.[^\s]+$/i.test(data)) {
    return {
      kind: "url",
      primary: data,
      fields: [],
      actionUrl: `https://${data}`,
    };
  }
  return { kind: "text", primary: data, fields: [], actionUrl: null };
}
