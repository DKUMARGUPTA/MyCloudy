"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  CalendarDays,
  Eraser,
  FileText,
  RotateCcw,
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
import type { ToolPanelProps } from "@/lib/tools/panel-types";
import { getPdfDocInfo } from "@/lib/pdf/thumbnails";
import {
  DATE_MODES,
  DI_IDS,
  type DocInfoRead,
  type DateMode,
} from "../meta-common/meta";

/**
 * Doc info form panel (PRD §8.2): the six text fields, the two date modes
 * and the XMP switch. Bound directly to the shared option values — every
 * keystroke is the worker's truth ("" = remove). Fields initialize from the
 * file's current metadata once the (cached) pdf.js read lands, and
 * re-initialize when the file itself changes.
 */

type FieldId = (typeof DI_IDS)["title" | "author" | "subject" | "keywords" | "creator" | "producer"];

interface FieldSpec {
  id: FieldId;
  labelKey: string;
  placeholderKey: string;
}

const FIELDS: FieldSpec[] = [
  { id: DI_IDS.title, labelKey: "meta.fTitle", placeholderKey: "meta.phTitle" },
  { id: DI_IDS.author, labelKey: "meta.fAuthor", placeholderKey: "meta.phAuthor" },
  { id: DI_IDS.subject, labelKey: "meta.fSubject", placeholderKey: "meta.phSubject" },
  { id: DI_IDS.keywords, labelKey: "meta.fKeywords", placeholderKey: "meta.phKeywords" },
  { id: DI_IDS.creator, labelKey: "meta.fCreator", placeholderKey: "meta.phCreator" },
  { id: DI_IDS.producer, labelKey: "meta.fProducer", placeholderKey: "meta.phProducer" },
];

const DATE_SELECTS: {
  id: (typeof DI_IDS)["creationMode" | "modMode"];
  labelKey: string;
}[] = [
  { id: DI_IDS.creationMode, labelKey: "meta.creationLabel" },
  { id: DI_IDS.modMode, labelKey: "meta.modLabel" },
];

const MODE_KEYS: Record<DateMode, string> = {
  keep: "meta.dateKeep",
  now: "meta.dateNow",
  remove: "meta.dateRemove",
};

function SectionTitle({
  icon,
  label,
}: {
  icon: React.ReactNode;
  label: string;
}): React.JSX.Element {
  return (
    <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      <span className="text-primary" aria-hidden="true">
        {icon}
      </span>
      {label}
    </p>
  );
}

