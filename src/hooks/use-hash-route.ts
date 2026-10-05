"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

/**
 * Hash-based view router for the single visible route "/" (sandbox note:
 * path routes are restored at Vercel deploy time; see worklog §2).
 *
 * Routes:  "#/"            -> home
 *          "#/tools"       -> all tools   (optional ?q=<search>)
 *          "#/tools/<cat>" -> category    (optional ?q=<search>)
 *          "#/tool/<id>"   -> tool workspace (ToolShell; ?q ignored)
 * Anchors: "#<id>" (not starting with "#/") -> home view + scroll to <id>.
 * Works with browser back/forward via the hashchange event, modeled as an
 * external store (useSyncExternalStore) — hydration-safe, no effects
 * writing React state.
 */

export interface HashRoute {
  view: "home" | "tools" | "tool";
  category?: string;
  query?: string;
  /** Enabled tool id for the "#/tool/<id>" view. */
  toolId?: string;
  /** Anchor id when the hash is a plain "#section" link. */
  anchor?: string;
}

export function parseHash(hash: string): HashRoute {
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
  if (path.startsWith("tools/")) {
    return { view: "tools", category: path.slice("tools/".length), query };
  }
  if (path.startsWith("tool/")) {
    return { view: "tool", toolId: path.slice("tool/".length) };
  }
  return { view: "home" };
}

function subscribeToHash(callback: () => void): () => void {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

function hashSnapshot(): string {
  return window.location.hash;
}

function hashServerSnapshot(): string {
  return "";
}

/**
 * Hash navigation primitive: assigns location.hash so the hashchange event
 * fires (History-API pushState would NOT notify the route store).
 * Module-level by design — safe to call from any component or hook.
 */
export function navigateToHash(to: string): void {
  if (window.location.hash === to) {
    const next = parseHash(to);
    if (next.anchor) {
      document
        .getElementById(next.anchor)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    return;
  }
  window.location.hash = to;
}

export function useHashRoute(): {
  route: HashRoute;
  navigate: (to: string) => void;
} {
  const hash = useSyncExternalStore(
    subscribeToHash,
    hashSnapshot,
    hashServerSnapshot
  );
  const route = useMemo(() => parseHash(hash), [hash]);

  // Scroll behavior on route changes — a DOM side effect only (no state):
  // view switches go to top; anchors scroll to their section after the
  // home view mounts. Same-view anchor clicks also fire here, which simply
  // re-scrolls to the same element the browser already scrolled to.
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
  }, [route]);

  const navigate = useCallback((to: string) => navigateToHash(to), []);

  return { route, navigate };
}

/** Route hash helpers shared by header, tab bar and views. */
export const ROUTES = {
  home: "#/",
  tools: "#/tools",
  category: (categoryId: string) => `#/tools/${categoryId}`,
  tool: (toolId: string) => `#/tool/${toolId}`,
  toolsWithQuery: (query: string) => `#/tools?q=${encodeURIComponent(query)}`,
} as const;
