"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { SiteHeader } from "@/components/doco/site-header";
import { SiteFooter } from "@/components/doco/site-footer";
import { AnnouncementBanner } from "@/components/doco/home/announcement-banner";
import { Hero } from "@/components/doco/home/hero";
import { Steps } from "@/components/doco/home/steps";
import { Categories } from "@/components/doco/home/categories";
import { Why } from "@/components/doco/home/why";
import { Modes } from "@/components/doco/home/modes";
import { PopularTools } from "@/components/doco/home/popular-tools";
import { Faq } from "@/components/doco/home/faq";
import { RecentFiles } from "@/components/doco/home/recent-files";
import { ToolsView } from "@/components/doco/tools/tools-view";
import { ToolView } from "@/components/doco/tool/tool-view";
import { StaticPageView } from "@/components/doco/page/static-page";
import { AccountPage } from "@/components/doco/account/account-page";
import { PricingModal } from "@/components/doco/billing/pricing-modal";
import { SearchPalette } from "@/components/doco/search/search-palette";
import { CookieBanner } from "@/components/doco/cookie-banner";
import { BottomTabBar } from "@/components/doco/bottom-tab-bar";
import { AuthModal } from "@/components/doco/auth/auth-modal";
import { useI18n } from "@/components/providers/locale-provider";
import { useHashRoute, navigateToHash, urlLocaleOf, UrlLocaleContext, type HashRoute } from "@/hooks/use-hash-route";
import { anchorClickHandler } from "@/lib/anchor";
import { track } from "@/lib/analytics/ga4";
import { bootstrapAuth } from "@/lib/auth-client";
import { ALL_TOOLS } from "@/lib/tools/registry";
import { LOCALE_STORAGE_KEY, setSessionLocale } from "@/i18n";

/* GA4 tool_view dedupe — see the tool_view effect below for the contract. */
let lastToolView: string | null = null;

/**
 * DocoPDF app shell — the single visible application, shared by every
 * route (/, /tools, /tool/<id>, /hi/…). On real crawlable paths the
 * server component passes `initialRoute`, which the hash router uses
 * until the first hash navigation; from then on the hash drives as
 * always. `initialLocale` ("hi" mirrors) applies when the visitor has
 * no stored preference — returning users keep their explicit choice.
 */