export function DocInfoPanel({
  files,
  values,
  onChange,
}: ToolPanelProps): React.JSX.Element {
  const { t } = useI18n();
  // Instance-unique ids: the ToolShell mounts this panel in BOTH the desktop
  // aside and the mobile bottom sheet (only one is visible, but both are in
  // the DOM) — hardcoded ids would be duplicated and break label→input
  // associations + screen readers on mobile.
  const uid = useId();
  const fieldId = (id: string): string => `${uid}-di-${id}`;
  const file = files[0]?.file ?? null;
  // Snapshot tagged with its file — identity replaces any reset-on-change
  // (lint-clean; stale data for a swapped file never renders).
  const [snap, setSnap] = useState<
    { file: File; read: DocInfoRead | null } | null
  >(null);
  /** File id the current option values were initialized for. */
  const initForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void (async () => {
      const read = await getPdfDocInfo(file);
      if (cancelled) return;
      setSnap({ file, read });
    })().catch(() => {
      if (!cancelled) setSnap({ file, read: null });
    });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const snapshot = snap !== null && snap.file === file ? snap.read : null;

  // Initialize the form from the file's metadata — exactly once per file.
  // (Remount-safe: the ref guard makes StrictMode's double effect a no-op
  // the second time, and a REPLACED file re-initializes.)
  useEffect(() => {
    if (!file || snapshot === null) return;
    const fileKey = files[0]?.id ?? null;
    if (initForRef.current === fileKey) return;
    initForRef.current = fileKey;
    onChange(DI_IDS.title, snapshot.title);
    onChange(DI_IDS.author, snapshot.author);
    onChange(DI_IDS.subject, snapshot.subject);
    onChange(DI_IDS.keywords, snapshot.keywords);
    onChange(DI_IDS.creator, snapshot.creator);
    onChange(DI_IDS.producer, snapshot.producer);
    onChange(DI_IDS.creationMode, "keep");
    onChange(DI_IDS.modMode, "keep");
    onChange(DI_IDS.stripXmp, true);
    onChange(DI_IDS.stripCustom, false);
  }, [file, files, snapshot, onChange]);

  const ready = snapshot !== null;

  const textValue = (id: string): string =>
    typeof values[id] === "string" ? (values[id] as string) : "";

  const restoreOriginal = (): void => {
    if (!snapshot) return;
    onChange(DI_IDS.title, snapshot.title);
    onChange(DI_IDS.author, snapshot.author);
    onChange(DI_IDS.subject, snapshot.subject);
    onChange(DI_IDS.keywords, snapshot.keywords);
    onChange(DI_IDS.creator, snapshot.creator);
    onChange(DI_IDS.producer, snapshot.producer);
    onChange(DI_IDS.creationMode, "keep");
    onChange(DI_IDS.modMode, "keep");
    onChange(DI_IDS.stripXmp, true);
    onChange(DI_IDS.stripCustom, false);
  };

  const removeAll = (): void => {
    onChange(DI_IDS.title, "");
    onChange(DI_IDS.author, "");
    onChange(DI_IDS.subject, "");
    onChange(DI_IDS.keywords, "");
    onChange(DI_IDS.creator, "");
    onChange(DI_IDS.producer, "");
    onChange(DI_IDS.creationMode, "remove");
    onChange(DI_IDS.modMode, "remove");
    onChange(DI_IDS.stripXmp, true);
    onChange(DI_IDS.stripCustom, true);
  };

  return (
    <div className="flex flex-col gap-5">
      {/* The six text fields */}
      <div className="flex flex-col gap-4">
        <SectionTitle
          icon={<FileText className="size-3.5" />}
          label={t("meta.fieldsTitle")}
        />
        <div className="flex flex-col gap-4">
          {FIELDS.map((field) => (
            <div key={field.id} className="flex flex-col gap-2">
              <Label
                htmlFor={fieldId(field.id)}
                className="text-xs font-medium text-foreground"
              >
                {t(field.labelKey)}
              </Label>
              <Input
                id={fieldId(field.id)}
                type="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={600}
                disabled={!ready}
                placeholder={t(field.placeholderKey)}
                value={textValue(field.id)}
                onChange={(event) => onChange(field.id, event.target.value)}
                className="h-10 rounded-btn text-sm"
              />
            </div>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {t("meta.fieldHint")}
        </p>
      </div>

      {/* Dates */}
      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <SectionTitle
          icon={<CalendarDays className="size-3.5" />}
          label={t("meta.datesTitle")}
        />
        {DATE_SELECTS.map((select) => (
          <div key={select.id} className="flex flex-col gap-2">
            <Label className="text-xs font-medium text-foreground">
              {t(select.labelKey)}
            </Label>
            <Select
              value={
                typeof values[select.id] === "string"
                  ? (values[select.id] as string)
                  : "keep"
              }
              onValueChange={(next) => onChange(select.id, next)}
              disabled={!ready}
            >
              <SelectTrigger className="h-10 w-full rounded-btn">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DATE_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {t(MODE_KEYS[mode])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>

      {/* XMP + custom fields */}
      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <Label className="text-xs font-medium text-foreground">
              {t("meta.stripXmp")}
            </Label>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {t("meta.stripXmpHint")}
            </p>
          </div>
          <Switch
            checked={values[DI_IDS.stripXmp] === true}
            onCheckedChange={(next) => onChange(DI_IDS.stripXmp, next)}
            disabled={!ready}
            aria-label={t("meta.stripXmp")}
          />
        </div>
        {snapshot && snapshot.custom.length > 0 ? (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <Label className="text-xs font-medium text-foreground">
                {t("meta.stripCustom")}
              </Label>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {t("meta.stripCustomHint", { count: snapshot.custom.length })}
              </p>
            </div>
            <Switch
              checked={values[DI_IDS.stripCustom] === true}
              onCheckedChange={(next) => onChange(DI_IDS.stripCustom, next)}
              aria-label={t("meta.stripCustom")}
            />
          </div>
        ) : null}
      </div>

      {/* Quick actions */}
      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 w-full gap-1.5 rounded-btn text-xs"
          onClick={restoreOriginal}
          disabled={!ready}
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          {t("meta.restore")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 w-full gap-1.5 rounded-btn text-xs text-amber-700 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300"
          onClick={removeAll}
          disabled={!ready}
        >
          <Eraser className="size-3.5" aria-hidden="true" />
          {t("meta.removeAll")}
        </Button>
      </div>
    </div>
  );
}
