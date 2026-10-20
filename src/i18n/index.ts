import en from "./en.json";
import hi from "./hi.json";

/**
 * DocoPDF i18n core (PRD §12.3).
 * en + hi (Devanagari) message catalogs with {param} interpolation.
 *
 * NOTE (deploy): in the Vercel deployment, locales are path-based (/ and /hi)
 * via next-intl routing. In this sandbox only "/" is user-visible, so the
 * active locale is app state persisted in localStorage (see LocaleProvider).
 */

export const LOCALE_STORAGE_KEY = "docopdf-locale";

export type Locale = "en" | "hi";

export const locales: readonly Locale[] = ["en", "hi"] as const;

export type TranslateParams = Record<string, string | number>;

const dictionaries: Record<Locale, unknown> = { en, hi };

function lookup(dict: unknown, key: string): string | undefined {
  let current: unknown = dict;
  for (const part of key.split(".")) {
    if (
      current !== null &&
      typeof current === "object" &&
      part in (current as Record<string, unknown>)
    ) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof current === "string" ? current : undefined;
}

/**
 * ICU-lite plural subset: `{n, plural, =0 {none} =1 {one thing} other {# things}}`
 * — any number of `=N` exact branches before the required `other`. `#` inside
 * a branch is replaced by the number. Anything that doesn't match stays
 * untouched (plain {param} replacement below still applies).
 */
const PLURAL_RE = /\{(\w+),\s*plural,\s*((?:=\d+\s*\{[^{}]*\}\s*)*)other\s*\{([^{}]*)\}\}/g;
const EXACT_RE = /=(\d+)\s*\{([^{}]*)\}/g;

function applyParams(value: string, params: TranslateParams): string {
  // iOS-SAFE: no matchAll (Safari 13+) and no replaceAll (Safari 13.1+) —
  // this is the hottest function in the app (every t() with params), and on
  // older iPhones it crashed hydration with a white screen. RegExp /g
  // exec-loops + split/join are supported everywhere (ES3+).
  let out = value.replace(
    PLURAL_RE,
    (_match, name: string, exacts: string, other: string) => {
      const n = Number(params[name]);
      let branch = other;
      if (Number.isFinite(n)) {
        // First matching =N branch wins; otherwise `other`.
        EXACT_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = EXACT_RE.exec(exacts)) !== null) {
          if (Number(m[1]) === n) {
            branch = m[2];
            break;
          }
        }
      }
      return branch.split("#").join(String(n));
    }
  );
  for (const [name, replacement] of Object.entries(params)) {
    out = out.split(`{${name}}`).join(String(replacement));
  }
  return out;
}

/** Translate a dotted key with optional {param} interpolation. Falls back en -> key. */
export function translate(
  locale: Locale,
  key: string,
  params?: TranslateParams
): string {
  const value =
    lookup(dictionaries[locale], key) ?? lookup(dictionaries.en, key);
  if (value === undefined) return key;
  if (params) return applyParams(value, params);
  return value;
}

/** Read the persisted locale (client only). */
export function getStoredLocale(): Locale | null {
  if (typeof window === "undefined") return null;
  try {
    const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return saved === "en" || saved === "hi" ? saved : null;
  } catch {
    return null;
  }
}
