"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Calendar,
  ClipboardCheck,
  Loader2,
  Lock,
  TriangleAlert,
  UserRound,
  Wand2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import {
  getPdfPagePixelSize,
  renderPdfThumbnail,
} from "@/lib/pdf/thumbnails";
import { cn } from "@/lib/utils";
import {
  PreviewFileHeader,
  PreviewPageStrip,
  PreviewZoomControl,
} from "../stamp-common/preview-parts";
import {
  type FillFieldScan,
  type FormScan,
  displaySize,
  scanFormFields,
  userRectToDisplay,
} from "./scan";
import {
  type FillProfile,
  EMPTY_PROFILE,
  clearFillProfile,
  loadFillProfile,
  matchProfileValue,
  profileHasAny,
  saveFillProfile,
} from "./profile";

/**
 * Fill out PDF forms live surface (PRD §8.2 "Fill out"). Scans the AcroForm
 * with pdf-lib (read-only, on-device), renders the current page with
 * pdf.js and overlays a highlight box on every widget — click one to jump
 * to its input. The field form below lists every field in reading order
 * (Tab flows naturally), grouped visually by a page chip. Values live in
 * the shell options as "f:<fileId>::<name>" keys so replacing the file
 * can never leak answers into a different form (the worker only applies
 * keys carrying the current file id).
 */

const PREVIEW_MAX_DIM = 560;
const ZOOM_STEPS = [1, 1.5, 2] as const;
/** Above this many fields the list scrolls instead of growing the page. */
const LIST_SCROLL_LIMIT = 12;

const FIELD_KEY_ID = "fkey";
const fieldKey = (fileId: string, name: string): string =>
  `f:${fileId}::${name}`;

function originalString(field: FillFieldScan): string {
  if (field.kind === "text") {
    return typeof field.value === "string" ? field.value : "";
  }
  if (field.kind === "optionlist") return field.selected.join("\n");
  return typeof field.value === "string" ? field.value : "";
}

function originalBool(field: FillFieldScan): boolean {
  return field.kind === "checkbox" && field.value === true;
}

/** The value the input shows (shell override or the file's own value). */
function currentValue(
  field: FillFieldScan,
  values: Record<string, string | number | boolean>,
  fileId: string
): string | boolean {
  const raw = values[fieldKey(fileId, field.name)];
  if (field.kind === "checkbox") {
    return typeof raw === "boolean" ? raw : originalBool(field);
  }
  return typeof raw === "string" ? raw : originalString(field);
}

/** Did the user actually change this field (vs. the file's own value)? */
function isChanged(
  field: FillFieldScan,
  values: Record<string, string | number | boolean>,
  fileId: string
): boolean {
  const raw = values[fieldKey(fileId, field.name)];
  if (raw === undefined) return false;
  if (field.kind === "checkbox") {
    return typeof raw === "boolean" && raw !== originalBool(field);
  }
  const text = typeof raw === "string" ? raw : String(raw);
  return text !== originalString(field);
}

/** Does the field hold a meaningful answer right now? */
function isFilled(
  field: FillFieldScan,
  values: Record<string, string | number | boolean>,
  fileId: string
): boolean {
  const value = currentValue(field, values, fileId);
  return typeof value === "boolean" ? value : value.trim() !== "";
}

function isDateField(field: FillFieldScan): boolean {
  if (field.kind !== "text") return false;
  const label = field.label.toLowerCase();
  if (/(?:^|[^a-z])(date|dob)(?![a-z])/.test(label)) return true;
  return label.includes("तिथि") || label.includes("जन्म");
}

/** dd/mm/yyyy (India norm) from a native date input's yyyy-mm-dd. */
function isoToDateText(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return "";
  return `${match[3]}/${match[2]}/${match[1]}`;
}

const KIND_BADGE_KEYS: Record<FillFieldScan["kind"], string> = {
  text: "fill.typeText",
  checkbox: "fill.typeCheckbox",
  radio: "fill.typeRadio",
  dropdown: "fill.typeDropdown",
  optionlist: "fill.typeOptionlist",
};

interface PageHighlight {
  field: FillFieldScan;
  index: number;
  left: number;
  top: number;
  w: number;
  h: number;
}

