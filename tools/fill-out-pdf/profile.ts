/**
 * Fill out PDF forms — auto-fill profile (PRD §8.2 "Fill out": "auto-fill
 * saved info (name, address, email) from local profile").
 *
 * The profile lives ONLY in this browser's localStorage — device-only by
 * design, never uploaded, never sent to any server. Field-name matching
 * is a heuristic on the normalized field label (Latin + common Hindi
 * words); unmatched fields are left untouched.
 */

export interface FillProfile {
  name: string;
  email: string;
  phone: string;
  organization: string;
  address: string;
}

const STORAGE_KEY = "docopdf.fill-profile";
const PROFILE_FIELDS: (keyof FillProfile)[] = [
  "name",
  "email",
  "phone",
  "organization",
  "address",
];

export const EMPTY_PROFILE: FillProfile = {
  name: "",
  email: "",
  phone: "",
  organization: "",
  address: "",
};

export function loadFillProfile(): FillProfile {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY_PROFILE };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return { ...EMPTY_PROFILE };
    }
    const record = parsed as Record<string, unknown>;
    const out = { ...EMPTY_PROFILE };
    for (const key of PROFILE_FIELDS) {
      const value = record[key];
      if (typeof value === "string") out[key] = value.slice(0, 200);
    }
    return out;
  } catch {
    return { ...EMPTY_PROFILE };
  }
}

export function saveFillProfile(profile: FillProfile): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Private mode / storage full — the tool still works, just no memory.
  }
}

export function clearFillProfile(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore — nothing to clean.
  }
}

export function profileHasAny(profile: FillProfile): boolean {
  return PROFILE_FIELDS.some((key) => profile[key].trim() !== "");
}

/** Normalize a field label: lowercase, keep Latin digits/letters + Devanagari. */
function normalize(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9\u0900-\u097f]/g, "");
}

/**
 * Heuristic match of a form field LABEL to a profile value. Returns ""
 * when nothing matches. Only the human-visible label is matched — never
 * the fully qualified name (its path segments like "applicant." would
 * false-match every field under them).
 *
 * Order matters (first match wins): distinctive contact details first,
 * then name parts, then the generic name as an EXACT label match (so
 * "essay" or "pincode" under "applicant.…" never gets a name).
 */
export function matchProfileValue(
  fieldLabel: string,
  profile: FillProfile
): string {
  const n = normalize(fieldLabel);
  if (n === "") return "";
  const words = profile.name.trim().split(/\s+/).filter((w) => w !== "");
  const first = words[0] ?? "";
  const last = words.length > 1 ? words[words.length - 1] : "";
  const is = (pattern: RegExp) => pattern.test(n);

  // Contact details (distinctive — safe as substrings).
  if (is(/(e?mail|ईमेल|इमेल)/)) return profile.email.trim();
  if (
    is(/(phone|mobile|contactno|contactnumber|whatsapp|telephone|telno|mobno|मोबाइल|फोन)/)
  ) {
    return profile.phone.trim();
  }
  // Name parts before the generic name ("surname" contains "name";
  // "fname"/"lname" exact-only so "fullname" is never a surname).
  if (is(/(firstname|givenname|forename|पहलानाम)/) || n === "fname") {
    return first;
  }
  if (is(/(lastname|surname|familyname|उपनाम|अंतिमनाम)/) || n === "lname") {
    return last;
  }
  // Organization before address.
  if (
    is(
      /(organization|organisation|company|employer|firm|institute|college|school|office|संस्था|कंपनी)/
    )
  ) {
    return profile.organization.trim();
  }
  if (is(/(address|addr|residence|street|पता)/)) {
    return profile.address.trim();
  }
  // Generic name: EXACT label match only — "Applicant Name" →
  // "applicantname", "नाम" → "नाम". Never substring (would hit
  // "dateofbirth", "essay", …).
  if (
    n === "name" ||
    n === "fullname" ||
    n === "applicantname" ||
    n === "yourname" ||
    n === "applicant" ||
    n === "नाम" ||
    n === "पूरानाम"
  ) {
    return profile.name.trim();
  }
  return "";
}
