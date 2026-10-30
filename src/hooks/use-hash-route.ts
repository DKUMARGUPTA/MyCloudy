"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";

import { getStoredLocale, type Locale } from "@/i18n";

/**
 * App-shell view router — REAL PATHS with SPA behavior (P7-SEO R17).
 *
 * History: this router was hash-based ("#/tool/x") because the app began as
 * a single-view SPA. Real crawlable paths ("/tool/<id>", "/hi/…") were added
 * later as server routes, but every internal <a> still pointed at "#/…", so
 * Google's rendered link graph contained ZERO links to the 116 tool URLs —
 * no internal link equity, sitemap-only discovery. R17 flips the model:
 *
 *   - ROUTES.* now return real paths ("/tool/merge-pdf", "/tools", "/about")
 *     so crawlers see (and users can copy) genuine URLs in the DOM.
 *   - A document-level click interceptor in AppShell turns those same
 *     anchors into history.pushState navigation — the SPA feel is kept,
 *     no full page loads between views.
 *   - The route store derives its state from location.pathname (+"?q="),
 *     re-synced on popstate (back/forward) and a custom navigation event.
 *
 * Route shapes (HashRoute kept the name to avoid churning 20 call sites):
 *   "/"                  -> home
 *   "/tools" (+ "?q=")   -> all tools
 *   "/tools/<cat>"       -> category (+ "?q=")
 *   "/tool/<id>"         -> tool workspace
 *   "/about|contact|privacy|terms" -> static page
 *   "/hi/…"              -> identical shapes; the /hi prefix only marks the
 *                           Hindi mirror (the locale itself lives in the
 *                           locale provider).
 *
 * Backward compatibility:
 *   - LEGACY BOOKMARKS: "https://docopdf.com/#/tool/x" still routes — when
 *     the real path is a home shell and the hash starts with "#/", the hash
 *     drives routing (see routeKeySnapshot).
 *   - OLD CALL STRINGS: navigateToHash() accepts both real paths and legacy
 *     "#/…" strings, converting the latter to their real-path equivalents.
 *   - PLAIN ANCHORS ("#why", "#main"): never touch the route key — the
 *     snapshot ignores hashes that don't start with "#/", so native anchor
 *     scrolling cannot jump the app back to the home view.
 */

export interface HashRoute {
  view: "home" | "tools" | "tool" | "page" | "account";
  category?: string;
  query?: string;
  /** Enabled tool id for the "/tool/<id>" view. */
  toolId?: string;
  /** Static page id (about|contact|privacy|terms) for the "/<page>" view. */
  pageId?: string;
  /** Anchor id — legacy plain-"#section" hashes only (see file header). */
  anchor?: string;
}

/** Static pages that live at the site root (mirrors SITE.staticPages). */
const STATIC_PAGE_IDS = ["about", "contact", "privacy", "terms"] as const;

const ROUTE_EVENT = "docopdf:route-change";

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

function parseLegacyHash(hash: string): HashRoute {
  if (!hash || hash === "#" || hash === "#/") return { view: "home" };

  if (!hash.startsWith("#/")) {
    // Plain anchor like #categories / #how / #why.
    return { view: "home", anchor: hash.slice(1) };
  }

  const [path, search] = hash.slice(2).split("?");
  const query = search
    ? new URLSearchParams(search).get("q") ?? undefined
    : undefined;

  if (path === "tools") return { view: "tools", query };
  if (path === "account") return { view: "account" };
  if (path.startsWith("tools/")) {
    return { view: "tools", category: path.slice("tools/".length), query };
  }
  if (path.startsWith("tool/")) {
    return { view: "tool", toolId: path.slice("tool/".length) };
  }
  if (path.startsWith("page/")) {
    return { view: "page", pageId: path.slice("page/".length) };
  }
  return { view: "home" };
}

/** @deprecated Kept for the one legacy export some tools still import. */
export const parseHash = parseLegacyHash;

/**
 * Parse a real-path route key ("<pathname><search>", optionally carrying a
 * legacy "#/…" hash on home shells). "/hi" prefixes are stripped — the
 * Hindi mirror renders the identical views, and the locale itself lives
 * in the locale provider, not in the route.
 */
