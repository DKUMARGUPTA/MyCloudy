"use client";

import { useEffect, useRef, useState } from "react";
import {
  Check,
  Eye,
  EyeOff,
  Lock,
  LockOpen,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";

import { Input } from "@/components/ui/input";
import { useI18n } from "@/components/providers/locale-provider";
import { loadPdfjs } from "@/lib/pdf/pdfjs";
import { cn } from "@/lib/utils";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { PreviewFileHeader } from "../stamp-common/preview-parts";
import { UNLOCK_IDS } from "../lock-common/security";

/**
 * Unlock PDF surface (PRD §8.4): detects what kind of lock the file
 * carries (via a password-less pdf.js probe) and shows the honest
 * matching flow — a required open-password field, or the
 * restrictions-only confirmation. The policy card is always visible:
 * only unlock files you own or are allowed to modify.
 */

type LockState =
  | { kind: "checking" }
  | { kind: "needsPassword" }
  | { kind: "ownerOnly" }
  | { kind: "notEncrypted" }
  | { kind: "unreadable" };

/** Standard Info fields worth carrying into the unlocked output. */
function metaOf(info: Record<string, unknown>): string {
  const pick = (key: string): string | undefined => {
    const v = info[key];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };
  const meta: Record<string, string> = {};
  const title = pick("Title");
  if (title !== undefined) meta.title = title;
  const author = pick("Author");
  if (author !== undefined) meta.author = author;
  const subject = pick("Subject");
  if (subject !== undefined) meta.subject = subject;
  const keywords = pick("Keywords");
  if (keywords !== undefined) meta.keywords = keywords;
  const creator = pick("Creator");
  if (creator !== undefined) meta.creator = creator;
  const producer = pick("Producer");
  if (producer !== undefined) meta.producer = producer;
  return Object.keys(meta).length > 0 ? JSON.stringify(meta) : "";
}

export function UnlockSurface({
  files,
  values,
  onChange,
  setFileOrder,
}: ToolSurfaceProps): React.JSX.Element | null {
  const { t } = useI18n();
  const fileMeta = files[0];
  const file = fileMeta?.file ?? null;

  // Probe result TAGGED with the file it belongs to (remove-meta pattern:
  // no synchronous reset — a swapped file renders as "checking" because
  // the state identity never matches, and stale data never shows).
  const [probe, setProbe] = useState<{
    file: File;
    kind: "ownerOnly" | "needsPassword" | "unreadable";
  } | null>(null);
  const [pages, setPages] = useState<{ file: File; count: number } | null>(null);
  const [showPw, setShowPw] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const pwTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const password = typeof values[UNLOCK_IDS.pw] === "string" ? String(values[UNLOCK_IDS.pw]) : "";

  const state: LockState =
    probe?.file === file ? probe : { kind: "checking" };
  const pageCount = pages?.file === file ? pages.count : 0;

  // Probe: does the file open without a password? (Also grabs the Info
  // snapshot for the owner-only branch — the worker re-applies it.)
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void (async () => {
      try {
        const pdfjs = await loadPdfjs();
        const doc = await pdfjs.getDocument({
          data: new Uint8Array(await file.arrayBuffer()),
          isEvalSupported: false,
        }).promise;
        if (cancelled) {
          void doc.destroy();
          return;
        }
        const meta = await doc.getMetadata().catch(() => null);
        if (cancelled) {
          void doc.destroy();
          return;
        }
        setPages({ file, count: doc.numPages });
        if (meta?.info && typeof meta.info === "object") {
          onChange(UNLOCK_IDS.meta, metaOf(meta.info as Record<string, unknown>));
        }
        // pdf.js opens owner-only AND unencrypted files freely; the
        // worker tells them apart honestly at run time.
        setProbe({ file, kind: "ownerOnly" });
        void doc.destroy();
      } catch (error) {
        if (cancelled) return;
        const name =
          error !== null && typeof error === "object" && "name" in error
            ? String((error as { name: unknown }).name)
            : "";
        if (name === "PasswordException") {
          setProbe({ file, kind: "needsPassword" });
        } else {
          setProbe({ file, kind: "unreadable" });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file, onChange]);

  // Live password check (debounced): pdf.js try-open + Info snapshot so
  // the run carries the metadata. Shows the accepted state as feedback.
  useEffect(() => {
    if (probe?.file !== file || probe.kind !== "needsPassword") return;
    if (password.length === 0) return;
    if (pwTimerRef.current) clearTimeout(pwTimerRef.current);
    let cancelled = false;
    pwTimerRef.current = setTimeout(() => {
      void (async () => {
        try {
          const pdfjs = await loadPdfjs();
          const doc = await pdfjs.getDocument({
            data: new Uint8Array(await file.arrayBuffer()),
            password,
            isEvalSupported: false,
          }).promise;
          if (cancelled) {
            void doc.destroy();
            return;
          }
          const meta = await doc.getMetadata().catch(() => null);
          if (cancelled) {
            void doc.destroy();
            return;
          }
          setPages({ file, count: doc.numPages });
          if (meta?.info && typeof meta.info === "object") {
            onChange(UNLOCK_IDS.meta, metaOf(meta.info as Record<string, unknown>));
          }
          setAccepted(true);
          void doc.destroy();
        } catch {
          if (!cancelled) setAccepted(false);
        }
      })();
    }, 600);
    return () => {
      cancelled = true;
      if (pwTimerRef.current) clearTimeout(pwTimerRef.current);
    };
  }, [file, password, probe, onChange]);

  if (!file) return null;

  return (
    <div className="flex flex-col gap-5">
      <PreviewFileHeader
        file={file}
        pageCount={pageCount}
        onRemove={() => setFileOrder([])}
      />

      {state.kind === "checking" ? (
        <div className="flex min-h-32 items-center justify-center rounded-card border border-border bg-card">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" aria-hidden="true" />
            {t("unlock.checking")}
          </p>
        </div>
      ) : null}

      {state.kind === "needsPassword" ? (
        <div className="flex flex-col gap-5 rounded-card border border-border bg-card p-5 sm:p-6">
          <header className="flex flex-wrap items-center gap-3">
            <span
              className="flex size-10 items-center justify-center rounded-btn bg-cat-security/10 text-cat-security"
              aria-hidden="true"
            >
              <Lock className="size-5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground">
                {t("unlock.pwTitle")}
              </h2>
              <p className="text-xs text-muted-foreground">
                {t("unlock.pwSubtitle")}
              </p>
            </div>
          </header>
          <div className="flex flex-col gap-2.5">
            <label htmlFor="unlock-pw" className="text-sm font-medium text-foreground">
              {t("lock.openPw")}
            </label>
            <div className="relative">
              <Input
                id="unlock-pw"
                type={showPw ? "text" : "password"}
                value={password}
                onChange={(e) => onChange(UNLOCK_IDS.pw, e.target.value)}
                autoComplete="current-password"
                placeholder={t("unlock.pwPlaceholder")}
                className="pr-11 font-mono"
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                aria-label={showPw ? t("gp.hide") : t("gp.show")}
                className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
              >
                {showPw ? (
                  <EyeOff className="size-4" aria-hidden="true" />
                ) : (
                  <Eye className="size-4" aria-hidden="true" />
                )}
              </button>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("unlock.pwHint")}
            </p>
            {state.kind === "needsPassword" && accepted ? (
              <p className="flex items-center gap-1.5 rounded-btn border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                <Check className="size-3.5 shrink-0" aria-hidden="true" />
                {t("unlock.pwAccepted")}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {state.kind === "ownerOnly" ? (
        <div className="flex flex-col gap-5 rounded-card border border-border bg-card p-5 sm:p-6">
          <header className="flex flex-wrap items-center gap-3">
            <span
              className="flex size-10 items-center justify-center rounded-btn bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              aria-hidden="true"
            >
              <LockOpen className="size-5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground">
                {t("unlock.ownerTitle")}
              </h2>
              <p className="text-xs text-muted-foreground">
                {t("unlock.ownerSubtitle")}
              </p>
            </div>
          </header>
          <p className="rounded-btn border border-border bg-muted/40 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
            {t("unlock.ownerBody")}
          </p>
        </div>
      ) : null}

      {state.kind === "unreadable" ? (
        <div className="flex flex-col gap-2 rounded-card border border-red-500/30 bg-red-500/5 p-5">
          <p className="flex items-center gap-2 text-sm font-semibold text-red-700 dark:text-red-300">
            <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
            {t("unlock.unreadableTitle")}
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("unlock.unreadableBody")}
          </p>
        </div>
      ) : null}

      {/* Policy card — always visible (PRD: honest disclaimer). */}
      <div
        className={cn(
          "flex flex-col gap-2 rounded-card border border-border bg-card p-4",
          state.kind === "checking" && "hidden"
        )}
      >
        <p className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <ShieldCheck className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          {t("unlock.policyTitle")}
        </p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t("unlock.policyBody")}
        </p>
      </div>
    </div>
  );
}
