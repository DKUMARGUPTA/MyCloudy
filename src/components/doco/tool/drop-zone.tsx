"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { FileUp, FolderOpen } from "lucide-react";

import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/components/providers/locale-provider";
import { getStorageEstimate } from "@/lib/storage/opfs";
import { sniffIsPdf } from "@/lib/pdf/thumbnails";
import { cn } from "@/lib/utils";

/**
 * DropZone (PRD §6.3 state 1): select / drop / paste (Ctrl+V).
 *
 * Security per PRD §2.4 + §14: files are validated by MAGIC BYTES
 * ("%PDF-"), not by extension or MIME label; size limits 50MB mobile /
 * 200MB desktop; count limited by the tool config. A storage estimate
 * check warns when the device is nearly full before accepting.
 */

export function isMobileDevice(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(pointer: coarse)").matches;
}

export function defaultMaxSizeBytes(): number {
  return isMobileDevice() ? 50 * 1024 * 1024 : 200 * 1024 * 1024;
}

interface DropZoneProps {
  /** i18n key for the primary label, e.g. "tool.selectPdfFiles". */
  labelKey: string;
  multiple: boolean;
  maxFiles: number;
  maxSizeBytes?: number;
  /** "pdf" sniffs %PDF-, "image" sniffs image magics, "any" defers routing. */
  acceptKind: "pdf" | "image" | "any";
  onAccept: (files: File[]) => void;
  currentCount?: number;
  className?: string;
}