export function parseRouteKey(key: string): HashRoute {
  if (!key) return { view: "home" };

  let rest = key;

  // Legacy hash routing on the home shells ("/#/tool/x", "/hi#/tools").
  const hashAt = rest.indexOf("#/");
  if (hashAt !== -1) {
    return parseLegacyHash(rest.slice(hashAt));
  }

  // Strip the Hindi mirror prefix.
  if (rest === "/hi" || rest.startsWith("/hi/")) {
    rest = rest.slice("/hi".length) || "/";
  }

  // Split off ?query.
  const searchAt = rest.indexOf("?");
  const search = searchAt === -1 ? "" : rest.slice(searchAt + 1);
  let path = searchAt === -1 ? rest : rest.slice(0, searchAt);
  const query = search
    ? new URLSearchParams(search).get("q") ?? undefined
    : undefined;

  if (path.endsWith("/") && path !== "/") path = path.slice(0, -1);

  if (path === "/" || path === "") return { view: "home" };
  if (path === "/tools") return { view: "tools", query };
  if (path === "/account") return { view: "account" };
  if (path.startsWith("/tools/")) {
    return { view: "tools", category: path.slice("/tools/".length), query };
  }
  if (path.startsWith("/tool/")) {
    return { view: "tool", toolId: path.slice("/tool/".length) };
  }
  const staticId = path.slice(1);
  if (
    path.startsWith("/") &&
    !path.includes("/", 1) &&
    (STATIC_PAGE_IDS as readonly string[]).includes(staticId)
  ) {
    return { view: "page", pageId: staticId };
  }
  return { view: "home" };
}

/* ------------------------------------------------------------------ */
/* External store                                                      */
/* ------------------------------------------------------------------ */

function subscribeToRoute(callback: () => void): () => void {
  window.addEventListener("popstate", callback);
  window.addEventListener("hashchange", callback);
  window.addEventListener(ROUTE_EVENT, callback);
  return () => {
    window.removeEventListener("popstate", callback);
    window.removeEventListener("hashchange", callback);
    window.removeEventListener(ROUTE_EVENT, callback);
  };
}

/**
 * The store key: the real path + query, except on the home shells where a
 * legacy "#/…" bookmark hash still drives routing. Plain anchors ("#why")
 * and hashes on non-home paths are deliberately ignored.
 */
function routeKeySnapshot(): string {
  const { pathname, search, hash } = window.location;
  if (
    hash.startsWith("#/") &&
    (pathname === "/" || pathname === "/hi")
  ) {
    return pathname + hash;
  }
  return pathname + search;
}

function routeKeyServerSnapshot(): string {
  return "";
}

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

/** Current UI locale for path prefixing (provider's source of truth —
 * getStoredLocale honors the URL-wins session override, R24). */
function currentLocale(): Locale {
  const active = getStoredLocale();
  if (active) return active;
  return window.location.pathname.startsWith("/hi") ? "hi" : "en";
}



/** Map a legacy "#/…" string to its real-path equivalent. */
function legacyHashToPath(to: string): string {
  const route = parseLegacyHash(to);
  switch (route.view) {
    case "tools":
      return route.category
        ? `/tools/${route.category}`
        : withQuery("/tools", route.query);
    case "tool":
      return `/tool/${route.toolId ?? ""}`;
    case "page":
      // Static pages live at the root ("/about"), not "/page/about".
      return `/${route.pageId ?? ""}`;
    case "account":
      return "/account";
    default:
      return withQuery("/", route.query);
  }
}

function withQuery(path: string, query?: string): string {
  return query ? `${path}?q=${encodeURIComponent(query)}` : path;
}

/**
 * Navigate the SPA. Accepts real paths ("/tool/merge-pdf", "/tools?q=x")
 * and legacy "#/…" strings (converted); plain "#anchor" strings scroll
 * natively without touching the route. Same-path navigations scroll to
 * top (or to the anchor) instead of pushing history entries.
 *
 * (Name kept from the hash era — 20+ call sites import it.)
 */
