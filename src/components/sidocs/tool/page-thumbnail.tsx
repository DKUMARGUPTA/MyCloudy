"use client";

import { useEffect, useState } from "react";

import { renderPdfThumbnail } from "@/lib/pdf/thumbnails";
import { renderTextThumbnail } from "@/lib/files/text-thumbnail";
import { looksHeic, resolveHeicPreview } from "@/lib/heic/heic-preview";
import { cn } from "@/lib/utils";

/**
 * File/page thumbnail with skeleton + error states (PRD §2.8: queued renders).
 *
 * Three paths:
 * - image blobs (image inputs, JPG/PNG tool outputs) are their own preview —
 *   the object URL is created directly, no render queue needed
 * - HEIC blobs cannot <img>-render outside Safari, so they go through the
 *   queued libheif preview (src/lib/heic/heic-preview.ts)
 * - text blobs (.txt outputs) render their first lines onto a canvas
 * - PDFs render page 1 through the queue in lib/pdf/thumbnails (2 in flight)
 */

export type ThumbnailStatus = "loading" | "ready" | "error";

export function useThumbnail(
  file: File | Blob,
  maxDim = 200
): { status: ThumbnailStatus; url: string | null } {
  const [state, setState] = useState<{
    status: ThumbnailStatus;
    url: string | null;
  }>({ status: "loading", url: null });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    // All state updates happen in promise callbacks (never synchronously
    // in the effect body); the cleanup revokes the created object URL.
    void Promise.resolve()
      .then(async () => {
        if (cancelled) return null;
        setState({ status: "loading", url: null });
        // HEIC fast path: browsers other than Safari cannot render HEIC
        // object URLs — decode a small preview instead (queued + cached).
        // A null preview (byte-sniff said "not HEIC after all") falls
        // through to the normal paths below.
        if (file instanceof File && looksHeic(file)) {
          const preview = await resolveHeicPreview(file, maxDim);
          if (cancelled) return null;
          if (preview) return preview.blob;
        }
        // Image fast path: the blob IS the preview.
        if (file.type.startsWith("image/")) return file;
        // Text fast path: first lines drawn onto a small canvas.
        if (file.type.startsWith("text/")) {
          return renderTextThumbnail(file, maxDim);
        }
        return renderPdfThumbnail(file, { maxDim }).then(
          (result) => result?.blob ?? null
        );
      })
      .then((blob) => {
        if (cancelled || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ status: "ready", url: objectUrl });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error", url: null });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file, maxDim]);

  return state;
}

export function PageThumbnail({
  file,
  alt,
  className,
}: {
  file: File | Blob;
  alt: string;
  className?: string;
}) {
  const { status, url } = useThumbnail(file);
  return (
    <div
      className={cn(
        "relative flex aspect-[3/4] w-full items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/40",
        className
      )}
    >
      {status === "loading" ? (
        <div
          aria-hidden="true"
          className="size-full animate-pulse bg-gradient-to-br from-muted to-muted/40"
        />
      ) : status === "error" ? (
        <span className="p-2 text-center text-[10px] leading-tight text-muted-foreground">
          ⚠︎
        </span>
      ) : (
        <img
          src={url ?? undefined}
          alt={alt}
          loading="lazy"
          decoding="async"
          className="size-full object-contain"
        />
      )}
    </div>
  );
}
