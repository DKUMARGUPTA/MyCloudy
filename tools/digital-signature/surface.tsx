"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BadgeCheck,
  EyeOff,
  FileKey2,
  KeyRound,
  Loader2,
  PenLine,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/components/providers/locale-provider";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { getPdfPageCount } from "@/lib/pdf/thumbnails";
import { PreviewFileHeader } from "../stamp-common/preview-parts";
import { BLOCK_POSITIONS, SIGN_KEYS, type SignRun } from "./model";
import { setP12File as publishP12 } from "./p12-store";
import { parsePkcs12, type X509Summary } from "./pkcs12";

/**
 * Digital signature surface (RB6-FIN-a4) — the certificate + options
 * form (split-tool pattern: the schema panel is empty, this surface owns
 * every value).
 *
 * The certificate card: pick the .pfx/.p12, type its password, and the
 * PKCS#12 core parses it RIGHT HERE on the main thread (the same pure
 * code the worker runs) — the signer summary (CN, organization, serial,
 * validity window, modern/legacy pack badge) appears before anything is
 * signed, and a wrong password is caught before the run, not after.
 *
 * The picked File lives in the in-memory p12 store; config.collectAssets
 * hands it to the worker when the run starts. The password rides the
 * worker message like lock-pdf's — never the network.
 */