export function navigateToHash(to: string): void {
  if (!to) return;

  /* Plain in-page anchor — native behavior, router stays put. */
  if (to.startsWith("#") && !to.startsWith("#/")) {
    const el = document.getElementById(to.slice(1));
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (window.location.hash !== to) {
      history.replaceState(null, "", window.location.pathname + to);
    }
    return;
  }

  /* Legacy hash route string — convert to its real path. */
  const target = to.startsWith("#/") ? legacyHashToPath(to) : to;

  /* Real path (may carry ?query and/or #anchor). Idempotent: an existing
   * /hi mirror prefix is normalized first (R19 Phase 5 — SSR'd /hi links
   * now carry the prefix, and prefixing "/hi/tool/x" again would produce
   * "/hi/hi/tool/x"). */
  const url = new URL(target, window.location.origin);
  const prefixed = withLocalePrefix(url.pathname) + url.search + url.hash;

  if (prefixed === window.location.pathname + window.location.search + window.location.hash) {
    const anchor = url.hash.slice(1);
    if (anchor) {
      document
        .getElementById(anchor)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    return;
  }

  window.history.pushState(null, "", prefixed);
  window.dispatchEvent(new Event(ROUTE_EVENT));
}

/** "/tool/x" -> "/hi/tool/x" when the UI is Hindi (idempotent — an
 * existing /hi prefix is normalized away first). */
function withLocalePrefix(path: string): string {
  const locale = currentLocale();
  let base = path;
  if (base === "/hi") base = "/";
  else if (base.startsWith("/hi/")) base = base.slice("/hi".length);
  if (locale !== "hi") return base;
  if (base === "/") return "/hi";
  return `/hi${base}`;
}

/** Fire the route-change event so every useSyncExternalStore subscriber
 * (route store + URL-locale consumers) re-reads location. */
export function notifyRouteChanged(): void {
  window.dispatchEvent(new Event(ROUTE_EVENT));
}

/* ------------------------------------------------------------------ */
/* URL locale (R19 Phase 5 — SSR locale-prefixed links)                */
/* ------------------------------------------------------------------ */

/** The locale the CURRENT URL is served under (path-derived, not the i18n
 * store — the i18n locale is "en" during SSR by design, while the URL's
 * /hi-ness is known from the server-rendered boot). This is what internal
 * link hrefs are prefixed with, so the raw HTML of /hi pages carries
 * /hi-prefixed links for crawlers and no-JS visitors. */
export type UrlLocale = "en" | "hi";

/** Derive the URL locale from a route store key ("" during SSR → boot). */
export function urlLocaleOf(key: string, boot: UrlLocale = "en"): UrlLocale {
  if (!key) return boot;
  return key === "/hi" || key.startsWith("/hi/") ? "hi" : "en";
}

const UrlLocaleContext = createContext<UrlLocale>("en");

/** Current URL locale — AppShell provides the value (SSR-stable boot +
 * live path re-syncs). Defaults to "en" outside the shell. */
export function useUrlLocale(): UrlLocale {
  return useContext(UrlLocaleContext);
}

/** Locale-aware ROUTES: identical shapes, but every path carries the
 * current URL's locale prefix. Use inside the AppShell tree; the static
 * ROUTES below stays for locale-agnostic contexts. */
export function localizedRoutes(urlLocale: UrlLocale) {
  const p = (path: string): string =>
    urlLocale === "hi" ? (path === "/" ? "/hi" : `/hi${path}`) : path;
  return {
    home: p("/"),
    tools: p("/tools"),
    category: (categoryId: string) => p(`/tools/${categoryId}`),
    tool: (toolId: string) => p(`/tool/${toolId}`),
    page: (pageId: string) => p(`/${pageId}`),
    account: p("/account"),
    toolsWithQuery: (query: string) =>
      `${p("/tools")}?q=${encodeURIComponent(query)}`,
  } as const;
}

export function useLocalizedRoutes(): ReturnType<typeof localizedRoutes> {
  return localizedRoutes(useUrlLocale());
}

/* ------------------------------------------------------------------ */
/* Hook                                                                */
/* ------------------------------------------------------------------ */

export function useHashRoute(initial?: HashRoute): {
  route: HashRoute;
  navigate: (to: string) => void;
  /** Raw store key ("" during SSR) — for URL-locale derivation. */
  routeKey: string;
} {
  const key = useSyncExternalStore(
    subscribeToRoute,
    routeKeySnapshot,
    routeKeyServerSnapshot
  );

  const route = useMemo<HashRoute>(() => {
    if (!key) {
      return initial ?? { view: "home" };
    }
    return parseRouteKey(key);
  }, [key, initial]);

  // Scroll behavior on route changes — a DOM side effect only (no state):
  // view switches go to top; anchors scroll to their section after the
  // view mounts. Same-view anchor clicks simply re-scroll.
  useEffect(() => {
    if (route.anchor) {
      const frame = requestAnimationFrame(() => {
        document
          .getElementById(route.anchor as string)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      return () => cancelAnimationFrame(frame);
    }
    window.scrollTo(0, 0);
    return undefined;
  }, [key, route.anchor]);

  const navigate = useCallback((to: string) => navigateToHash(to), []);

  return { route, navigate, routeKey: key };
}

export { UrlLocaleContext };

/**
 * Route helpers shared by header, tab bar, views and cards — REAL PATHS
 * (R17): these values land in <a href> so crawlers finally see internal
 * links to every tool page. The AppShell click interceptor turns them
 * into SPA navigation for users.
 */
export const ROUTES = {
  home: "/",
  tools: "/tools",
  category: (categoryId: string) => `/tools/${categoryId}`,
  tool: (toolId: string) => `/tool/${toolId}`,
  /** Static content page (about | contact | privacy | terms). */
  page: (pageId: string) => `/${pageId}`,
  /** Account settings (private — noindex SSR shell). */
  account: "/account",
  toolsWithQuery: (query: string) => `/tools?q=${encodeURIComponent(query)}`,
} as const;