async function sniffIsImage(file: File): Promise<boolean> {
  if (file.type.startsWith("image/")) return true;
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const has = (bytes: number[], offset = 0) =>
    bytes.every((byte, i) => head[offset + i] === byte);
  if (
    has([0xff, 0xd8, 0xff]) || // JPEG
    has([0x89, 0x50, 0x4e, 0x47]) || // PNG
    has([0x47, 0x49, 0x46, 0x38]) || // GIF
    has([0x52, 0x49, 0x46, 0x46]) || // WEBP (RIFF....WEBP)
    has([0x42, 0x4d]) || // BMP ("BM")
    has([0x38, 0x42, 0x50, 0x53]) // PSD ("8BPS")
  ) {
    return true;
  }
  // HEIC/HEIF family (ftyp at 4, brand at 8): heic/heix/hevc/hevm/hevs from
  // Apple/Samsung phones, heim/heis (Samsung), mif1/msf1 generic containers.
  if (has([0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = String.fromCharCode(
      head[8] ?? 0,
      head[9] ?? 0,
      head[10] ?? 0,
      head[11] ?? 0
    );
    return ["heic", "heix", "hevc", "hevm", "hevs", "heim", "heis", "mif1", "msf1"].includes(brand);
  }
  return false;
}

export function DropZone({
  labelKey,
  multiple,
  maxFiles,
  maxSizeBytes,
  acceptKind,
  onAccept,
  currentCount = 0,
  className,
}: DropZoneProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);
  const inputId = useId();
  const limit = maxSizeBytes ?? defaultMaxSizeBytes();

  const validateAndAccept = useCallback(
    async (incoming: File[]) => {
      if (incoming.length === 0) return;
      const room = maxFiles - currentCount;
      if (room <= 0) {
        toast({
          title: t("dropzone.errTooManyTitle"),
          description: t("dropzone.errTooManyDesc", { count: maxFiles }),
          variant: "destructive",
        });
        return;
      }

      const estimate = await getStorageEstimate();
      if (estimate?.lowSpace) {
        toast({
          title: t("dropzone.warnLowSpaceTitle"),
          description: t("dropzone.warnLowSpaceDesc"),
        });
      }

      const accepted: File[] = [];
      for (const file of incoming.slice(0, room)) {
        if (file.size > limit) {
          toast({
            title: t("dropzone.errTooLargeTitle"),
            description: t("dropzone.errTooLargeDesc", {
              size: isMobileDevice() ? "50 MB" : "200 MB",
            }),
            variant: "destructive",
          });
          continue;
        }
        const valid =
          acceptKind === "any"
            ? true
            : acceptKind === "pdf"
              ? await sniffIsPdf(file)
              : await sniffIsImage(file);
        if (!valid) {
          toast({
            title: t(
              acceptKind === "image"
                ? "dropzone.errNotImageTitle"
                : "dropzone.errNotPdfTitle"
            ),
            description: t(
              acceptKind === "image"
                ? "dropzone.errNotImageDesc"
                : "dropzone.errNotPdfDesc"
            ),
            variant: "destructive",
          });
          continue;
        }
        accepted.push(file);
      }
      if (accepted.length > 0) onAccept(accepted);
    },
    [
      acceptKind,
      currentCount,
      limit,
      maxFiles,
      onAccept,
      t,
      toast,
    ]
  );

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      void validateAndAccept([...event.target.files ?? []]);
      event.target.value = ""; // allow re-selecting the same file
    },
    [validateAndAccept]
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragCounter.current = 0;
      setDragOver(false);
      void validateAndAccept([...event.dataTransfer.files]);
    },
    [validateAndAccept]
  );

  // Paste support (PRD §6.3): Ctrl+V of a file from the desktop/clipboard.
  useEffect(() => {
    const onPaste = (event: globalThis.ClipboardEvent) => {
      const files = [...(event.clipboardData?.files ?? [])];
      if (files.length === 0) return;
      event.preventDefault();
      void validateAndAccept(files);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [validateAndAccept]);

  return (
    <div
      onDragEnter={(event) => {
        event.preventDefault();
        dragCounter.current += 1;
        setDragOver(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault();
        dragCounter.current = Math.max(0, dragCounter.current - 1);
        if (dragCounter.current === 0) setDragOver(false);
      }}
      onDrop={handleDrop}
      className={cn(
        "relative rounded-card border-2 border-dashed transition-all duration-200",
        dragOver
          ? "scale-[1.01] border-primary bg-primary/5 ring-4 ring-primary/10"
          : "border-border bg-card hover:border-primary/40",
        className
      )}
    >
      <label
        htmlFor={inputId}
        className="flex min-h-44 cursor-pointer flex-col items-center justify-center gap-3 px-6 py-8 text-center"
      >
        <span
          aria-hidden="true"
          className={cn(
            "flex size-14 items-center justify-center rounded-full border transition-all duration-200",
            dragOver
              ? "border-primary bg-primary/10 text-primary scale-110"
              : "border-border bg-muted/50 text-muted-foreground"
          )}
        >
          {dragOver ? (
            <FileUp className="size-6 animate-in fade-in-50 zoom-in-75" />
          ) : (
            <FolderOpen className="size-6" />
          )}
        </span>
        <span className="text-sm font-semibold text-foreground">
          {t(labelKey)}
        </span>
        <span className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{t("dropzone.dropHint")}</span>
          <span aria-hidden="true">·</span>
          <span className="font-medium">
            <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-sans text-[10px]">
              Ctrl
            </kbd>
            <span> + </span>
            <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-sans text-[10px]">
              V
            </kbd>
            <span className="sr-only"> </span>
            <span> {t("dropzone.pasteHint")}</span>
          </span>
        </span>
        <span className="text-[11px] text-muted-foreground">
          {acceptKind === "image"
            ? maxFiles === 1
              ? t("dropzone.limitsImageOne", {
                  size: isMobileDevice() ? "50 MB" : "200 MB",
                })
              : t("dropzone.limitsImage", {
                  size: isMobileDevice() ? "50 MB" : "200 MB",
                  count: maxFiles,
                })
            : maxFiles === 1
              ? t("dropzone.limitsOne", {
                  size: isMobileDevice() ? "50 MB" : "200 MB",
                })
              : t("dropzone.limits", {
                  size: isMobileDevice() ? "50 MB" : "200 MB",
                  count: maxFiles,
                })}
        </span>
      </label>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        multiple={multiple}
        accept={
          acceptKind === "pdf"
            ? "application/pdf,.pdf"
            : acceptKind === "image"
              ? "image/*"
              : undefined
        }
        className="sr-only"
        onChange={handleInputChange}
        aria-label={t(labelKey)}
      />
    </div>
  );
}