export function DigitalSignatureSurface({
  files,
  onChange,
  setFileOrder,
  setRunBlocked,
}: ToolSurfaceProps): React.JSX.Element | null {
  const { t, locale } = useI18n();
  const fileMeta = files[0];
  const file = fileMeta?.file ?? null;

  /* --- the certificate ---------------------------------------------- */
  const p12InputRef = useRef<HTMLInputElement>(null);
  const [p12Name, setP12Name] = useState("");
  const [password, setPassword] = useState("");
  const [parsing, setParsing] = useState(false);
  const [summary, setSummary] = useState<X509Summary | null>(null);
  const [macAlgo, setMacAlgo] = useState<string | null>(null);
  const [modern, setModern] = useState(false);
  const [p12Error, setP12Error] = useState<string | null>(null);

  /* --- page census ---------------------------------------------------- */
  const [pageCount, setPageCount] = useState(0);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void getPdfPageCount(file)
      .then((count) => {
        if (!cancelled) setPageCount(count);
      })
      .catch(() => {
        if (!cancelled) setPageCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  /* --- sign options ---------------------------------------------------- */
  const [reason, setReason] = useState("");
  const [location, setLocation] = useState("");
  const [page, setPage] = useState(0);
  const [position, setPosition] = useState<SignRun["position"]>("br");
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (page > Math.max(0, pageCount - 1)) setPage(0);
  }, [pageCount, page]);

  /* --- parse the p12 whenever the file or password settles -------------- */
  const [p12File, setP12State] = useState<File | null>(null);

  const pickP12 = useCallback(
    (incoming: File): void => {
      publishP12(incoming);
      setP12State(incoming);
      setP12Name(incoming.name);
      setSummary(null);
      setP12Error(null);
    },
    []
  );

  const clearP12 = useCallback((): void => {
    publishP12(null);
    setP12State(null);
    setP12Name("");
    setSummary(null);
    setP12Error(null);
  }, []);

  useEffect(() => {
    if (p12File === null || password === "") {
      setSummary(null);
      setP12Error(null);
      return;
    }
    let cancelled = false;
    setParsing(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const bytes = new Uint8Array(await p12File.arrayBuffer());
          const parsed = await parsePkcs12(bytes, password);
          if (cancelled) return;
          setSummary(parsed.summary);
          setMacAlgo(parsed.macAlgo);
          setModern(parsed.modern);
          setP12Error(null);
        } catch (error) {
          if (cancelled) return;
          const code =
            typeof error === "object" && error !== null && "code" in error
              ? String((error as { code?: unknown }).code)
              : "ds.errNotP12";
          setSummary(null);
          setP12Error(code in PARSE_ERROR_KEYS ? code : "ds.errNotP12");
        } finally {
          if (!cancelled) setParsing(false);
        }
      })();
    }, 350);
    return () => {
      cancelled = true;
      setParsing(false);
      clearTimeout(timer);
    };
  }, [p12File, password]);

  /* --- localized block labels + the serialized run payload -------------- */
  const labels = useMemo(
    () =>
      Object.fromEntries(
        SIGN_KEYS.map((key) => [`ds.${key}`, t(`ds.${key}`)])
      ) as Record<string, string>,
    [t]
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      onChange(
        "sign",
        JSON.stringify({ locale, reason, location, page, position, visible, labels })
      );
    });
    return () => {
      cancelled = true;
    };
  }, [locale, reason, location, page, position, visible, labels, onChange]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) onChange("password", password);
    });
    return () => {
      cancelled = true;
    };
  }, [password, onChange]);

  /* --- CTA gating ------------------------------------------------------ */
  const blockedKey = !p12File
    ? "ds.ctaNoP12"
    : password === ""
      ? "ds.ctaNoPassword"
      : parsing
        ? "ds.ctaParsing"
        : p12Error !== null
          ? "ds.ctaBadP12"
          : null;
  useEffect(() => {
    setRunBlocked(blockedKey);
  }, [blockedKey, setRunBlocked]);

  if (!file || !fileMeta) return null;

  const validFrom = summary !== null ? formatDateRange(summary).from : "";
  const validTo = summary !== null ? formatDateRange(summary).to : "";

  return (
    <div className="flex flex-col gap-4">
      <PreviewFileHeader
        file={file}
        pageCount={pageCount}
        onRemove={() => setFileOrder([])}
      />

      {/* --- the certificate card -------------------------------------- */}
      <section
        className="rounded-card border border-border bg-card"
        aria-labelledby="ds-cert-title"
      >
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className="flex size-9 items-center justify-center rounded-btn bg-cat-security/10 text-cat-security"
              aria-hidden="true"
            >
              <FileKey2 className="size-4.5" />
            </span>
            <div className="min-w-0">
              <h2 id="ds-cert-title" className="text-sm font-semibold text-foreground">
                {t("ds.certSection")}
              </h2>
              <p className="text-[11px] text-muted-foreground">
                {t("ds.certSectionHint")}
              </p>
            </div>
          </div>
          {p12Name !== "" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 shrink-0 rounded-btn text-muted-foreground hover:text-destructive"
              onClick={clearP12}
              aria-label={t("ds.p12Clear")}
            >
              <X className="size-3.5" aria-hidden="true" />
            </Button>
          ) : null}
        </header>

        <div className="flex flex-col gap-4 p-4 sm:p-5">
          <input
            ref={p12InputRef}
            type="file"
            accept=".p12,.pfx,application/x-pkcs12"
            className="sr-only"
            onChange={(e) => {
              const picked = e.target.files?.[0];
              if (picked) pickP12(picked);
              e.target.value = "";
            }}
          />

          {p12Name === "" ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => p12InputRef.current?.click()}
              className="h-auto w-full flex-col gap-1.5 rounded-btn border-dashed py-6"
            >
              <KeyRound className="size-5 text-primary" aria-hidden="true" />
              <span className="text-sm font-medium">{t("ds.p12Pick")}</span>
              <span className="px-4 text-center text-xs font-normal text-muted-foreground">
                {t("ds.p12Hint")}
              </span>
            </Button>
          ) : (
            <div className="flex min-h-11 items-center gap-3 rounded-btn border border-border bg-muted/40 px-3 py-2">
              <KeyRound className="size-4 shrink-0 text-primary" aria-hidden="true" />
              <p className="min-w-0 flex-1 truncate text-sm text-foreground">
                {p12Name}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 shrink-0 rounded-btn px-2"
                onClick={() => p12InputRef.current?.click()}
              >
                {t("ds.p12Change")}
              </Button>
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="ds-password" className="text-sm">
              {t("ds.passwordLabel")} *
            </Label>
            <Input
              id="ds-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("ds.passwordPlaceholder")}
              autoComplete="new-password"
              maxLength={256}
              aria-required="true"
              disabled={p12Name === ""}
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("ds.passwordHint")}
            </p>
          </div>

          {/* --- the parsed summary -------------------------------------- */}
          {parsing ? (
            <div
              className="flex min-h-11 items-center gap-2 rounded-btn border border-dashed border-border px-3 text-sm text-muted-foreground"
              role="status"
            >
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {t("ds.ctaParsing")}
            </div>
          ) : p12Error !== null ? (
            <div
              className="flex items-start gap-2 rounded-btn border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
              role="alert"
            >
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{t(p12Error)}</span>
            </div>
          ) : summary !== null ? (
            <div
              className="rounded-btn border border-emerald-600/40 bg-emerald-500/10 p-3"
              aria-live="polite"
            >
              <div className="flex flex-wrap items-center gap-2">
                <BadgeCheck
                  className="size-4 text-emerald-600 dark:text-emerald-400"
                  aria-hidden="true"
                />
                <p className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                  {summary.subjectCn !== "" ? summary.subjectCn : t("ds.certNoCn")}
                </p>
                <span className="rounded-chip border border-border bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {modern
                    ? t("ds.badgeModern")
                    : macAlgo !== null
                      ? t("ds.badgeLegacy")
                      : t("ds.badgeNoMac")}
                </span>
              </div>
              <dl className="mt-2 grid gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-[max-content_1fr]">
                {summary.subjectO !== "" ? (
                  <>
                    <dt className="text-muted-foreground">{t("ds.certO")}</dt>
                    <dd className="truncate text-foreground">{summary.subjectO}</dd>
                  </>
                ) : null}
                <dt className="text-muted-foreground">{t("ds.certSerial")}</dt>
                <dd className="truncate font-mono text-foreground">
                  {summary.serialHex}
                </dd>
                <dt className="text-muted-foreground">{t("ds.certValid")}</dt>
                <dd className="text-foreground">
                  {validFrom} – {validTo}
                </dd>
              </dl>
            </div>
          ) : null}
        </div>
      </section>

      {/* --- signature options ----------------------------------------- */}
      <section
        className="rounded-card border border-border bg-card"
        aria-labelledby="ds-sign-title"
      >
        <header className="flex flex-wrap items-center gap-2.5 border-b border-border/60 px-4 py-3">
          <span
            className="flex size-9 items-center justify-center rounded-btn bg-cat-security/10 text-cat-security"
            aria-hidden="true"
          >
            <PenLine className="size-4.5" />
          </span>
          <div className="min-w-0">
            <h2 id="ds-sign-title" className="text-sm font-semibold text-foreground">
              {t("ds.signSection")}
            </h2>
            <p className="text-[11px] text-muted-foreground">
              {t("ds.signSectionHint")}
            </p>
          </div>
        </header>

        <div className="grid gap-4 p-4 sm:grid-cols-2 sm:p-5">
          <div className="grid gap-1.5">
            <Label htmlFor="ds-reason" className="text-sm">
              {t("ds.reasonLabel")}
            </Label>
            <Input
              id="ds-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("ds.reasonPlaceholder")}
              maxLength={120}
              autoComplete="off"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ds-location" className="text-sm">
              {t("ds.locationLabel")}
            </Label>
            <Input
              id="ds-location"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder={t("ds.locationPlaceholder")}
              maxLength={80}
              autoComplete="off"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ds-page" className="text-sm">
              {t("ds.pageLabel")}
            </Label>
            <Select
              value={String(page)}
              onValueChange={(v) => setPage(Number(v))}
              disabled={pageCount < 1}
            >
              <SelectTrigger id="ds-page" className="w-full">
                <SelectValue placeholder={t("ds.pageLabel")} />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: Math.min(pageCount, 500) }, (_, i) => (
                  <SelectItem key={i} value={String(i)}>
                    {t("ds.pageOption", { n: i + 1 })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ds-position" className="text-sm">
              {t("ds.positionLabel")}
            </Label>
            <Select
              value={position}
              onValueChange={(v) =>
                setPosition(
                  (BLOCK_POSITIONS as string[]).includes(v)
                    ? (v as SignRun["position"])
                    : "br"
                )
              }
            >
              <SelectTrigger id="ds-position" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BLOCK_POSITIONS.map((pos) => (
                  <SelectItem key={pos} value={pos}>
                    {t(`ds.pos_${pos}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-start justify-between gap-3 rounded-btn border border-border bg-muted/30 p-3 sm:col-span-2">
            <div className="flex min-w-0 items-start gap-2.5">
              <span
                className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-btn bg-primary/10 text-primary"
                aria-hidden="true"
              >
                {visible ? (
                  <ShieldCheck className="size-4" />
                ) : (
                  <EyeOff className="size-4" />
                )}
              </span>
              <div className="min-w-0">
                <Label htmlFor="ds-visible" className="text-sm">
                  {t("ds.visibleLabel")}
                </Label>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t("ds.visibleHint")}
                </p>
              </div>
            </div>
            <Switch
              id="ds-visible"
              checked={visible}
              onCheckedChange={setVisible}
              aria-label={t("ds.visibleLabel")}
            />
          </div>
        </div>

        <p className="flex items-start gap-2 border-t border-border/60 px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          {t("ds.privacyLine")}
        </p>
      </section>
    </div>
  );
}

/** The honest p12 error codes the inline card shows (i18n-gated). */
const PARSE_ERROR_KEYS: Record<string, true> = {
  "ds.errWrongPassword": true,
  "ds.errNotP12": true,
  "ds.errUnsupported": true,
  "ds.errNoKey": true,
  "ds.errNotRsa": true,
};

/** yyyy-mm-dd stamp of a Date for the validity rows. */
function isoDate(date: Date): string {
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${p2(date.getUTCMonth() + 1)}-${p2(date.getUTCDate())}`;
}

function formatDateRange(summary: X509Summary): { from: string; to: string } {
  return { from: isoDate(summary.notBefore), to: isoDate(summary.notAfter) };
}
