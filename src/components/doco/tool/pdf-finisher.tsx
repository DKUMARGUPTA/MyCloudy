"use client";

import { useMemo, useState } from "react";
import { ChevronDown, Lock, Hash, Droplets, Wand2 } from "lucide-react";

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
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/components/providers/locale-provider";
import type { ToolOutput } from "@/lib/workers/protocol";
import { downloadBlob, sanitizeFileName } from "@/lib/files/output";
import { cn } from "@/lib/utils";

/**
 * PDF finishing chain (P4) — optional final touches on ANY tool's PDF
 * output, applied in the browser with pdf-lib: watermark → page numbers
 * → password lock. Runs on the finished copy only (the original download
 * stays untouched); zero new server surface, everything on-device.
 */

const WM_COLORS = [
  { id: "gray", hex: "#6b7280" },
  { id: "red", hex: "#dc2626" },
  { id: "teal", hex: "#0f766e" },
  { id: "dark", hex: "#111827" },
] as const;

const NUM_POSITIONS = [
  "bottom-center",
  "bottom-right",
  "bottom-left",
  "top-center",
  "top-right",
  "top-left",
] as const;

type NumPosition = (typeof NUM_POSITIONS)[number];

export function PdfFinisher({ outputs }: { outputs: ToolOutput[] }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [wmOn, setWmOn] = useState(true);
  const [wmText, setWmText] = useState("DRAFT");
  const [wmOpacity, setWmOpacity] = useState(0.18);
  const [wmColor, setWmColor] = useState<(typeof WM_COLORS)[number]["id"]>("gray");
  const [numOn, setNumOn] = useState(false);
  const [numPosition, setNumPosition] = useState<NumPosition>("bottom-center");
  const [numFormat, setNumFormat] = useState("plain");
  const [lockOn, setLockOn] = useState(false);
  const [password, setPassword] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const pdfOutput = useMemo(
    () =>
      outputs.find(
        (o) => o.mime === "application/pdf" || o.name.toLowerCase().endsWith(".pdf")
      ) ?? null,
    [outputs]
  );

  if (!pdfOutput) return null;

  const apply = async () => {
    if (!pdfOutput) return;
    if (lockOn) {
      if (password.length < 6) {
        toast({ title: t("pdfFinish.pwShort"), variant: "destructive" });
        return;
      }
      if (password !== pwConfirm) {
        toast({ title: t("pdfFinish.pwMismatch"), variant: "destructive" });
        return;
      }
    }
    if (wmOn && wmText.trim().length === 0) {
      toast({ title: t("pdfFinish.wmEmpty"), variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const { PDFDocument, StandardFonts, rgb, degrees } = await import(
        "@cantoo/pdf-lib"
      );
      const bytes = new Uint8Array(await pdfOutput.blob.arrayBuffer());
      const doc = await PDFDocument.load(bytes, { updateMetadata: false });
      const font = await doc.embedFont(StandardFonts.HelveticaBold);

      if (wmOn) {
        const color =
          WM_COLORS.find((c) => c.id === wmColor)?.hex ?? "#6b7280";
        const r = parseInt(color.slice(1, 3), 16) / 255;
        const g = parseInt(color.slice(3, 5), 16) / 255;
        const b = parseInt(color.slice(5, 7), 16) / 255;
        for (const page of doc.getPages()) {
          const { width, height } = page.getSize();
          const text = wmText.trim().slice(0, 60);
          const size = Math.min(
            96,
            Math.max(28, (Math.hypot(width, height) / (text.length * 0.75)) * 1.1)
          );
          const tw = font.widthOfTextAtSize(text, size);
          page.drawText(text, {
            x: width / 2 - (tw / 2) * Math.cos((45 * Math.PI) / 180),
            y: height / 2 - (tw / 2) * Math.sin((45 * Math.PI) / 180),
            size,
            font,
            color: rgb(r, g, b),
            opacity: wmOpacity,
            rotate: degrees(45),
          });
        }
      }

      if (numOn) {
        const pages = doc.getPages();
        const total = pages.length;
        pages.forEach((page, i) => {
          const n = i + 1;
          const label =
            numFormat === "ofN"
              ? t("pdfFinish.numOfN", { n, total })
              : numFormat === "pageOfN"
                ? t("pdfFinish.numPageOfN", { n, total })
                : String(n);
          const size = 10;
          const tw = font.widthOfTextAtSize(label, size);
          const { width, height } = page.getSize();
          const margin = 32;
          let x = width / 2 - tw / 2;
          let y = margin;
          if (numPosition.endsWith("right")) x = width - margin - tw;
          if (numPosition.endsWith("left")) x = margin;
          if (numPosition.startsWith("top")) y = height - margin - size;
          page.drawText(label, {
            x,
            y,
            size,
            font,
            color: rgb(0.2, 0.22, 0.26),
          });
        });
      }

      if (lockOn) {
        await doc.encrypt({
          userPassword: password,
          ownerPassword: password,
          algorithm: "AES-256",
          permissions: {
            printing: "highResolution",
            copying: true,
            modifying: true,
            annotating: true,
            fillingForms: true,
            contentAccessibility: true,
            documentAssembly: true,
          },
        });
      }

      const finished = await doc.save();
      const base = pdfOutput.name.replace(/\.pdf$/i, "");
      const finishedName = sanitizeFileName(
        `${base}-finished.pdf`,
        "pdf"
      );
      downloadBlob(
        new Blob([finished as BlobPart], { type: "application/pdf" }),
        finishedName
      );
      toast({
        title: t("pdfFinish.doneTitle"),
        description: t("pdfFinish.doneDesc", {
          name: finishedName,
          watermark: wmOn ? t("pdfFinish.chkWm") : "",
          numbers: numOn ? t("pdfFinish.chkNum") : "",
          locked: lockOn ? t("pdfFinish.chkLock") : "",
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast({
        title: t("pdfFinish.errorTitle"),
        description: /encrypt/i.test(message)
          ? t("pdfFinish.errorEncrypted")
          : t("pdfFinish.errorGeneric"),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="mt-4 overflow-hidden rounded-card border border-border bg-card"
      aria-label={t("pdfFinish.heading")}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2.5 p-4 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Wand2 className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">
            {t("pdfFinish.heading")}
          </span>
          <span className="block text-xs text-muted-foreground">
            {t("pdfFinish.sub")}
          </span>
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180"
          )}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div className="flex flex-col gap-5 border-t border-border p-4">
          {/* Watermark */}
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-3">
              <Label
                htmlFor="pf-wm"
                className="flex items-center gap-2 text-sm font-medium"
              >
                <Droplets className="size-4 text-primary" aria-hidden="true" />
                {t("pdfFinish.wm")}
              </Label>
              <Switch
                id="pf-wm"
                checked={wmOn}
                onCheckedChange={setWmOn}
                aria-label={t("pdfFinish.wm")}
              />
            </div>
            {wmOn ? (
              <div className="flex flex-col gap-2.5 pl-6">
                <Input
                  value={wmText}
                  onChange={(e) => setWmText(e.target.value)}
                  maxLength={60}
                  placeholder={t("pdfFinish.wmPlaceholder")}
                  aria-label={t("pdfFinish.wmPlaceholder")}
                  className="h-11 rounded-btn sm:h-9"
                />
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {t("pdfFinish.opacity")}
                  </span>
                  <Slider
                    value={[Math.round(wmOpacity * 100)]}
                    min={5}
                    max={60}
                    step={1}
                    onValueChange={([v]) => setWmOpacity(v / 100)}
                    className="flex-1"
                    aria-label={t("pdfFinish.opacity")}
                  />
                  <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
                    {Math.round(wmOpacity * 100)}%
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {WM_COLORS.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      aria-label={t(`pdfFinish.color.${c.id}`)}
                      aria-pressed={wmColor === c.id}
                      onClick={() => setWmColor(c.id)}
                      className={cn(
                        "flex size-11 items-center justify-center rounded-btn border-2 outline-none transition-colors sm:size-9",
                        wmColor === c.id
                          ? "border-primary"
                          : "border-transparent hover:border-border"
                      )}
                    >
                      <span
                        className="size-4 rounded-full"
                        style={{ backgroundColor: c.hex }}
                      />
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          {/* Page numbers */}
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-3">
              <Label
                htmlFor="pf-num"
                className="flex items-center gap-2 text-sm font-medium"
              >
                <Hash className="size-4 text-primary" aria-hidden="true" />
                {t("pdfFinish.num")}
              </Label>
              <Switch
                id="pf-num"
                checked={numOn}
                onCheckedChange={setNumOn}
                aria-label={t("pdfFinish.num")}
              />
            </div>
            {numOn ? (
              <div className="grid grid-cols-2 gap-2.5 pl-6">
                <Select
                  value={numPosition}
                  onValueChange={(v) => setNumPosition(v as NumPosition)}
                >
                  <SelectTrigger
                    className="h-11 rounded-btn text-xs sm:h-9"
                    aria-label={t("pdfFinish.numPos")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {NUM_POSITIONS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {t(`pdfFinish.pos.${p}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={numFormat} onValueChange={setNumFormat}>
                  <SelectTrigger
                    className="h-11 rounded-btn text-xs sm:h-9"
                    aria-label={t("pdfFinish.numFmt")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="plain">1, 2, 3</SelectItem>
                    <SelectItem value="ofN">1 / N</SelectItem>
                    <SelectItem value="pageOfN">
                      {t("pdfFinish.fmtPageOfN")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>

          {/* Lock */}
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-3">
              <Label
                htmlFor="pf-lock"
                className="flex items-center gap-2 text-sm font-medium"
              >
                <Lock className="size-4 text-primary" aria-hidden="true" />
                {t("pdfFinish.lock")}
              </Label>
              <Switch
                id="pf-lock"
                checked={lockOn}
                onCheckedChange={setLockOn}
                aria-label={t("pdfFinish.lock")}
              />
            </div>
            {lockOn ? (
              <div className="grid gap-2.5 pl-6 sm:grid-cols-2">
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t("pdfFinish.pwPlaceholder")}
                  aria-label={t("pdfFinish.pwPlaceholder")}
                  className="h-11 rounded-btn sm:h-9"
                  autoComplete="new-password"
                />
                <Input
                  type="password"
                  value={pwConfirm}
                  onChange={(e) => setPwConfirm(e.target.value)}
                  placeholder={t("pdfFinish.pwConfirm")}
                  aria-label={t("pdfFinish.pwConfirm")}
                  className="h-11 rounded-btn sm:h-9"
                  autoComplete="new-password"
                />
              </div>
            ) : null}
          </div>

          <Button
            type="button"
            size="touch"
            className="w-full rounded-btn sm:w-auto sm:self-start"
            disabled={busy || (!wmOn && !numOn && !lockOn)}
            onClick={apply}
          >
            {busy ? t("pdfFinish.working") : t("pdfFinish.apply")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