export function FillSurface({
  files,
  values,
  onChange,
  setFileOrder,
  setRunBlocked,
}: ToolSurfaceProps): React.JSX.Element | null {
  const { t } = useI18n();
  const { toast } = useToast();
  const uid = useId();
  const fileMeta = files[0];
  const file = fileMeta?.file ?? null;
  const fileId = fileMeta?.id ?? "";

  // --- Page preview state (declared before the scan effect uses it) --
  const [selectedPage, setSelectedPage] = useState(0);
  const [zoom, setZoom] = useState<number>(1);
  const [base, setBase] = useState<{
    file: File;
    pageIndex: number;
    bitmap: ImageBitmap;
    dispW: number;
    dispH: number;
  } | null>(null);
  const [failure, setFailure] = useState<{
    file: File;
    pageIndex: number;
  } | null>(null);
  const [focusedField, setFocusedField] = useState<string | null>(null);

  // --- Form scan (pdf-lib, read only) --------------------------------
  const [scanState, setScanState] = useState<{
    file: File;
    scan: FormScan | null;
    error: boolean;
  } | null>(null);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void (async () => {
      const bytes = await file.arrayBuffer();
      const scan = await scanFormFields(bytes);
      if (cancelled) return;
      setScanState({ file, scan, error: false });
      setSelectedPage((page) =>
        Math.min(page, Math.max(0, scan.pageCount - 1))
      );
    })().catch(() => {
      if (!cancelled) setScanState({ file, scan: null, error: true });
    });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const active = scanState !== null && scanState.file === file ? scanState : null;
  const scan = active?.scan ?? null;
  const scanError = active?.error === true;
  const fields = scan?.fields ?? [];
  const pageCount = scan?.pageCount ?? 0;

  // Stamp the current file id into the options once per file — the worker
  // only applies "f:<fileId>::" keys, so answers can never leak into a
  // different file after a replacement.
  useEffect(() => {
    if (fileId !== "") onChange(FIELD_KEY_ID, fileId);
  }, [fileId, onChange]);

  useEffect(() => {
    if (!file || scan === null) return;
    let cancelled = false;
    void (async () => {
      const [thumb, pixel] = await Promise.all([
        renderPdfThumbnail(file, {
          pageIndex: selectedPage,
          maxDim: PREVIEW_MAX_DIM,
        }),
        getPdfPagePixelSize(file, 1, selectedPage),
      ]);
      if (cancelled) return;
      const bitmap = await createImageBitmap(thumb.blob);
      if (cancelled) return;
      setFailure(null);
      setBase({
        file,
        pageIndex: selectedPage,
        bitmap,
        dispW: pixel.width,
        dispH: pixel.height,
      });
    })().catch(() => {
      if (!cancelled) {
        setFailure({ file, pageIndex: selectedPage });
        setBase(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [file, scan, selectedPage]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !base) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = base.bitmap.width;
    canvas.height = base.bitmap.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base.bitmap, 0, 0);
  }, [base]);

  // --- Auto-fill profile ----------------------------------------------
  // Lazy initializer: one idempotent localStorage read (client only — the
  // surface mounts after a file drop, never during SSR).
  const [profile, setProfile] = useState<FillProfile>(() =>
    typeof window === "undefined" ? { ...EMPTY_PROFILE } : loadFillProfile()
  );
  const [profileOpen, setProfileOpen] = useState(false);

  const runAutoFill = useCallback((): void => {
    if (!profileHasAny(profile)) {
      setProfileOpen(true);
      toast({ title: t("fill.autofillEmpty") });
      return;
    }
    let count = 0;
    for (const field of fields) {
      if (field.kind !== "text" || field.readOnly) continue;
      // Label-only matching (never the qualified name — path segments
      // like "applicant." would false-match every field under them).
      const value = matchProfileValue(field.label, profile);
      if (value === "" || value === currentValue(field, values, fileId)) {
        continue;
      }
      onChange(fieldKey(fileId, field.name), value);
      count += 1;
    }
    toast({
      title:
        count > 0
          ? t("fill.autofillDone", { count })
          : t("fill.autofillNoMatch"),
    });
  }, [fields, fileId, profile, t, toast, onChange, values]);

  // --- Derived state ---------------------------------------------------
  const filledCount = fields.filter(
    (field) => isChanged(field, values, fileId)
  ).length;
  const requiredLeft = fields.filter(
    (field) =>
      field.required && !field.readOnly && !isFilled(field, values, fileId)
  ).length;

  const blockedKey =
    !file
      ? null
      : scanError
        ? "fill.scanError"
        : scan === null
          ? "fill.ctaScanning"
          : fields.length === 0
            ? "fill.ctaNoFields"
            : filledCount === 0
              ? "fill.ctaNoChanges"
              : null;
  useEffect(() => {
    setRunBlocked(blockedKey);
  }, [blockedKey, setRunBlocked]);

  const markedPages = useMemo(() => {
    const set = new Set<number>();
    for (const field of fields) {
      for (const widget of field.widgets) set.add(widget.page);
    }
    return set;
  }, [fields]);

  const current =
    base !== null && base.file === file && base.pageIndex === selectedPage
      ? base
      : null;
  const failed =
    failure !== null &&
    failure.file === file &&
    failure.pageIndex === selectedPage &&
    current === null;

  const pageInfo =
    scan !== null && selectedPage < scan.pages.length
      ? scan.pages[selectedPage]
      : null;

  const highlights = useMemo<PageHighlight[]>(() => {
    if (scan === null || pageInfo === null) return [];
    const out: PageHighlight[] = [];
    scan.fields.forEach((field, index) => {
      for (const widget of field.widgets) {
        if (widget.page !== selectedPage) continue;
        const disp = userRectToDisplay(
          widget.rect,
          pageInfo.rotation,
          pageInfo.width,
          pageInfo.height
        );
        if (disp.w <= 0 || disp.h <= 0) continue;
        const size = displaySize(
          pageInfo.rotation,
          pageInfo.width,
          pageInfo.height
        );
        out.push({
          field,
          index,
          left: (disp.left / size.w) * 100,
          top: (disp.top / size.h) * 100,
          w: (disp.w / size.w) * 100,
          h: (disp.h / size.h) * 100,
        });
      }
    });
    return out;
  }, [scan, pageInfo, selectedPage]);

  // --- Field interactions ----------------------------------------------
  const rowId = useCallback(
    (index: number): string => `${uid}-row-${index}`,
    [uid]
  );

  const focusFieldRow = useCallback(
    (field: FillFieldScan, index: number): void => {
      setFocusedField(field.name);
      const widget = field.widgets[0];
      if (widget && widget.page !== selectedPage) setSelectedPage(widget.page);
      window.setTimeout(() => {
        const row = document.getElementById(rowId(index));
        if (!row) return;
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        row
          .querySelector<HTMLElement>(
            "input:not([type='date']):not([tabindex='-1']), textarea, button[role='checkbox'], button[role='radio'], button[role='combobox']"
          )
          ?.focus();
      }, 60);
    },
    [rowId, selectedPage]
  );

  const handleInputFocus = useCallback(
    (field: FillFieldScan): void => {
      setFocusedField(field.name);
      const widget = field.widgets[0];
      if (widget && widget.page !== selectedPage) setSelectedPage(widget.page);
    },
    [selectedPage]
  );

  const removeFile = useCallback((): void => {
    setFileOrder([]);
  }, [setFileOrder]);

  if (!file || !fileMeta) return null;

  const loading = scan === null && !scanError;

  return (
    <div className="flex flex-col gap-4">
      <PreviewFileHeader
        file={file}
        pageCount={pageCount}
        onRemove={removeFile}
      />

      {loading ? (
        <div
          className="flex items-center gap-3 rounded-card border border-border bg-card px-4 py-8 text-sm text-muted-foreground"
          role="status"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t("fill.scanning")}
        </div>
      ) : scanError ? (
        <div
          className="flex items-center gap-3 rounded-card border border-border bg-card px-4 py-8 text-sm text-muted-foreground"
          role="alert"
        >
          <TriangleAlert
            className="size-4 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden="true"
          />
          {t("fill.scanError")}
        </div>
      ) : fields.length === 0 ? (
        <div className="rounded-card border border-border bg-card px-4 py-8">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-btn bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <TriangleAlert className="size-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">
                {t("fill.noFieldsTitle")}
              </p>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {t("fill.noFieldsBody")}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground/80">
                {t("fill.noFieldsEditor")}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* --- Live preview with field highlights --------------------- */}
          <div className="overflow-hidden rounded-card border border-border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-muted/40 px-4 py-2.5">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <ClipboardCheck
                  className="size-3.5 text-primary"
                  aria-hidden="true"
                />
                {t("fill.previewTitle", { page: selectedPage + 1 })}
              </p>
              <PreviewZoomControl
                steps={ZOOM_STEPS}
                value={zoom}
                onChange={setZoom}
              />
            </div>
            <div
              className={cn(
                "relative flex max-w-full justify-center bg-muted/30 px-4 py-5",
                zoom > 1
                  ? "overflow-x-auto overflow-y-hidden scrollbar-thin"
                  : "items-center overflow-hidden"
              )}
            >
              {failed ? (
                <div className="flex items-start gap-2.5 px-3 py-6 text-xs leading-relaxed text-muted-foreground">
                  <TriangleAlert
                    className="mt-0.5 size-4 shrink-0 text-amber-500"
                    aria-hidden="true"
                  />
                  {t("wm.previewFailed")}
                </div>
              ) : current ? (
                <div
                  className={cn(
                    "relative inline-block max-w-full",
                    zoom > 1 && "max-w-none shrink-0"
                  )}
                >
                  <canvas
                    ref={canvasRef}
                    style={
                      zoom > 1
                        ? {
                            width: `${Math.round(current.bitmap.width * zoom)}px`,
                          }
                        : undefined
                    }
                    className="block h-auto w-auto max-h-[62vh] max-w-full rounded-md border border-border/60 shadow-sm"
                    aria-label={t("fill.previewTitle", {
                      page: selectedPage + 1,
                    })}
                    role="img"
                  />
                  {/* Field highlight boxes (percent-positioned — zoom-proof). */}
                  {highlights.map((item, hi) => {
                    const filled = isFilled(item.field, values, fileId);
                    const focused = focusedField === item.field.name;
                    return (
                      <button
                        key={`${item.field.name}-${hi}`}
                        type="button"
                        onClick={() => focusFieldRow(item.field, item.index)}
                        onFocus={() => setFocusedField(item.field.name)}
                        title={item.field.label}
                        aria-label={t("fill.jumpToField", {
                          field: item.field.label,
                        })}
                        className={cn(
                          "absolute rounded-sm border-2 transition-colors",
                          focused
                            ? "border-primary bg-primary/30 ring-2 ring-primary/60"
                            : filled
                              ? "border-emerald-500 bg-emerald-500/20 hover:bg-emerald-500/30"
                              : "border-primary/80 bg-primary/15 hover:bg-primary/25"
                        )}
                        style={{
                          left: `${item.left}%`,
                          top: `${item.top}%`,
                          width: `${item.w}%`,
                          height: `${item.h}%`,
                        }}
                      >
                        {focused ? (
                          <span className="sr-only">
                            {t("fill.jumpToField", { field: item.field.label })}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="flex h-72 w-52 items-center justify-center rounded-md border border-dashed border-border">
                  <Loader2
                    className="size-5 animate-spin text-muted-foreground"
                    aria-hidden="true"
                  />
                </div>
              )}
            </div>
            <p className="border-t border-border/60 px-4 py-2 text-[10px] text-muted-foreground">
              {t("fill.previewNote")}
            </p>
          </div>

          <PreviewPageStrip
            file={file}
            pageCount={pageCount}
            selected={selectedPage}
            onSelect={setSelectedPage}
            markedSet={markedPages}
          />

          {/* --- Auto-fill bar ------------------------------------------ */}
          <div className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-card px-4 py-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 rounded-btn px-3"
              onClick={runAutoFill}
            >
              <Wand2 className="size-3.5 text-primary" aria-hidden="true" />
              {t("fill.autofillBtn")}
            </Button>
            <span className="rounded-chip border border-border bg-muted/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
              {t("fill.filledCount", {
                filled: filledCount,
                total: fields.length,
              })}
            </span>
            {requiredLeft > 0 ? (
              <span className="flex items-center gap-1 rounded-chip bg-amber-500/15 px-2.5 py-1 text-[11px] font-semibold text-amber-800 dark:text-amber-300">
                <TriangleAlert className="size-3" aria-hidden="true" />
                {t("fill.requiredLeft", { count: requiredLeft })}
              </span>
            ) : (
              <span className="rounded-chip bg-emerald-500/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                {t("fill.allSet")}
              </span>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto h-8 gap-1.5 rounded-btn px-3 text-muted-foreground"
              aria-expanded={profileOpen}
              onClick={() => setProfileOpen((open) => !open)}
            >
              <UserRound className="size-3.5" aria-hidden="true" />
              {t("fill.manageProfile")}
            </Button>
          </div>

          {profileOpen ? (
            <div className="rounded-card border border-border bg-card px-4 py-4">
              <p className="text-xs font-semibold text-foreground">
                {t("fill.profileTitle")}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                {t("fill.profileHint")}
              </p>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {(
                  [
                    ["name", "fill.pName"],
                    ["email", "fill.pEmail"],
                    ["phone", "fill.pPhone"],
                    ["organization", "fill.pOrganization"],
                  ] as const
                ).map(([key, labelKey]) => (
                  <div key={key} className="grid gap-1.5">
                    <Label
                      htmlFor={`${uid}-p-${key}`}
                      className="text-[11px] font-medium text-muted-foreground"
                    >
                      {t(labelKey)}
                    </Label>
                    <Input
                      id={`${uid}-p-${key}`}
                      type={key === "email" ? "email" : "text"}
                      value={profile[key]}
                      autoComplete="off"
                      onChange={(event) =>
                        setProfile((prev) => ({
                          ...prev,
                          [key]: event.target.value,
                        }))
                      }
                      className="h-8 text-sm"
                    />
                  </div>
                ))}
                <div className="grid gap-1.5 sm:col-span-2">
                  <Label
                    htmlFor={`${uid}-p-address`}
                    className="text-[11px] font-medium text-muted-foreground"
                  >
                    {t("fill.pAddress")}
                  </Label>
                  <Input
                    id={`${uid}-p-address`}
                    value={profile.address}
                    autoComplete="off"
                    onChange={(event) =>
                      setProfile((prev) => ({
                        ...prev,
                        address: event.target.value,
                      }))
                    }
                    className="h-8 text-sm"
                  />
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  className="h-8 rounded-btn px-3"
                  onClick={() => {
                    saveFillProfile(profile);
                    toast({ title: t("fill.profileSaved") });
                  }}
                >
                  {t("fill.profileSave")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-btn px-3 text-muted-foreground"
                  onClick={() => {
                    clearFillProfile();
                    setProfile({ ...EMPTY_PROFILE });
                    toast({ title: t("fill.profileCleared") });
                  }}
                >
                  {t("fill.profileClear")}
                </Button>
              </div>
            </div>
          ) : null}

          {/* --- Field form (reading order = Tab order) ------------------ */}
          <div className="overflow-hidden rounded-card border border-border bg-card">
            <p className="flex items-center gap-1.5 border-b border-border/60 bg-muted/40 px-4 py-2.5 text-xs font-semibold text-foreground">
              <ClipboardCheck
                className="size-3.5 text-primary"
                aria-hidden="true"
              />
              {t("fill.fieldsTitle")}
            </p>
            <div
              className={cn(
                "flex flex-col divide-y divide-border/60",
                fields.length > LIST_SCROLL_LIMIT &&
                  "max-h-[70vh] overflow-y-auto scrollbar-thin"
              )}
            >
              {fields.map((field, index) => (
                <FieldRow
                  key={field.name}
                  id={rowId(index)}
                  field={field}
                  value={currentValue(field, values, fileId)}
                  changed={isChanged(field, values, fileId)}
                  filled={isFilled(field, values, fileId)}
                  focused={focusedField === field.name}
                  showPageChip={pageCount > 1}
                  onPageChipClick={() =>
                    setSelectedPage(field.widgets[0]?.page ?? 0)
                  }
                  onFocus={handleInputFocus}
                  onValueChange={(next) =>
                    onChange(fieldKey(fileId, field.name), next)
                  }
                />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** One field row: label + badges on the left, the input on the right. */
function FieldRow({
  id,
  field,
  value,
  changed,
  filled,
  focused,
  showPageChip,
  onPageChipClick,
  onFocus,
  onValueChange,
}: {
  id: string;
  field: FillFieldScan;
  value: string | boolean;
  changed: boolean;
  filled: boolean;
  focused: boolean;
  showPageChip: boolean;
  onPageChipClick: () => void;
  onFocus: (field: FillFieldScan) => void;
  onValueChange: (next: string | boolean) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const uid = useId();
  const focusField = (): void => onFocus(field);

  // Values flow straight through onValueChange (the shell owns the state).
  // Rapid same-frame double toggles are an automation-only artifact —
  // human interactions always land in separate frames (P3.4 lesson).

  return (
    <div
      id={id}
      className={cn(
        "grid grid-cols-1 gap-2 px-4 py-3 transition-colors sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] sm:gap-4",
        focused && "bg-primary/[0.05]"
      )}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          {showPageChip ? (
            <button
              type="button"
              onClick={onPageChipClick}
              className="rounded-chip border border-border bg-muted/50 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              title={t("fill.gotoPage")}
            >
              {t("fill.pageLabel", { page: (field.widgets[0]?.page ?? 0) + 1 })}
            </button>
          ) : null}
          <Label
            htmlFor={`${uid}-input`}
            className="min-w-0 break-words text-sm font-medium leading-snug text-foreground"
          >
            {field.label}
            <span className="sr-only"> — {t(KIND_BADGE_KEYS[field.kind])}</span>
          </Label>
          {field.required ? (
            <span
              className="rounded-chip bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold text-destructive"
              title={t("fill.required")}
            >
              {t("fill.required")}
            </span>
          ) : null}
          {field.readOnly ? (
            <span
              className="flex items-center gap-1 rounded-chip border border-border bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              title={t("fill.readonly")}
            >
              <Lock className="size-2.5" aria-hidden="true" />
              {t("fill.readonly")}
            </span>
          ) : null}
          {field.kind !== "text" && field.kind !== "checkbox" ? (
            <span className="rounded-chip border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {t(KIND_BADGE_KEYS[field.kind])}
            </span>
          ) : null}
        </div>
        {field.maxLength !== null && field.kind === "text" ? (
          <p className="mt-1 text-[10px] tabular-nums text-muted-foreground">
            {t("fill.maxChars", { count: field.maxLength })}
          </p>
        ) : null}
      </div>

      <div className="min-w-0">
        {field.kind === "text" ? (
          field.multiline ? (
            <Textarea
              id={`${uid}-input`}
              value={typeof value === "string" ? value : ""}
              maxLength={field.maxLength ?? undefined}
              disabled={field.readOnly}
              rows={3}
              onFocus={focusField}
              onChange={(event) => onValueChange(event.target.value)}
              className={cn(
                "min-h-0 resize-y text-sm",
                changed && "border-primary/50"
              )}
            />
          ) : (
            <span className="relative block">
              <Input
                id={`${uid}-input`}
                value={typeof value === "string" ? value : ""}
                maxLength={field.maxLength ?? undefined}
                disabled={field.readOnly}
                onFocus={focusField}
                onChange={(event) => onValueChange(event.target.value)}
                className={cn(
                  "text-sm",
                  isDateField(field) && "pr-9",
                  changed && "border-primary/50"
                )}
              />
              {isDateField(field) && !field.readOnly ? (
                <label
                  className="absolute right-1.5 top-1/2 flex size-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  title={t("fill.pickDate")}
                >
                  <Calendar className="pointer-events-none size-4" aria-hidden="true" />
                  <input
                    type="date"
                    tabIndex={-1}
                    aria-label={t("fill.pickDate")}
                    className="absolute inset-0 size-full cursor-pointer opacity-0"
                    onChange={(event) => {
                      const text = isoToDateText(event.target.value);
                      if (text !== "") onValueChange(text);
                    }}
                  />
                </label>
              ) : null}
            </span>
          )
        ) : field.kind === "checkbox" ? (
          <label
            htmlFor={`${uid}-input`}
            className="flex min-h-9 cursor-pointer items-center gap-2.5 text-sm text-foreground"
          >
            <Checkbox
              id={`${uid}-input`}
              checked={value === true}
              disabled={field.readOnly}
              onFocus={focusField}
              onCheckedChange={(next) => onValueChange(next === true)}
            />
            <span className="text-muted-foreground">
              {t("fill.checkboxLabel")}
            </span>
          </label>
        ) : field.kind === "radio" ? (
          <div className="flex flex-col gap-2" onFocusCapture={focusField}>
            <RadioGroup
              value={typeof value === "string" && value !== "" ? value : undefined}
              disabled={field.readOnly}
              onValueChange={(next) => onValueChange(next)}
              className="flex flex-col gap-2 sm:flex-row sm:flex-wrap"
            >
              {field.options.map((option) => (
                <label
                  key={option}
                  htmlFor={`${uid}-opt-${option}`}
                  className="flex cursor-pointer items-center gap-2 rounded-btn border border-border bg-background px-2.5 py-1.5 text-sm transition-colors hover:border-primary/40 has-[button[data-state=checked]]:border-primary/60"
                >
                  <RadioGroupItem
                    id={`${uid}-opt-${option}`}
                    value={option}
                    onFocus={focusField}
                  />
                  <span className="text-foreground">{option}</span>
                </label>
              ))}
            </RadioGroup>
            {typeof value === "string" && value !== "" ? (
              <button
                type="button"
                onClick={() => onValueChange("")}
                className="self-start text-[11px] font-medium text-muted-foreground underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground"
              >
                {t("fill.clearSelection")}
              </button>
            ) : null}
          </div>
        ) : field.kind === "dropdown" ? (
          field.options.length === 0 ? (
            <p className="min-h-9 py-2 text-sm text-muted-foreground">
              {t("fill.noOptions")}
            </p>
          ) : (
            <Select
              value={
                typeof value === "string" && value !== "" ? value : "__none__"
              }
              disabled={field.readOnly}
              onValueChange={(next) =>
                onValueChange(next === "__none__" ? "" : next)
              }
            >
              <SelectTrigger
                id={`${uid}-input`}
                onFocus={focusField}
                className={cn(
                  "h-9 w-full text-sm",
                  changed && "border-primary/50"
                )}
              >
                <SelectValue placeholder={t("fill.selectNone")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">{t("fill.selectNone")}</SelectItem>
                {field.options.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )
        ) : (
          <div
            className="flex max-h-40 flex-col gap-2 overflow-y-auto rounded-btn border border-border bg-background p-2.5 scrollbar-thin"
            onFocusCapture={focusField}
          >
            {field.options.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("fill.noOptions")}
              </p>
            ) : (
              field.options.map((option) => {
                const list =
                  typeof value === "string" && value !== ""
                    ? value.split("\n")
                    : [];
                const checked = list.includes(option);
                return (
                  <label
                    key={option}
                    htmlFor={`${uid}-opt-${option}`}
                    className="flex cursor-pointer items-center gap-2.5 text-sm text-foreground"
                  >
                    <Checkbox
                      id={`${uid}-opt-${option}`}
                      checked={checked}
                      disabled={field.readOnly}
                      onFocus={focusField}
                      onCheckedChange={() =>
                        onValueChange(
                          checked
                            ? list.filter((item) => item !== option).join("\n")
                            : [...list, option].join("\n")
                        )
                      }
                    />
                    <span>{option}</span>
                  </label>
                );
              })
            )}
          </div>
        )}
        {filled ? (
          <span
            className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
            aria-hidden="true"
          >
            <span className="size-1.5 rounded-full bg-emerald-500" />
            {t("fill.filledDot")}
          </span>
        ) : null}
      </div>
    </div>
  );
}
