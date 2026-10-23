"use client";

import { useEffect, useMemo, useState } from "react";
import { Braces, Info, ShieldCheck, Trash2 } from "lucide-react";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/components/providers/locale-provider";
import type { ToolPanelProps } from "@/lib/tools/panel-types";
import { getPdfDocInfo } from "@/lib/pdf/thumbnails";
import { RM_IDS, type DocInfoRead } from "../meta-common/meta";

/**
 * Remove metadata panel (PRD §8.3): the summary of what the run will remove
 * and the XMP switch. The found-fields report itself lives in the surface
 * (main column); this panel keeps the choice + the honest scope notes.
 */

function Note({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <p className="flex items-start gap-2 rounded-card border border-border bg-muted/30 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
      <span className="mt-0.5 shrink-0 text-primary" aria-hidden="true">
        {icon}
      </span>
      <span>{children}</span>
    </p>
  );
}

export function RemoveMetaPanel({
  files,
  values,
  onChange,
}: ToolPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const file = files[0]?.file ?? null;
  // Snapshot tagged with its file — identity replaces any reset-on-change
  // (lint-clean; stale data for a swapped file never renders).
  const [snap, setSnap] = useState<
    { file: File; read: DocInfoRead | null } | null
  >(null);

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

  const alsoXmp = values[RM_IDS.alsoXmp] !== false;

  const counts = useMemo(() => {
    if (!snapshot) return null;
    let text = 0;
    if (snapshot.title !== "") text += 1;
    if (snapshot.author !== "") text += 1;
    if (snapshot.subject !== "") text += 1;
    if (snapshot.keywords !== "") text += 1;
    if (snapshot.creator !== "") text += 1;
    if (snapshot.producer !== "") text += 1;
    if (snapshot.creationDate !== null) text += 1;
    if (snapshot.modificationDate !== null) text += 1;
    text += snapshot.custom.length;
    return { fields: text, xmp: snapshot.hasXmp };
  }, [snapshot]);

  return (
    <div className="flex flex-col gap-4">
      {/* Summary */}
      <div className="rounded-card border border-border bg-muted/30 px-3 py-2.5">
        <p className="text-xs font-semibold text-foreground">
          {t("rmeta.summaryTitle")}
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {counts
            ? t("rmeta.summaryLine", {
                count: counts.fields,
                xmp: counts.xmp && alsoXmp ? t("rmeta.andXmp") : "",
              })
            : t("rmeta.loading")}
        </p>
      </div>

      {/* XMP switch */}
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Braces className="size-3.5 text-muted-foreground" aria-hidden="true" />
            {t("rmeta.alsoXmp")}
          </Label>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {t("rmeta.alsoXmpHint")}
          </p>
        </div>
        <Switch
          checked={alsoXmp}
          onCheckedChange={(next) => onChange(RM_IDS.alsoXmp, next)}
          disabled={!counts || !counts.xmp}
          aria-label={t("rmeta.alsoXmp")}
        />
      </div>

      {/* Honest scope notes */}
      <Note icon={<Info className="size-3.5" />}>{t("rmeta.noteId")}</Note>
      <Note icon={<ShieldCheck className="size-3.5" />}>
        {t("rmeta.noteExif")}
      </Note>
      <Note icon={<Trash2 className="size-3.5" />}>{t("rmeta.deepNote")}</Note>
    </div>
  );
}
