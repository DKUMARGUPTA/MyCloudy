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

/** Translate a dotted key with optional {param} interpolation. Falls back en -> key. */
export function translate(
  locale: Locale,
  key: string,
  params?: TranslateParams
): string {
  let value =
    lookup(dictionaries[locale], key) ?? lookup(dictionaries.en, key);
  if (value === undefined) return key;
  if (params) {
    for (const [name, replacement] of Object.entries(params)) {
      value = value.replaceAll(`{${name}}`, String(replacement));
    }
  }
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
