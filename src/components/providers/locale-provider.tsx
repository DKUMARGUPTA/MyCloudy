"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";

import {
  clearSessionLocale,
  getStoredLocale,
  LOCALE_CHANGE_EVENT,
  LOCALE_STORAGE_KEY,
  translate,
  type Locale,
  type TranslateParams,
} from "@/i18n";

/**
 * Locale provider backed by localStorage as an external store
 * (useSyncExternalStore — hydration-safe, no setState-in-effect).
 *
 * During SSR/hydration the snapshot is null -> locale falls back to "en";
 * right after hydration React re-syncs with the client snapshot, so a stored
 * "hi" preference applies without any hydration mismatch.
 *
 * R24: getStoredLocale honors the URL-wins session override (see i18n
 * setSessionLocale) — an explicit setLocale below CLEARS it, so a user
 * choice always wins from that moment on.
 */

const LOCALE_EVENT = LOCALE_CHANGE_EVENT;

function subscribeToLocale(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  window.addEventListener(LOCALE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(LOCALE_EVENT, callback);
  };
}

function getLocaleSnapshot(): Locale | null {
  return getStoredLocale();
}

function getLocaleServerSnapshot(): Locale | null {
  return null;
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: TranslateParams) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const storedLocale = useSyncExternalStore(
    subscribeToLocale,
    getLocaleSnapshot,
    getLocaleServerSnapshot
  );
  const locale: Locale = storedLocale ?? "en";

  // Sync <html lang> — external system update, no React state involved.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    /* An explicit user switch wins over the URL-wins session override. */
    clearSessionLocale();
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      /* storage may be unavailable (private mode) — in-memory value still applies */
    }
    window.dispatchEvent(new Event(LOCALE_EVENT));
  }, []);

  const t = useCallback(
    (key: string, params?: TranslateParams) => translate(locale, key, params),
    [locale]
  );

  const value = useMemo(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within a LocaleProvider");
  }
  return context;
}