export function AppShell({
  initialRoute,
  initialLocale,
}: {
  initialRoute: HashRoute;
  initialLocale?: "en" | "hi";
}) {
  const { t, setLocale, locale } = useI18n();
  const { route, routeKey } = useHashRoute(initialRoute);
  const [proOpen, setProOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const openSearch = useCallback(() => {
    setSearchOpen(true);
    track("search_open", { locale });
  }, [locale]);

  /* URL locale (R19 Phase 5): the /hi-ness of the current URL, from the
   * server-rendered boot (initialLocale — "hi" on /hi mirror pages) until
   * the route store goes live, then from the actual path. Provided to the
   * whole tree so internal link hrefs carry the right prefix in the RAW
   * HTML — crawlers and no-JS visitors on /hi stay on /hi paths. */
  const urlLocale = urlLocaleOf(routeKey, initialLocale === "hi" ? "hi" : "en");

  /*
   * SPA link interception (R17 real-path router): internal anchors now
   * carry real hrefs ("/tool/merge-pdf") for crawlers and copy-paste;
   * this listener upgrades those clicks to history.pushState navigation
   * so the app keeps its no-reload feel. Modifier clicks (new tab,
   * middle-click fallback, cmd-click) and non-internal targets pass
   * through untouched.
   */
  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const anchor = (event.target as HTMLElement | null)?.closest?.(
        "a[href]"
      ) as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.download) return;
      const href = anchor.getAttribute("href");
      /* Only same-app path links — anchors (#id), blobs, mailto and
       * external URLs keep their native behavior. */
      if (!href || !href.startsWith("/")) return;
      const url = new URL(href, window.location.origin);
      if (url.origin !== window.location.origin) return;
      event.preventDefault();
      /* Cross-locale links (R19 Phase 5 — the footer "read in …" anchor
       * and any future /hi↔EN link): when the target path's /hi-ness
       * differs from the CURRENT URL's, flip the locale to match the
       * target. setLocale writes localStorage synchronously, so the
       * withLocalePrefix normalization inside navigateToHash mirrors the
       * URL to the chosen locale. Comparing against the PATH (not the UI
       * locale) keeps link-graph semantics: a /hi page's links keep the
       * visitor in /hi regardless of a stored preference. */
      const targetIsHi = url.pathname === "/hi" || url.pathname.startsWith("/hi/");
      const pathIsHi =
        window.location.pathname === "/hi" || window.location.pathname.startsWith("/hi/");
      if (targetIsHi !== pathIsHi) {
        const next: "en" | "hi" = targetIsHi ? "hi" : "en";
        setLocale(next);
        track("language_switch", { from: pathIsHi ? "hi" : "en", to: next });
      }
      navigateToHash(url.pathname + url.search + url.hash);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  /*
   * GA4 tool_view (P7-SEO Phase 6): ONE event per tool landing, carrying
   * only registry metadata (slug/category/mode) + the active locale — no
   * PII, no file names. No-ops unless analytics consent is granted.
   *
   * Data-quality rules (learned the hard way, live-verified 2025-11):
   *  - DEDUPE per toolId: the /hi locale-mirror boot flips the i18n locale
   *    one frame after mount, which re-runs this effect — without the
   *    lastToolView guard every cross-locale returning visitor was counted
   *    TWICE in GA4.
   *  - FIRE SETTLED: the event is deferred two frames so the deferred
   *    locale flip commits first — localeRef then carries the language the
   *    visitor actually sees (en page + stored hi preference → "hi").
   *  - Module-level state (not useRef): survives hash-route re-lands but
   *    resets on a real page load, so A→B→A hash navigation still fires.
   */
  const localeRef = useRef(locale);
  useEffect(() => {
    localeRef.current = locale;
  }, [locale]);

  const openPro = useCallback(() => {
    setProOpen(true);
    track("pro_open", { locale });
  }, [locale]);

  const toolId = route.view === "tool" ? route.toolId : undefined;
  useEffect(() => {
    if (!toolId) return;
    let cancelled = false;
    const settle = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (cancelled || lastToolView === toolId) return;
        const tool = ALL_TOOLS.find((entry) => entry.id === toolId);
        if (!tool) return;
        lastToolView = toolId;
        track("tool_view", {
          tool_slug: tool.id,
          category: tool.category,
          mode: tool.mode,
          locale: localeRef.current,
        });
      })
    );
    return () => {
      cancelled = true;
      cancelAnimationFrame(settle);
    };
  }, [toolId]);

  /*
   * Boot marker for the iOS compatibility watchdog (boot-script.ts): once
   * the shell has mounted, the fallback screen must never appear, and
   * later errors route to the React error boundary instead.
   */
  useEffect(() => {
    (window as unknown as { __DP_BOOTED__?: boolean }).__DP_BOOTED__ = true;
  }, []);

  /*
   * Session bootstrap (Phase-10): fetch /api/auth/me once per page load so
   * the account menu reflects the cookie session. Failure = guest — the
   * tools never depend on it (PRD: no signup wall).
   */
  useEffect(() => {
    bootstrapAuth();
  }, []);

  /*
   * Locale mirror boot (R24 URL-wins): /hi/… paths ALWAYS render Hindi —
   * the URL is the contract (hreflang pairs, SSR meta, link-graph all
   * promise it). Fresh visitors get the persisted default (setLocale);
   * returning visitors with a conflicting stored "en" get a SESSION-ONLY
   * override (setSessionLocale) so their explicit preference survives
   * for the next EN visit — one "Read in English" click also restores it.
   * Deferred by one animation frame so the store update lands AFTER the
   * hydration commit — flipping the locale in the same task makes Radix
   * useIds regenerate and logs a hydration attribute mismatch.
   */
  useEffect(() => {
    if (!initialLocale) return;
    const frame = requestAnimationFrame(() => {
      try {
        const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
        if (stored === "en") {
          setSessionLocale("hi");
        } else if (!stored) {
          setLocale(initialLocale);
        }
        /* stored "hi" (or unreadable storage): already correct. */
      } catch {
        /* private mode / storage blocked — default locale is fine */
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [initialLocale, setLocale]);

  return (
    <UrlLocaleContext.Provider value={urlLocale}>
    <div className="flex min-h-screen flex-col bg-background">
        <a
          href="#main"
          onClick={anchorClickHandler("main", { focusTarget: true })}
          className="sr-only rounded-btn bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100]"
        >
          {t("common.skipToContent")}
        </a>

        <AnnouncementBanner />
        <SiteHeader onGetPro={openPro} onOpenSearch={openSearch} route={route} />

        <main id="main" className="flex-1 pb-16 md:pb-0">
          {route.view === "home" ? (
            <>
              <Hero />
              <PopularTools />
              <Steps />
              <Categories />
              <Why />
              <RecentFiles />
              <Modes />
              <Faq />
            </>
          ) : route.view === "tool" ? (
            <ToolView toolId={route.toolId ?? ""} />
          ) : route.view === "page" ? (
            <StaticPageView pageId={route.pageId ?? ""} />
          ) : route.view === "account" ? (
            <AccountPage onGetPro={openPro} />
          ) : (
            <ToolsView categoryId={route.category} query={route.query} />
          )}
        </main>

        <SiteFooter route={route} />
        {route.view === "tool" ? null : (
          <BottomTabBar route={route} onOpenSearch={openSearch} />
        )}
        <CookieBanner />
        <SearchPalette open={searchOpen} onOpenChange={setSearchOpen} />
        <AuthModal />

        <PricingModal open={proOpen} onOpenChange={setProOpen} />
    </div>
    </UrlLocaleContext.Provider>
  );
}
