"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Cookie } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useMounted } from "@/hooks/use-mounted";
import { useI18n } from "@/components/providers/locale-provider";
import { createLocalSnapshot } from "@/lib/storage/local-snapshot";

/**
 * Cookie / consent banner (PRD §5.3): minimal bottom banner with
 * Accept all / Reject non-essential / Customize. Analytics default OFF.
 * The choice persists in localStorage; the footer "Privacy settings" link
 * re-opens the banner via the docopdf:open-consent event.
 */

const CONSENT_KEY = "docopdf-consent";
const CONSENT_EVENT = "docopdf:consent-change";
const OPEN_EVENT = "docopdf:open-consent";

interface Consent {
  analytics: boolean;
  savedAt: number;
}

function parseConsent(raw: string): Consent | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Consent).analytics === "boolean"
    ) {
      return parsed as Consent;
    }
    return null;
  } catch {
    return null;
  }
}

function writeConsent(value: Consent): void {
  try {
    window.localStorage.setItem(CONSENT_KEY, JSON.stringify(value));
  } catch {
    /* storage unavailable — banner returns next visit */
  }
  window.dispatchEvent(new Event(CONSENT_EVENT));
}

/** Subscribe to consent changes (storage + same-tab events) — GA4 glue too. */
export function subscribeToConsent(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  window.addEventListener(CONSENT_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(CONSENT_EVENT, callback);
  };
}

const serverSnapshot = (): Consent | null => null;

/* Stable snapshot: same object reference until the raw consent changes. */
const consentSnapshot = createLocalSnapshot<Consent | null>(
  CONSENT_KEY,
  parseConsent,
  null
);

/** Read the current consent (null when not chosen yet) — GA4 glue. */
export function readConsent(): Consent | null {
  return consentSnapshot();
}

/** Fire this to re-open the banner from the footer "Privacy settings" link. */
export function openConsentSettings(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function CookieBanner() {
  const { t } = useI18n();
  const { toast } = useToast();
  const mounted = useMounted();
  const consent = useSyncExternalStore(
    subscribeToConsent,
    consentSnapshot,
    serverSnapshot
  );
  const [expanded, setExpanded] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [forcedOpen, setForcedOpen] = useState(false);

  useEffect(() => {
    const onOpen = () => {
      setExpanded(true);
      setAnalytics(consentSnapshot()?.analytics ?? false);
      setForcedOpen(true);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  const decide = useCallback(
    (choice: boolean) => {
      writeConsent({ analytics: choice, savedAt: Date.now() });
      toast({ title: t("consent.savedToast") });
      setExpanded(false);
      setForcedOpen(false);
    },
    [t, toast]
  );

  const visible = (mounted && consent === null) || forcedOpen;
  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-label={t("consent.title")}
      className="fixed inset-x-4 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-50 md:inset-x-auto md:bottom-6 md:left-6 md:max-w-md"
    >
      <div className="rounded-card border border-border bg-card p-4 shadow-lg sm:p-5">
        <div className="flex items-start gap-3">
          <span
            className="flex size-10 shrink-0 items-center justify-center rounded-btn bg-primary/10 text-primary"
            aria-hidden="true"
          >
            <Cookie className="size-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground">
              {t("consent.title")}
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {t("consent.body")}
            </p>
          </div>
        </div>

        {expanded ? (
          <div className="mt-4 space-y-3 rounded-btn bg-muted p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-0.5">
                <Label
                  htmlFor="consent-analytics"
                  className="text-sm font-medium"
                >
                  {t("consent.analyticsLabel")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("consent.analyticsDesc")}
                </p>
              </div>
              <Switch
                id="consent-analytics"
                checked={analytics}
                onCheckedChange={setAnalytics}
              />
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("consent.essentialNote")}
            </p>
            <Button
              type="button"
              variant="cta"
              size="touch"
              className="w-full rounded-btn"
              onClick={() => decide(analytics)}
            >
              {t("consent.save")}
            </Button>
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button
              type="button"
              variant="cta"
              size="touch"
              className="rounded-btn sm:flex-1"
              onClick={() => decide(true)}
            >
              {t("consent.acceptAll")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="touch"
              className="rounded-btn sm:flex-1"
              onClick={() => decide(false)}
            >
              {t("consent.reject")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="touch"
              className="rounded-btn text-muted-foreground"
              onClick={() => setExpanded(true)}
            >
              {t("consent.customize")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
