"use client";

/**
 * Create resume surface (CR-66 — the 66th DocoPDF tool). ATS-friendly
 * resume builder, 100% on-device (mode D), EN + हिंदी.
 *
 * Landing (create-card / create-fillable-pdf-form precedent — no files,
 * the workspace renders in place of the DropZone): template picker
 * (classic / modern / compact) with "start blank" and "start from
 * sample" starters, plus the ≤30 named saves.
 *
 * Editor: left form (header + photo with the HEIC-aware circle crop,
 * every section with ▲▼ reorder / add / remove, per-kind item editors,
 * bullet add/remove, accent colour, page size, template switch), right
 * live A4/Letter preview at exact CSS pt geometry (fit() port from
 * create-invoice; min-w-0 grid wrappers — the pinned preview-blows-out-
 * the-grid lesson). Test-render mode spawns the SAME worker and shows
 * the true PDF in an iframe. Export spawns the worker → .pdf download
 * with the localized name.
 *
 * State survives ToolShell phase remounts through the serialized
 * "resume" option (create-card pattern); the draft autosaves to
 * localStorage (dp_resume) and up to 30 named resumes live in
 * dp_resume_saved.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  Eye,
  FileDown,
  ImagePlus,
  Loader2,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { resolveHeicPreview } from "@/lib/heic/heic-preview";
import { downloadBlob } from "@/lib/files/output";
import type { WorkerResponse } from "@/lib/workers/protocol";
import {
  LIMITS,
  PAGE_PT,
  SECTION_KINDS,
  SOFT_WORD_CAP,
  TEMPLATES,
  approxMeasure,
  atsContactLine,
  blankResume,
  defaultSection,
  estimatePageBreaks,
  formatDateRange,
  joinMeta,
  newId,
  parseResumeRun,
  resumeStats,
  sampleResume,
} from "./model";
import type {
  CertificationItem,
  CustomItem,
  EducationItem,
  ExperienceItem,
  LanguageItem,
  ProjectItem,
  ResumeDoc,
  ResumeLocale,
  ResumePageSize,
  ResumeSection,
  ResumeSectionKind,
  ResumeTemplate,
  SkillGroup,
} from "./types";

/* ------------------------------------------------------------------ */
/* localStorage (draft + named saves)                                   */
/* ------------------------------------------------------------------ */

const DRAFT_KEY = "dp_resume";
const SAVED_KEY = "dp_resume_saved";
const MAX_SAVED = 30;

interface SavedResume {
  name: string;
  ts: number;
  doc: ResumeDoc;
}

function readDraft(): ResumeDoc | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    return parseResumeRun(JSON.stringify({ d: JSON.parse(raw) })).d;
  } catch {
    return null;
  }
}

function readSaved(): SavedResume[] {
  try {
    const list = JSON.parse(localStorage.getItem(SAVED_KEY) || "[]");
    return Array.isArray(list)
      ? list
          .filter(
            (x): x is SavedResume =>
              typeof x === "object" &&
              x !== null &&
              typeof (x as SavedResume).name === "string" &&
              typeof (x as SavedResume).ts === "number" &&
              typeof (x as SavedResume).doc === "object"
          )
          .slice(0, MAX_SAVED)
      : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Photo upload → ≤300 px CIRCLE-cropped PNG data-URL (HEIC fallback)   */
/* ------------------------------------------------------------------ */

function circleCrop(im: HTMLImageElement): string | null {
  const SIZE = 300;
  const cv = document.createElement("canvas");
  cv.width = SIZE;
  cv.height = SIZE;
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  const k = Math.min(im.width, im.height);
  const sx = (im.width - k) / 2;
  const sy = (im.height - k) / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(im, sx, sy, k, k, 0, 0, SIZE, SIZE);
  ctx.restore();
  return cv.toDataURL("image/png");
}

function decodeAndCrop(src: string): Promise<string | null> {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve(circleCrop(im));
    im.onerror = () => resolve(null);
    im.src = src;
  });
}

/** Optional portrait: square cover-crop, then an alpha circle mask —
 *  the PDF then just embeds the PNG (transparent corners = true circle). */
function fileToCirclePngDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      void decodeAndCrop(String(reader.result)).then((url) => {
        if (url) {
          resolve(url);
          return;
        }
        // Safari photos arrive as HEIC — decode with the self-hosted
        // libheif WASM preview (create-card recipe), then circle-crop.
        resolveHeicPreview(file, 300)
          .then((prev) => (prev ? decodeAndCrop(prev.url) : null))
          .catch(() => null)
          .then(resolve);
      });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/* ------------------------------------------------------------------ */
/* Preview CSS — exact pt geometry (44 pt margins, same sizes as model)  */
/* ------------------------------------------------------------------ */

const PREVIEW_CSS = `
#rsm-wrap{overflow:hidden}
#rsm-sheet{position:relative;background:#fff;color:#111;box-shadow:0 2px 14px #0003;
  transform-origin:0 0;font:10pt/1.38 "Noto Sans Devanagari","Nirmala UI",Helvetica,Arial,sans-serif}
#rsm-sheet .rsm-col{padding:44pt}
#rsm-sheet.rsm-compact{font:9.5pt/1.28 "Noto Sans Devanagari","Nirmala UI",Helvetica,Arial,sans-serif}
#rsm-sheet .rsm-name{font-size:22pt;font-weight:700;line-height:1.15;letter-spacing:0}
#rsm-sheet.rsm-compact .rsm-name{font-size:18pt}
#rsm-sheet .rsm-center{text-align:center}
#rsm-sheet .rsm-headline{color:#555;font-size:11.5pt;margin-top:2pt}
#rsm-sheet.rsm-compact .rsm-headline{font-size:10pt}
#rsm-sheet .rsm-contact{margin-top:4pt;font-size:9.5pt}
#rsm-sheet.rsm-compact .rsm-contact{font-size:8.5pt}
#rsm-sheet .rsm-hr{border-top:1pt solid #333;margin:8pt 0 14pt}
#rsm-sheet.rsm-compact .rsm-hr{margin:6pt 0 9pt}
#rsm-sheet .rsm-photo-float{position:absolute;top:44pt;right:44pt;width:64pt;height:64pt;border-radius:50%;object-fit:cover}
#rsm-sheet.rsm-compact .rsm-photo-float{width:52pt;height:52pt}
#rsm-sheet .rsm-title{font-size:11pt;font-weight:700;text-transform:uppercase;
  border-bottom:.75pt solid #b8b8b8;padding-bottom:3pt;margin:14pt 0 7pt}
#rsm-sheet.rsm-compact .rsm-title{font-size:10pt;margin:10pt 0 5pt}
#rsm-sheet .rsm-item{margin:0 0 10pt}
#rsm-sheet.rsm-compact .rsm-item{margin:0 0 7pt}
#rsm-sheet .rsm-itemhead{display:flex;justify-content:space-between;gap:8pt;font-size:10.5pt;font-weight:700}
#rsm-sheet.rsm-compact .rsm-itemhead{font-size:9.5pt}
#rsm-sheet .rsm-itemdate{font-weight:400;color:#555;font-size:9.5pt;white-space:nowrap;flex:0 0 auto}
#rsm-sheet .rsm-meta{color:#555;font-size:9pt}
#rsm-sheet ul{margin:3pt 0 0;padding-left:12pt;list-style:disc outside}
#rsm-sheet li{margin:1pt 0}
#rsm-sheet .rsm-skname{font-weight:700}
#rsm-sheet .rsm-modern{display:flex;align-items:stretch}
#rsm-sheet .rsm-side{width:181.42pt;background:var(--ac,#0b6b4d);color:var(--side-ink,#fff);padding:44pt 24pt}
#rsm-sheet .rsm-side .rsm-photo{width:92pt;height:92pt;border-radius:50%;object-fit:cover;display:block;margin:0 auto 14pt}
#rsm-sheet .rsm-side .rsm-slabel{font-weight:700;font-size:8.5pt;text-transform:uppercase;margin:12pt 0 3pt;letter-spacing:0}
#rsm-sheet .rsm-side .rsm-skillname{font-weight:700;font-size:10pt;margin-top:6pt}
#rsm-sheet .rsm-side .rsm-skillitems{font-size:9pt}
#rsm-sheet .rsm-main{flex:1;min-width:0;padding:44pt 44pt 44pt 28pt}
#rsm-sheet .rsm-main .rsm-name{font-size:20pt}
#rsm-sheet .rsm-main .rsm-hr{border-top:1.25pt solid var(--ac,#0b6b4d)}
@media print{
  body *{visibility:hidden!important}
  #rsm-sheet,#rsm-sheet *{visibility:visible!important}
  #rsm-wrap{height:auto!important;overflow:visible!important}
  #rsm-sheet{position:absolute!important;left:0!important;top:0!important;transform:none!important;
    margin:0!important;box-shadow:none!important}
  @page{margin:0}
}`;

/* ------------------------------------------------------------------ */
/* Small shared UI bits                                                 */
/* ------------------------------------------------------------------ */

const TOOL_BTN =
  "h-11 min-h-11 gap-1.5 rounded-btn px-3 text-xs font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50";
const inputCls =
  "h-11 min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";
const selCls =
  "h-11 min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

/** kind → i18n key (kept as literals so the merge script cross-checks them). */
const KIND_LABEL: Record<ResumeSectionKind, string> = {
  summary: "resume.secSummary",
  experience: "resume.secExperience",
  education: "resume.secEducation",
  skills: "resume.secSkills",
  projects: "resume.secProjects",
  certifications: "resume.secCertifications",
  languages: "resume.secLanguages",
  custom: "resume.secCustom",
};

const TEMPLATE_LABEL: Record<ResumeTemplate, string> = {
  classic: "resume.tplClassic",
  modern: "resume.tplModern",
  compact: "resume.tplCompact",
};

const TEMPLATE_DESC: Record<ResumeTemplate, string> = {
  classic: "resume.tplClassicDesc",
  modern: "resume.tplModernDesc",
  compact: "resume.tplCompactDesc",
};

type MobileTab = "form" | "preview";

/* ------------------------------------------------------------------ */
/* Item factories                                                       */
/* ------------------------------------------------------------------ */

const newExperience = (): ExperienceItem => ({
  id: newId("exp"),
  role: "",
  company: "",
  location: "",
  start: "",
  end: "",
  current: false,
  bullets: [""],
});
const newEducation = (): EducationItem => ({
  id: newId("edu"),
  degree: "",
  school: "",
  location: "",
  start: "",
  end: "",
  grade: "",
});
const newSkillGroup = (): SkillGroup => ({ id: newId("grp"), name: "", items: [""] });
const newProject = (): ProjectItem => ({
  id: newId("prj"),
  name: "",
  link: "",
  description: "",
});
const newCertification = (): CertificationItem => ({
  id: newId("crt"),
  name: "",
  issuer: "",
  year: "",
});
const newLanguage = (): LanguageItem => ({
  id: newId("lng"),
  name: "",
  level: "",
});
const newCustom = (): CustomItem => ({ id: newId("cst"), title: "", text: "" });

/* ------------------------------------------------------------------ */
/* Surface                                                              */
/* ------------------------------------------------------------------ */

export function ResumeSurface(props: ToolSurfaceProps): ReactNode {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const { values, onChange } = props;
  const runLocale: ResumeLocale = locale === "hi" ? "hi" : "en";

  /* ---------- one-time boot: serialized option + draft ---------- */
  const [boot] = useState(() => {
    let view: "home" | "edit" = "home";
    let doc: ResumeDoc | null = null;
    const raw = typeof values.resume === "string" ? values.resume : "";
    if (raw !== "") {
      try {
        const p = JSON.parse(raw) as {
          v?: unknown;
          d?: unknown;
        };
        if (p && typeof p === "object") {
          // parseResumeRun is the worker-boundary parser — a stale or
          // corrupt option can never crash us (clamped + coerced).
          doc = parseResumeRun(JSON.stringify({ d: p.d })).d;
          view = p.v === "edit" ? "edit" : "home";
        }
      } catch {
        /* unreadable option — fall through to the draft */
      }
    }
    if (!doc && typeof document !== "undefined") {
      const draft = readDraft();
      if (draft) {
        doc = draft;
        view = "edit";
      }
    }
    return { view, doc };
  });

  const [view, setView] = useState<"home" | "edit">(boot.view);
  const [doc, setDoc] = useState<ResumeDoc>(
    () => boot.doc ?? blankResume(runLocale)
  );
  const [mobileTab, setMobileTab] = useState<MobileTab>("form");
  const [savedList, setSavedList] = useState<SavedResume[]>(() =>
    typeof document === "undefined" ? [] : readSaved()
  );
  const [savedIdx, setSavedIdx] = useState("");
  const [saveName, setSaveName] = useState("");
  const [exportPct, setExportPct] = useState<number | null>(null);
  const [renderUrl, setRenderUrl] = useState<string | null>(null);
  const [renderPages, setRenderPages] = useState(0);
  const [fontsTick, setFontsTick] = useState(0);
  const [addKind, setAddKind] = useState<ResumeSectionKind>("experience");

  /* ---------- option sync (stable — ToolShell's onChange has empty deps) ---------- */
  const syncOption = useCallback(
    (next: ResumeDoc, nextView: "home" | "edit"): void => {
      onChange("resume", JSON.stringify({ v: nextView, d: next }));
    },
    [onChange]
  );

  // Latest-value mirror (create-card pattern): event handlers read
  // docRef so closures never go stale; written in effects + event handlers.
  const docRef = useRef(doc);
  useEffect(() => {
    docRef.current = doc;
    // option persistence rides the doc effect (commit/update stay
    // ref-free so render-called helpers never touch refs — react-hooks/refs)
    syncOption(doc, view);
  }, [doc, syncOption, view]);
  const workerRef = useRef<Worker | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const renderUrlRef = useRef<string | null>(null);
  useEffect(() => {
    renderUrlRef.current = renderUrl;
  }, [renderUrl]);

  /* ---------- fonts for the preview (self-hosted Devanagari) ---------- */
  useEffect(() => {
    const face = new FontFace(
      "Noto Sans Devanagari",
      "url(/fonts/NotoSansDevanagari-Regular.ttf)"
    );
    document.fonts.add(face);
    let alive = true;
    void face
      .load()
      .then(() => {
        if (alive) setFontsTick((tick) => tick + 1);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      document.fonts.delete(face);
    };
  }, []);

  const commit = useCallback(
    (next: ResumeDoc): void => {
      setDoc(next);
    },
    []
  );

  const update = useCallback(
    (fn: (d: ResumeDoc) => ResumeDoc): void => {
      setDoc((prev) => fn(prev));
    },
    []
  );

  const initialSync = useRef(false);
  useEffect(() => {
    if (initialSync.current) return;
    initialSync.current = true;
    void Promise.resolve().then(() => {
      syncOption(docRef.current, view);
    });
  }, [syncOption, view]);

  /* ---------- draft autosave ---------- */
  useEffect(() => {
    if (view !== "edit") return;
    const id = window.setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(doc));
      } catch {
        /* storage full — best-effort */
      }
    }, 500);
    return () => window.clearTimeout(id);
  }, [doc, view]);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
      if (renderUrlRef.current) URL.revokeObjectURL(renderUrlRef.current);
    };
  }, []);

  /* ---------- derived ---------- */
  const stats = useMemo(() => resumeStats(doc), [doc]);
  const estPages = useMemo(
    () => estimatePageBreaks(doc, approxMeasure, runLocale, t("resume.present")),
    [doc, runLocale, t]
  );
  const pagePt = PAGE_PT[doc.pageSize];

  /** Labels for the PDF run — resolved NOW, in the current locale. */
  const buildLabels = useCallback((): Record<string, string> => {
    return {
      present: t("resume.present"),
      fileWord: t("resume.fileWord"),
      contact: t("resume.contactLbl"),
    };
  }, [t]);

  /* ---------- view switching ---------- */
  const goHome = useCallback((): void => {
    setView("home");
    syncOption(docRef.current, "home");
  }, [syncOption]);

  const startWith = useCallback(
    (base: "blank" | "sample", template: ResumeTemplate): void => {
      const d =
        base === "sample" ? sampleResume(runLocale) : blankResume(runLocale);
      d.template = template;
      docRef.current = d;
      setDoc(d);
      setView("edit");
      syncOption(d, "edit");
    },
    [runLocale, syncOption]
  );

  /* ---------- header + design ---------- */
  const setHeader = useCallback(
    (field: keyof ResumeDoc["header"], value: string): void => {
      update((d) => ({ ...d, header: { ...d.header, [field]: value } }));
    },
    [update]
  );

  const onPhoto = useCallback(
    async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
      const f = e.target.files?.[0];
      e.target.value = "";
      if (!f) return;
      const url = await fileToCirclePngDataUrl(f);
      if (url) setHeader("photo", url);
      else
        toast({
          title: t("tool.errorTitle"),
          description: t("resume.photoBad"),
          variant: "destructive",
        });
    },
    [setHeader, t, toast]
  );

  /* ---------- section ops ---------- */
  const updateSection = useCallback(
    (id: string, fn: (s: ResumeSection) => ResumeSection): void => {
      update((d) => ({
        ...d,
        sections: d.sections.map((s) => (s.id === id ? fn(s) : s)),
      }));
    },
    [update]
  );

  const addSection = useCallback(
    (kind: ResumeSectionKind): void => {
      update((d) => ({
        ...d,
        sections: [...d.sections, defaultSection(kind, runLocale)],
      }));
    },
    [runLocale, update]
  );

  const removeSection = useCallback(
    (id: string): void => {
      update((d) => ({ ...d, sections: d.sections.filter((s) => s.id !== id) }));
    },
    [update]
  );

  const moveSection = useCallback(
    (id: string, dir: -1 | 1): void => {
      update((d) => {
        const i = d.sections.findIndex((s) => s.id === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= d.sections.length) return d;
        const sections = d.sections.slice();
        [sections[i], sections[j]] = [sections[j], sections[i]];
        return { ...d, sections };
      });
    },
    [update]
  );

  /* ---------- per-kind item helpers ---------- */
  const expOp = useCallback(
    (secId: string, fn: (items: ExperienceItem[]) => ExperienceItem[]): void =>
      updateSection(secId, (s) =>
        s.kind === "experience" ? { ...s, items: fn(s.items) } : s
      ),
    [updateSection]
  );
  const eduOp = useCallback(
    (secId: string, fn: (items: EducationItem[]) => EducationItem[]): void =>
      updateSection(secId, (s) =>
        s.kind === "education" ? { ...s, items: fn(s.items) } : s
      ),
    [updateSection]
  );
  const skOp = useCallback(
    (secId: string, fn: (groups: SkillGroup[]) => SkillGroup[]): void =>
      updateSection(secId, (s) =>
        s.kind === "skills" ? { ...s, groups: fn(s.groups) } : s
      ),
    [updateSection]
  );
  const prjOp = useCallback(
    (secId: string, fn: (items: ProjectItem[]) => ProjectItem[]): void =>
      updateSection(secId, (s) =>
        s.kind === "projects" ? { ...s, items: fn(s.items) } : s
      ),
    [updateSection]
  );
  const crtOp = useCallback(
    (secId: string, fn: (items: CertificationItem[]) => CertificationItem[]): void =>
      updateSection(secId, (s) =>
        s.kind === "certifications" ? { ...s, items: fn(s.items) } : s
      ),
    [updateSection]
  );
  const lngOp = useCallback(
    (secId: string, fn: (items: LanguageItem[]) => LanguageItem[]): void =>
      updateSection(secId, (s) =>
        s.kind === "languages" ? { ...s, items: fn(s.items) } : s
      ),
    [updateSection]
  );
  const cstOp = useCallback(
    (secId: string, fn: (items: CustomItem[]) => CustomItem[]): void =>
      updateSection(secId, (s) =>
        s.kind === "custom" ? { ...s, items: fn(s.items) } : s
      ),
    [updateSection]
  );

  /* ---------- saved resumes ---------- */
  const defaultSaveName = useCallback((): string => {
    const n = doc.header.fullName.trim();
    if (n) return n.slice(0, 60);
    return t("resume.untitled");
  }, [doc.header.fullName, t]);

  const saveCurrent = useCallback((): void => {
    const name = saveName.trim() || defaultSaveName();
    const entry: SavedResume = { name, ts: Date.now(), doc: docRef.current };
    const list = [entry, ...savedList.filter((x) => x.name !== name)].slice(
      0,
      MAX_SAVED
    );
    setSavedList(list);
    setSaveName("");
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(list));
      toast({ title: t("resume.savedTitle2"), description: name });
    } catch {
      toast({
        title: t("resume.saveFullTitle"),
        description: t("resume.saveFull"),
        variant: "destructive",
      });
    }
  }, [saveName, defaultSaveName, savedList, t, toast]);

  const loadSaved = useCallback(
    (idx: string): void => {
      setSavedIdx(idx);
      const entry = savedList[Number(idx)];
      if (!entry) return;
      const d = parseResumeRun(JSON.stringify({ d: entry.doc })).d;
      docRef.current = d;
      setDoc(d);
      setView("edit");
      syncOption(d, "edit");
    },
    [savedList, syncOption]
  );

  const deleteSaved = useCallback(
    (name: string): void => {
      const list = savedList.filter((x) => x.name !== name);
      setSavedList(list);
      setSavedIdx("");
      try {
        localStorage.setItem(SAVED_KEY, JSON.stringify(list));
      } catch {
        /* best-effort */
      }
    },
    [savedList]
  );

  /* ---------- fit-to-width (create-invoice fit() port) ---------- */
  const fit = useCallback((): void => {
    const wrap = wrapRef.current;
    const sheet = sheetRef.current;
    if (!wrap || !sheet) return;
    sheet.style.transform = "none";
    const k = Math.min(1, wrap.clientWidth / sheet.offsetWidth);
    sheet.style.transform = `scale(${k})`;
    wrap.style.height = sheet.offsetHeight * k + "px";
  }, []);

  useEffect(() => {
    fit();
    const onResize = () => fit();
    window.addEventListener("resize", onResize);
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => fit())
        : null;
    if (ro && wrapRef.current) ro.observe(wrapRef.current);
    return () => {
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
    };
  }, [fit]);

  useEffect(() => {
    fit();
  }, [fit, doc, view, mobileTab, locale, fontsTick, renderUrl]);

  /* ---------- worker spawn (export + test-render share one path) ---------- */
  const spawnRun = useCallback(
    (mode: "download" | "preview"): void => {
      if (workerRef.current) return;
      setExportPct(0);
      const worker = new Worker(new URL("./worker.ts", import.meta.url), {
        type: "module",
      });
      workerRef.current = worker;
      const runId = Date.now();
      const cleanup = (): void => {
        worker.terminate();
        if (workerRef.current === worker) workerRef.current = null;
      };
      worker.addEventListener(
        "message",
        (event: MessageEvent<WorkerResponse>) => {
          const data = event.data;
          if (!data || data.runId !== runId) return;
          if (data.type === "progress") {
            setExportPct(data.pct);
            return;
          }
          if (data.type === "result") {
            setExportPct(null);
            const output = data.outputs[0];
            if (output) {
              if (mode === "download") {
                downloadBlob(output.blob, output.name);
                toast({
                  title: t("resume.doneTitle"),
                  description: t("resume.doneDesc", { name: output.name }),
                });
              } else {
                if (renderUrlRef.current) URL.revokeObjectURL(renderUrlRef.current);
                setRenderUrl(URL.createObjectURL(output.blob));
                setRenderPages(data.detail?.pages ?? 0);
                toast({
                  title: t("resume.renderTitle"),
                  description: t("resume.renderDesc", {
                    pages: data.detail?.pages ?? 0,
                  }),
                });
              }
            }
            cleanup();
            return;
          }
          if (data.type === "error") {
            setExportPct(null);
            toast({
              title: t("tool.errorTitle"),
              description: t("tool.errorGeneric"),
              variant: "destructive",
            });
            cleanup();
          }
        }
      );
      worker.addEventListener("error", () => {
        setExportPct(null);
        toast({
          title: t("tool.errorTitle"),
          description: t("tool.errorGeneric"),
          variant: "destructive",
        });
        cleanup();
      });
      worker.postMessage({
        type: "run",
        runId,
        toolId: "create-resume",
        options: {
          resume: JSON.stringify({
            d: docRef.current,
            labels: buildLabels(),
            locale: runLocale,
          }),
        },
        files: [],
      });
    },
    [buildLabels, runLocale, t, toast]
  );

  const closeRender = useCallback((): void => {
    if (renderUrlRef.current) URL.revokeObjectURL(renderUrlRef.current);
    setRenderUrl(null);
    setRenderPages(0);
  }, []);

  /* ================================================================= */
  /* HOME view — template picker + starters + saved                     */
  /* ================================================================= */

  const templateCards: {
    id: ResumeTemplate;
    mock: ReactNode;
  }[] = [
    {
      id: "classic",
      mock: (
        <>
          <span className="mx-auto block h-3 w-2/3 rounded-sm bg-foreground/80" />
          <span className="mx-auto mt-1 block h-1.5 w-1/2 rounded-sm bg-foreground/25" />
          <span className="mt-3 block h-2 w-full border-b border-foreground/40 pb-1" />
          <span className="mt-1.5 block h-1.5 w-full rounded-sm bg-foreground/30" />
          <span className="mt-1 block h-1.5 w-11/12 rounded-sm bg-foreground/30" />
          <span className="mt-1 block h-1.5 w-4/5 rounded-sm bg-foreground/30" />
          <span className="mt-3 block h-2 w-full border-b border-foreground/40 pb-1" />
          <span className="mt-1.5 block h-1.5 w-full rounded-sm bg-foreground/30" />
        </>
      ),
    },
    {
      id: "modern",
      mock: (
        <div className="flex h-full w-full gap-1.5">
          <span className="block w-1/3 rounded-sm" style={{ background: "var(--ac)" }} />
          <span className="flex flex-1 flex-col gap-1 py-1">
            <span className="block h-2.5 w-3/4 rounded-sm bg-foreground/80" />
            <span className="block h-1.5 w-1/2 rounded-sm bg-foreground/25" />
            <span className="mt-1 block h-1.5 w-full rounded-sm bg-foreground/30" />
            <span className="block h-1.5 w-full rounded-sm bg-foreground/30" />
            <span className="mt-1 block h-1.5 w-5/6 rounded-sm bg-foreground/30" />
          </span>
        </div>
      ),
    },
    {
      id: "compact",
      mock: (
        <>
          <span className="block h-2.5 w-1/2 rounded-sm bg-foreground/80" />
          <span className="mt-0.5 block h-1.5 w-2/5 rounded-sm bg-foreground/25" />
          <span className="mt-2 block h-1.5 w-full rounded-sm bg-foreground/30" />
          <span className="mt-0.5 block h-1.5 w-11/12 rounded-sm bg-foreground/30" />
          <span className="mt-0.5 block h-1.5 w-11/12 rounded-sm bg-foreground/30" />
          <span className="mt-2 block h-1.5 w-full rounded-sm bg-foreground/30" />
          <span className="mt-0.5 block h-1.5 w-5/6 rounded-sm bg-foreground/30" />
          <span className="mt-0.5 block h-1.5 w-4/5 rounded-sm bg-foreground/30" />
        </>
      ),
    },
  ];

  const homeView = (
    <section className="flex flex-col gap-6" aria-label={t("resume.pickTitle")}>
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          {t("resume.pickTitle")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("resume.pickDesc")}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => startWith("blank", docRef.current.template)}
          className="flex min-h-11 flex-col items-start gap-1 rounded-card border border-border bg-card p-4 text-left transition-colors hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <span className="text-sm font-semibold text-foreground">
            {t("resume.startBlank")}
          </span>
          <span className="text-xs text-muted-foreground">
            {t("resume.blankHint")}
          </span>
        </button>
        <button
          type="button"
          onClick={() => startWith("sample", docRef.current.template)}
          className="flex min-h-11 flex-col items-start gap-1 rounded-card border border-border bg-card p-4 text-left transition-colors hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <span className="text-sm font-semibold text-foreground">
            {t("resume.startSample")}
          </span>
          <span className="text-xs text-muted-foreground">
            {t("resume.sampleHint")}
          </span>
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {TEMPLATES.map((tpl, i) => (
          <article
            key={tpl}
            className="flex flex-col gap-3 rounded-card border border-border bg-card p-4"
          >
            <div
              aria-hidden="true"
              className="flex h-36 flex-col rounded-md border border-border bg-background p-3"
              style={{ "--ac": doc.accentColor } as CSSProperties}
            >
              {templateCards[i].mock}
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                {t(TEMPLATE_LABEL[tpl])}
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {t(TEMPLATE_DESC[tpl])}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                className={`${TOOL_BTN} flex-1 font-semibold`}
                onClick={() => startWith("blank", tpl)}
              >
                {t("resume.useBlank")}
              </Button>
              <Button
                type="button"
                variant="outline"
                className={`${TOOL_BTN} flex-1`}
                onClick={() => startWith("sample", tpl)}
              >
                {t("resume.useSample")}
              </Button>
            </div>
          </article>
        ))}
      </div>

      <div className="rounded-card border border-border bg-card p-4">
        <h2 className="text-sm font-semibold text-foreground">
          {t("resume.savedTitle")}
        </h2>
        {savedList.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {t("resume.savedEmpty")}
          </p>
        ) : (
          <ul className="mt-3 flex max-h-96 flex-col gap-2 overflow-y-auto pr-1">
            {savedList.map((entry) => (
              <li
                key={entry.name}
                className="flex items-center justify-between gap-3 rounded-btn border border-border bg-background px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                  {entry.name}
                  <span className="ml-2 text-muted-foreground">
                    {new Date(entry.ts).toLocaleDateString(
                      locale === "hi" ? "hi-IN" : "en-IN"
                    )}
                  </span>
                </span>
                <span className="flex flex-none gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 min-h-11 px-3 text-xs"
                    onClick={() => {
                      const idx = String(
                        savedList.findIndex((x) => x.name === entry.name)
                      );
                      loadSaved(idx);
                    }}
                  >
                    {t("resume.open")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="size-11 min-h-11"
                    aria-label={t("resume.delSaved")}
                    title={t("resume.delSaved")}
                    onClick={() => deleteSaved(entry.name)}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );

  /* ================================================================= */
  /* EDITOR — per-section form editors                                  */
  /* ================================================================= */

  const sectionToolbar = (s: ResumeSection): ReactNode => (
    <div className="flex flex-none items-center gap-1">
      <button
        type="button"
        aria-label={t("resume.moveUp")}
        onClick={() => moveSection(s.id, -1)}
        className="flex size-8 items-center justify-center rounded-md border border-border bg-background text-foreground transition-colors hover:bg-muted"
      >
        <ArrowUp className="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label={t("resume.moveDown")}
        onClick={() => moveSection(s.id, 1)}
        className="flex size-8 items-center justify-center rounded-md border border-border bg-background text-foreground transition-colors hover:bg-muted"
      >
        <ArrowDown className="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label={t("resume.removeSection")}
        onClick={() => removeSection(s.id)}
        className="flex size-8 items-center justify-center rounded-md border border-border bg-background text-lg leading-none text-destructive transition-colors hover:bg-destructive/10"
      >
        ×
      </button>
    </div>
  );

  const itemToolbar = (
    onUp: () => void,
    onDown: () => void,
    onRemove: () => void
  ): ReactNode => (
    <span className="flex flex-none gap-1">
      <button
        type="button"
        aria-label={t("resume.moveUp")}
        onClick={onUp}
        className="flex size-8 items-center justify-center rounded-md border border-border bg-background transition-colors hover:bg-muted"
      >
        <ArrowUp className="size-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label={t("resume.moveDown")}
        onClick={onDown}
        className="flex size-8 items-center justify-center rounded-md border border-border bg-background transition-colors hover:bg-muted"
      >
        <ArrowDown className="size-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label={t("resume.removeItem")}
        onClick={onRemove}
        className="flex size-8 items-center justify-center rounded-md border border-border bg-background text-base leading-none text-destructive transition-colors hover:bg-destructive/10"
      >
        ×
      </button>
    </span>
  );

  const moveItem = <T,>(arr: T[], i: number, dir: -1 | 1): T[] => {
    const j = i + dir;
    if (j < 0 || j >= arr.length) return arr;
    const next = arr.slice();
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  };

  const renderSectionEditor = (s: ResumeSection, si: number): ReactNode => {
    const head = (
      <div className="flex items-center gap-2">
        <span className="flex-1 truncate text-xs font-medium text-muted-foreground">
          {t(KIND_LABEL[s.kind])}
        </span>
        {sectionToolbar(s)}
      </div>
    );
    const titleInput = (
      <Input
        value={s.title}
        maxLength={LIMITS.sectionTitle}
        onChange={(e) =>
          updateSection(s.id, (prev) => ({ ...prev, title: e.target.value }))
        }
        aria-label={t("resume.sectionTitle")}
        placeholder={t("resume.sectionTitle")}
        className="mt-1.5 h-11 min-h-11 text-sm font-semibold"
      />
    );
    return (
      <div
        key={s.id}
        className="flex flex-col gap-2.5 rounded-lg border bg-card p-4"
      >
        {head}
        {titleInput}
        {si > -1 ? null : null}

        {s.kind === "summary" ? (
          <Textarea
            rows={4}
            value={s.text}
            maxLength={LIMITS.summary}
            onChange={(e) =>
              updateSection(s.id, (prev) =>
                prev.kind === "summary"
                  ? { ...prev, text: e.target.value }
                  : prev
              )
            }
            placeholder={t("resume.phSummary")}
          />
        ) : null}

        {s.kind === "experience"
          ? s.items.map((it, ii) => (
              <div
                key={it.id}
                className="flex flex-col gap-2 rounded-md border bg-background p-3"
              >
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-[11px] font-medium text-muted-foreground">
                    {t("resume.expItem", { n: ii + 1 })}
                  </span>
                  {itemToolbar(
                    () =>
                      expOp(s.id, (items) => moveItem(items, ii, -1)),
                    () => expOp(s.id, (items) => moveItem(items, ii, 1)),
                    () =>
                      expOp(s.id, (items) => items.filter((x) => x.id !== it.id))
                  )}
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      {t("resume.role")}
                    </Label>
                    <Input
                      className="mt-1 h-11 min-h-11"
                      value={it.role}
                      maxLength={LIMITS.role}
                      placeholder={t("resume.phRole")}
                      onChange={(e) =>
                        expOp(s.id, (items) =>
                          items.map((x) =>
                            x.id === it.id ? { ...x, role: e.target.value } : x
                          )
                        )
                      }
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      {t("resume.company")}
                    </Label>
                    <Input
                      className="mt-1 h-11 min-h-11"
                      value={it.company}
                      maxLength={LIMITS.company}
                      placeholder={t("resume.phCompany")}
                      onChange={(e) =>
                        expOp(s.id, (items) =>
                          items.map((x) =>
                            x.id === it.id ? { ...x, company: e.target.value } : x
                          )
                        )
                      }
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      {t("resume.location")}
                    </Label>
                    <Input
                      className="mt-1 h-11 min-h-11"
                      value={it.location}
                      maxLength={LIMITS.company}
                      placeholder={t("resume.phLocation")}
                      onChange={(e) =>
                        expOp(s.id, (items) =>
                          items.map((x) =>
                            x.id === it.id
                              ? { ...x, location: e.target.value }
                              : x
                          )
                        )
                      }
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs text-muted-foreground">
                        {t("resume.startLbl")}
                      </Label>
                      <Input
                        className="mt-1 h-11 min-h-11 font-mono text-xs"
                        value={it.start}
                        maxLength={LIMITS.date}
                        placeholder="2021-06"
                        onChange={(e) =>
                          expOp(s.id, (items) =>
                            items.map((x) =>
                              x.id === it.id ? { ...x, start: e.target.value } : x
                            )
                          )
                        }
                      />
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">
                        {t("resume.endLbl")}
                      </Label>
                      <Input
                        className="mt-1 h-11 min-h-11 font-mono text-xs"
                        value={it.current ? "" : it.end}
                        maxLength={LIMITS.date}
                        placeholder="2023-03"
                        disabled={it.current}
                        onChange={(e) =>
                          expOp(s.id, (items) =>
                            items.map((x) =>
                              x.id === it.id ? { ...x, end: e.target.value } : x
                            )
                          )
                        }
                      />
                    </div>
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={it.current}
                    onCheckedChange={(v) =>
                      expOp(s.id, (items) =>
                        items.map((x) =>
                          x.id === it.id ? { ...x, current: v === true } : x
                        )
                      )
                    }
                    className="size-5"
                  />
                  {t("resume.currentLbl")}
                </label>
                <div className="flex flex-col gap-1.5">
                  {it.bullets.map((b, bi) => (
                    <div key={bi} className="flex items-center gap-1.5">
                      <Input
                        className="h-11 min-h-11 text-xs"
                        value={b}
                        maxLength={LIMITS.bullet}
                        placeholder={t("resume.phBullet")}
                        onChange={(e) =>
                          expOp(s.id, (items) =>
                            items.map((x) =>
                              x.id === it.id
                                ? {
                                    ...x,
                                    bullets: x.bullets.map((y, yi) =>
                                      yi === bi ? e.target.value : y
                                    ),
                                  }
                                : x
                            )
                          )
                        }
                      />
                      <button
                        type="button"
                        aria-label={t("resume.removeBullet")}
                        onClick={() =>
                          expOp(s.id, (items) =>
                            items.map((x) =>
                              x.id === it.id
                                ? {
                                    ...x,
                                    bullets: x.bullets.filter(
                                      (_, yi) => yi !== bi
                                    ),
                                  }
                                : x
                            )
                          )
                        }
                        className="flex size-11 min-h-11 items-center justify-center rounded-md text-lg text-destructive transition-colors hover:bg-destructive/10"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-11 min-h-11 w-full text-xs"
                    disabled={it.bullets.length >= 12}
                    onClick={() =>
                      expOp(s.id, (items) =>
                        items.map((x) =>
                          x.id === it.id
                            ? { ...x, bullets: [...x.bullets, ""] }
                            : x
                        )
                      )
                    }
                  >
                    <Plus className="size-4" aria-hidden="true" />
                    {t("resume.addBullet")}
                  </Button>
                </div>
              </div>
            ))
          : null}

        {s.kind === "experience" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 min-h-11 w-full text-xs"
            onClick={() =>
              expOp(s.id, (items) => [...items, newExperience()])
            }
          >
            <Plus className="size-4" aria-hidden="true" />
            {t("resume.addItem")}
          </Button>
        ) : null}

        {s.kind === "education"
          ? s.items.map((it, ii) => (
              <div
                key={it.id}
                className="flex flex-col gap-2 rounded-md border bg-background p-3"
              >
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-[11px] font-medium text-muted-foreground">
                    {t("resume.eduItem", { n: ii + 1 })}
                  </span>
                  {itemToolbar(
                    () => eduOp(s.id, (items) => moveItem(items, ii, -1)),
                    () => eduOp(s.id, (items) => moveItem(items, ii, 1)),
                    () =>
                      eduOp(s.id, (items) => items.filter((x) => x.id !== it.id))
                  )}
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">
                    {t("resume.degree")}
                  </Label>
                  <Input
                    className="mt-1 h-11 min-h-11"
                    value={it.degree}
                    maxLength={LIMITS.degree}
                    placeholder={t("resume.phDegree")}
                    onChange={(e) =>
                      eduOp(s.id, (items) =>
                        items.map((x) =>
                          x.id === it.id ? { ...x, degree: e.target.value } : x
                        )
                      )
                    }
                  />
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      {t("resume.school")}
                    </Label>
                    <Input
                      className="mt-1 h-11 min-h-11"
                      value={it.school}
                      maxLength={LIMITS.school}
                      placeholder={t("resume.phSchool")}
                      onChange={(e) =>
                        eduOp(s.id, (items) =>
                          items.map((x) =>
                            x.id === it.id ? { ...x, school: e.target.value } : x
                          )
                        )
                      }
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      {t("resume.location")}
                    </Label>
                    <Input
                      className="mt-1 h-11 min-h-11"
                      value={it.location}
                      maxLength={LIMITS.company}
                      placeholder={t("resume.phLocation")}
                      onChange={(e) =>
                        eduOp(s.id, (items) =>
                          items.map((x) =>
                            x.id === it.id
                              ? { ...x, location: e.target.value }
                              : x
                          )
                        )
                      }
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs text-muted-foreground">
                        {t("resume.startLbl")}
                      </Label>
                      <Input
                        className="mt-1 h-11 min-h-11 font-mono text-xs"
                        value={it.start}
                        maxLength={LIMITS.date}
                        placeholder="2015"
                        onChange={(e) =>
                          eduOp(s.id, (items) =>
                            items.map((x) =>
                              x.id === it.id ? { ...x, start: e.target.value } : x
                            )
                          )
                        }
                      />
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">
                        {t("resume.endLbl")}
                      </Label>
                      <Input
                        className="mt-1 h-11 min-h-11 font-mono text-xs"
                        value={it.end}
                        maxLength={LIMITS.date}
                        placeholder="2019"
                        onChange={(e) =>
                          eduOp(s.id, (items) =>
                            items.map((x) =>
                              x.id === it.id ? { ...x, end: e.target.value } : x
                            )
                          )
                        }
                      />
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      {t("resume.grade")}
                    </Label>
                    <Input
                      className="mt-1 h-11 min-h-11"
                      value={it.grade}
                      maxLength={LIMITS.grade}
                      placeholder={t("resume.phGrade")}
                      onChange={(e) =>
                        eduOp(s.id, (items) =>
                          items.map((x) =>
                            x.id === it.id ? { ...x, grade: e.target.value } : x
                          )
                        )
                      }
                    />
                  </div>
                </div>
              </div>
            ))
          : null}

        {s.kind === "education" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 min-h-11 w-full text-xs"
            onClick={() => eduOp(s.id, (items) => [...items, newEducation()])}
          >
            <Plus className="size-4" aria-hidden="true" />
            {t("resume.addItem")}
          </Button>
        ) : null}

        {s.kind === "skills"
          ? s.groups.map((g, gi) => (
              <div
                key={g.id}
                className="flex flex-col gap-2 rounded-md border bg-background p-3"
              >
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-[11px] font-medium text-muted-foreground">
                    {t("resume.grpItem", { n: gi + 1 })}
                  </span>
                  <button
                    type="button"
                    aria-label={t("resume.removeGroup")}
                    onClick={() =>
                      skOp(s.id, (groups) =>
                        groups.filter((x) => x.id !== g.id)
                      )
                    }
                    className="flex size-8 items-center justify-center rounded-md border border-border bg-background text-base leading-none text-destructive transition-colors hover:bg-destructive/10"
                  >
                    ×
                  </button>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">
                    {t("resume.groupName")}
                  </Label>
                  <Input
                    className="mt-1 h-11 min-h-11"
                    value={g.name}
                    maxLength={LIMITS.skillGroup}
                    placeholder={t("resume.phGroupName")}
                    onChange={(e) =>
                      skOp(s.id, (groups) =>
                        groups.map((x) =>
                          x.id === g.id ? { ...x, name: e.target.value } : x
                        )
                      )
                    }
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">
                    {t("resume.groupItems")}
                  </Label>
                  <Textarea
                    className="mt-1 text-xs"
                    rows={3}
                    value={g.items.join("\n")}
                    placeholder={t("resume.phGroupItems")}
                    onChange={(e) =>
                      skOp(s.id, (groups) =>
                        groups.map((x) =>
                          x.id === g.id
                            ? {
                                ...x,
                                items: e.target.value
                                  .split("\n")
                                  .slice(0, 30)
                                  .map((l) => l.slice(0, LIMITS.skill)),
                              }
                            : x
                        )
                      )
                    }
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {t("resume.skillsHint")}
                  </p>
                </div>
              </div>
            ))
          : null}

        {s.kind === "skills" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 min-h-11 w-full text-xs"
            onClick={() => skOp(s.id, (groups) => [...groups, newSkillGroup()])}
          >
            <Plus className="size-4" aria-hidden="true" />
            {t("resume.addGroup")}
          </Button>
        ) : null}

        {s.kind === "projects"
          ? s.items.map((it, ii) => (
              <div
                key={it.id}
                className="flex flex-col gap-2 rounded-md border bg-background p-3"
              >
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-[11px] font-medium text-muted-foreground">
                    {t("resume.prjItem", { n: ii + 1 })}
                  </span>
                  {itemToolbar(
                    () => prjOp(s.id, (items) => moveItem(items, ii, -1)),
                    () => prjOp(s.id, (items) => moveItem(items, ii, 1)),
                    () =>
                      prjOp(s.id, (items) => items.filter((x) => x.id !== it.id))
                  )}
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">
                    {t("resume.projName")}
                  </Label>
                  <Input
                    className="mt-1 h-11 min-h-11"
                    value={it.name}
                    maxLength={LIMITS.projectName}
                    placeholder={t("resume.phProjName")}
                    onChange={(e) =>
                      prjOp(s.id, (items) =>
                        items.map((x) =>
                          x.id === it.id ? { ...x, name: e.target.value } : x
                        )
                      )
                    }
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">
                    {t("resume.projLink")}
                  </Label>
                  <Input
                    className="mt-1 h-11 min-h-11"
                    value={it.link}
                    maxLength={LIMITS.link}
                    placeholder="github.com/you/project"
                    onChange={(e) =>
                      prjOp(s.id, (items) =>
                        items.map((x) =>
                          x.id === it.id ? { ...x, link: e.target.value } : x
                        )
                      )
                    }
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">
                    {t("resume.projDesc")}
                  </Label>
                  <Textarea
                    className="mt-1"
                    rows={2}
                    value={it.description}
                    maxLength={LIMITS.projectDesc}
                    placeholder={t("resume.phProjDesc")}
                    onChange={(e) =>
                      prjOp(s.id, (items) =>
                        items.map((x) =>
                          x.id === it.id
                            ? { ...x, description: e.target.value }
                            : x
                        )
                      )
                    }
                  />
                </div>
              </div>
            ))
          : null}

        {s.kind === "projects" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 min-h-11 w-full text-xs"
            onClick={() => prjOp(s.id, (items) => [...items, newProject()])}
          >
            <Plus className="size-4" aria-hidden="true" />
            {t("resume.addItem")}
          </Button>
        ) : null}

        {s.kind === "certifications"
          ? s.items.map((it, ii) => (
              <div
                key={it.id}
                className="flex flex-col gap-2 rounded-md border bg-background p-3"
              >
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-[11px] font-medium text-muted-foreground">
                    {t("resume.crtItem", { n: ii + 1 })}
                  </span>
                  {itemToolbar(
                    () => crtOp(s.id, (items) => moveItem(items, ii, -1)),
                    () => crtOp(s.id, (items) => moveItem(items, ii, 1)),
                    () =>
                      crtOp(s.id, (items) => items.filter((x) => x.id !== it.id))
                  )}
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">
                    {t("resume.certName")}
                  </Label>
                  <Input
                    className="mt-1 h-11 min-h-11"
                    value={it.name}
                    maxLength={LIMITS.certName}
                    placeholder={t("resume.phCertName")}
                    onChange={(e) =>
                      crtOp(s.id, (items) =>
                        items.map((x) =>
                          x.id === it.id ? { ...x, name: e.target.value } : x
                        )
                      )
                    }
                  />
                </div>
                <div className="grid gap-2 sm:grid-cols-[1fr_100px]">
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      {t("resume.certIssuer")}
                    </Label>
                    <Input
                      className="mt-1 h-11 min-h-11"
                      value={it.issuer}
                      maxLength={LIMITS.issuer}
                      placeholder={t("resume.phCertIssuer")}
                      onChange={(e) =>
                        crtOp(s.id, (items) =>
                          items.map((x) =>
                            x.id === it.id ? { ...x, issuer: e.target.value } : x
                          )
                        )
                      }
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      {t("resume.certYear")}
                    </Label>
                    <Input
                      className="mt-1 h-11 min-h-11"
                      value={it.year}
                      maxLength={LIMITS.year}
                      placeholder="2023"
                      onChange={(e) =>
                        crtOp(s.id, (items) =>
                          items.map((x) =>
                            x.id === it.id ? { ...x, year: e.target.value } : x
                          )
                        )
                      }
                    />
                  </div>
                </div>
              </div>
            ))
          : null}

        {s.kind === "certifications" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 min-h-11 w-full text-xs"
            onClick={() => crtOp(s.id, (items) => [...items, newCertification()])}
          >
            <Plus className="size-4" aria-hidden="true" />
            {t("resume.addItem")}
          </Button>
        ) : null}

        {s.kind === "languages"
          ? s.items.map((it, ii) => (
              <div
                key={it.id}
                className="flex items-end gap-2 rounded-md border bg-background p-3"
              >
                <div className="min-w-0 flex-1">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    {t("resume.lngItem", { n: ii + 1 })}
                  </span>
                  <div className="mt-1 grid grid-cols-2 gap-2">
                    <Input
                      className="h-11 min-h-11"
                      value={it.name}
                      maxLength={LIMITS.langName}
                      placeholder={t("resume.langName")}
                      onChange={(e) =>
                        lngOp(s.id, (items) =>
                          items.map((x) =>
                            x.id === it.id ? { ...x, name: e.target.value } : x
                          )
                        )
                      }
                    />
                    <Input
                      className="h-11 min-h-11"
                      value={it.level}
                      maxLength={LIMITS.langLevel}
                      placeholder={t("resume.langLevel")}
                      onChange={(e) =>
                        lngOp(s.id, (items) =>
                          items.map((x) =>
                            x.id === it.id ? { ...x, level: e.target.value } : x
                          )
                        )
                      }
                    />
                  </div>
                </div>
                {itemToolbar(
                  () => lngOp(s.id, (items) => moveItem(items, ii, -1)),
                  () => lngOp(s.id, (items) => moveItem(items, ii, 1)),
                  () =>
                    lngOp(s.id, (items) => items.filter((x) => x.id !== it.id))
                )}
              </div>
            ))
          : null}

        {s.kind === "languages" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 min-h-11 w-full text-xs"
            onClick={() => lngOp(s.id, (items) => [...items, newLanguage()])}
          >
            <Plus className="size-4" aria-hidden="true" />
            {t("resume.addItem")}
          </Button>
        ) : null}

        {s.kind === "custom"
          ? s.items.map((it, ii) => (
              <div
                key={it.id}
                className="flex flex-col gap-2 rounded-md border bg-background p-3"
              >
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-[11px] font-medium text-muted-foreground">
                    {t("resume.cstItem", { n: ii + 1 })}
                  </span>
                  {itemToolbar(
                    () => cstOp(s.id, (items) => moveItem(items, ii, -1)),
                    () => cstOp(s.id, (items) => moveItem(items, ii, 1)),
                    () =>
                      cstOp(s.id, (items) => items.filter((x) => x.id !== it.id))
                  )}
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">
                    {t("resume.customTitle")}
                  </Label>
                  <Input
                    className="mt-1 h-11 min-h-11"
                    value={it.title}
                    maxLength={LIMITS.customTitle}
                    placeholder={t("resume.phCustomTitle")}
                    onChange={(e) =>
                      cstOp(s.id, (items) =>
                        items.map((x) =>
                          x.id === it.id ? { ...x, title: e.target.value } : x
                        )
                      )
                    }
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">
                    {t("resume.customText")}
                  </Label>
                  <Textarea
                    className="mt-1"
                    rows={3}
                    value={it.text}
                    maxLength={LIMITS.customText}
                    placeholder={t("resume.phCustomText")}
                    onChange={(e) =>
                      cstOp(s.id, (items) =>
                        items.map((x) =>
                          x.id === it.id ? { ...x, text: e.target.value } : x
                        )
                      )
                    }
                  />
                </div>
              </div>
            ))
          : null}

        {s.kind === "custom" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 min-h-11 w-full text-xs"
            onClick={() => cstOp(s.id, (items) => [...items, newCustom()])}
          >
            <Plus className="size-4" aria-hidden="true" />
            {t("resume.addItem")}
          </Button>
        ) : null}
      </div>
    );
  };

  /* ================================================================= */
  /* EDITOR — live preview builders                                      */
  /* ================================================================= */

  const previewPresent = t("resume.present");
  const previewDate = (it: { start: string; end: string; current?: boolean }): string =>
    formatDateRange(it.start, it.end, it.current === true, runLocale, previewPresent);

  const previewSection = (s: ResumeSection): ReactNode => {
    if (doc.template === "modern" && s.kind === "skills") return null; // sidebar
    return (
      <section key={s.id}>
        <h3 className="rsm-title">{s.title || t(KIND_LABEL[s.kind])}</h3>
        {s.kind === "summary" ? (
          <p style={{ whiteSpace: "pre-line" }}>{s.text}</p>
        ) : null}
        {s.kind === "experience"
          ? s.items.map((it) => (
              <div className="rsm-item" key={it.id}>
                <div className="rsm-itemhead">
                  <span>{it.role}</span>
                  <span className="rsm-itemdate">{previewDate(it)}</span>
                </div>
                {joinMeta([it.company, it.location]) ? (
                  <div className="rsm-meta">{joinMeta([it.company, it.location])}</div>
                ) : null}
                {it.bullets.length ? (
                  <ul>
                    {it.bullets.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))
          : null}
        {s.kind === "education"
          ? s.items.map((it) => (
              <div className="rsm-item" key={it.id}>
                <div className="rsm-itemhead">
                  <span>{it.degree}</span>
                  <span className="rsm-itemdate">{previewDate(it)}</span>
                </div>
                {joinMeta([it.school, it.location, it.grade]) ? (
                  <div className="rsm-meta">
                    {joinMeta([it.school, it.location, it.grade])}
                  </div>
                ) : null}
              </div>
            ))
          : null}
        {s.kind === "skills"
          ? s.groups.map((g) => (
              <div key={g.id} style={{ marginBottom: "3pt" }}>
                {g.name ? <span className="rsm-skname">{g.name}: </span> : null}
                {g.items.filter(Boolean).join(" · ")}
              </div>
            ))
          : null}
        {s.kind === "projects"
          ? s.items.map((it) => (
              <div className="rsm-item" key={it.id}>
                <div className="rsm-itemhead">
                  <span>{it.name}</span>
                  {it.link ? (
                    <span className="rsm-itemdate">{it.link}</span>
                  ) : null}
                </div>
                <div>{it.description}</div>
              </div>
            ))
          : null}
        {s.kind === "certifications"
          ? s.items.map((it) => (
              <div key={it.id} style={{ marginBottom: "2pt" }}>
                {[it.name, joinMeta([it.issuer, it.year])]
                  .filter(Boolean)
                  .join(" — ")}
              </div>
            ))
          : null}
        {s.kind === "languages"
          ? s.items.map((it) => (
              <div key={it.id} style={{ marginBottom: "2pt" }}>
                {[it.name, it.level].filter(Boolean).join(" — ")}
              </div>
            ))
          : null}
        {s.kind === "custom"
          ? s.items.map((it) => (
              <div className="rsm-item" key={it.id}>
                {it.title ? <b>{it.title}</b> : null}
                <div style={{ whiteSpace: "pre-line" }}>{it.text}</div>
              </div>
            ))
          : null}
      </section>
    );
  };

  const sideInk = (() => {
    const n = Number.parseInt(doc.accentColor.slice(1), 16);
    const r = ((n >> 16) & 255) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    return 0.299 * r + 0.587 * g + 0.114 * b > 0.6 ? "#111111" : "#ffffff";
  })();

  const previewSheet = (
    <div
      id="rsm-sheet"
      ref={sheetRef}
      className={
        doc.template === "modern"
          ? "rsm-modern"
          : doc.template === "compact"
            ? "rsm-compact"
            : ""
      }
      style={
        {
          width: `${pagePt.w}pt`,
          minHeight: `${pagePt.h}pt`,
          "--ac": doc.accentColor,
          "--side-ink": sideInk,
        } as CSSProperties
      }
    >
      {doc.template === "modern" ? (
        <>
          <aside className="rsm-side">
            {doc.header.photo ? (
              <img
                className="rsm-photo"
                src={doc.header.photo}
                alt={t("resume.photoAlt", { name: doc.header.fullName })}
              />
            ) : null}
            <div className="rsm-slabel">{t("resume.contactLbl")}</div>
            <div style={{ fontSize: "9pt" }}>
              {[
                doc.header.email,
                doc.header.phone,
                doc.header.location,
                doc.header.linkedin,
                doc.header.website,
              ]
                .filter(Boolean)
                .map((x) => (
                  <div key={x}>{x}</div>
                ))}
            </div>
            {doc.sections
              .filter((s) => s.kind === "skills")
              .map((s) =>
                s.kind === "skills" ? (
                  <div key={s.id}>
                    <div className="rsm-slabel">{s.title}</div>
                    {s.groups.map((g) => (
                      <div key={g.id}>
                        {g.name ? (
                          <div className="rsm-skillname">{g.name}</div>
                        ) : null}
                        <div className="rsm-skillitems">
                          {g.items.filter(Boolean).join(" · ")}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null
              )}
          </aside>
          <div className="rsm-main">
            <div className="rsm-name">{doc.header.fullName}</div>
            {doc.header.headline ? (
              <div className="rsm-headline">{doc.header.headline}</div>
            ) : null}
            <div className="rsm-hr" />
            {doc.sections.map(previewSection)}
          </div>
        </>
      ) : (
        <div className={doc.template === "compact" ? "rsm-col" : "rsm-col rsm-center"}>
          {doc.header.photo ? (
            <img
              className="rsm-photo-float"
              src={doc.header.photo}
              alt={t("resume.photoAlt", { name: doc.header.fullName })}
            />
          ) : null}
          <div className="rsm-name">{doc.header.fullName}</div>
          {doc.header.headline ? (
            <div className="rsm-headline">{doc.header.headline}</div>
          ) : null}
          {atsContactLine(doc.header) ? (
            <div className="rsm-contact">{atsContactLine(doc.header)}</div>
          ) : null}
          <div className="rsm-hr" />
          {doc.sections.map(previewSection)}
        </div>
      )}
    </div>
  );

  /* ================================================================= */
  /* EDITOR — layout                                                    */
  /* ================================================================= */

  const formColumn = (
    <div className="flex min-w-0 flex-col gap-3">
      {/* Design */}
      <div className="rounded-lg border bg-card p-4">
        <h2 className="mb-2 text-sm font-semibold">{t("resume.designTitle")}</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label
              htmlFor="rsm-tpl"
              className="text-xs text-muted-foreground"
            >
              {t("resume.templateLbl")}
            </Label>
            <select
              id="rsm-tpl"
              className={`mt-1.5 ${selCls}`}
              value={doc.template}
              onChange={(e) =>
                update((d) => ({
                  ...d,
                  template: e.target.value as ResumeTemplate,
                }))
              }
            >
              {TEMPLATES.map((tpl) => (
                <option key={tpl} value={tpl}>
                  {t(TEMPLATE_LABEL[tpl])}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label
              htmlFor="rsm-size"
              className="text-xs text-muted-foreground"
            >
              {t("resume.pageSizeLbl")}
            </Label>
            <select
              id="rsm-size"
              className={`mt-1.5 ${selCls}`}
              value={doc.pageSize}
              onChange={(e) =>
                update((d) => ({
                  ...d,
                  pageSize: e.target.value as ResumePageSize,
                }))
              }
            >
              <option value="a4">{t("resume.pageA4")}</option>
              <option value="letter">{t("resume.pageLetter")}</option>
            </select>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <input
            type="color"
            value={doc.accentColor}
            onChange={(e) => update((d) => ({ ...d, accentColor: e.target.value }))}
            title={t("resume.accentLbl")}
            aria-label={t("resume.accentLbl")}
            className="size-11 cursor-pointer rounded-md border border-input bg-background p-1"
          />
          <p className="text-[11px] leading-snug text-muted-foreground">
            {t("resume.accentNote")}
          </p>
        </div>
      </div>

      {/* Header */}
      <div className="rounded-lg border bg-card p-4">
        <h2 className="mb-2 text-sm font-semibold">{t("resume.hdrTitle")}</h2>
        <div className="flex flex-col gap-3">
          <div>
            <Label htmlFor="rsm-name" className="text-xs text-muted-foreground">
              {t("resume.fullName")}
            </Label>
            <Input
              id="rsm-name"
              className="mt-1.5 h-11 min-h-11"
              value={doc.header.fullName}
              maxLength={LIMITS.fullName}
              placeholder={t("resume.phFullName")}
              onChange={(e) => setHeader("fullName", e.target.value)}
              autoComplete="name"
            />
          </div>
          <div>
            <Label htmlFor="rsm-head" className="text-xs text-muted-foreground">
              {t("resume.headline")}
            </Label>
            <Input
              id="rsm-head"
              className="mt-1.5 h-11 min-h-11"
              value={doc.header.headline}
              maxLength={LIMITS.headline}
              placeholder={t("resume.phHeadline")}
              onChange={(e) => setHeader("headline", e.target.value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                ["email", "resume.email", "resume.phEmail", "email"],
                ["phone", "resume.phone", "resume.phPhone", "tel"],
                ["location", "resume.location", "resume.phLocation", "text"],
                ["linkedin", "resume.linkedin", "resume.phLinkedin", "text"],
                ["website", "resume.website", "resume.phWebsite", "text"],
              ] as const
            ).map(([field, labelKey, phKey, auto]) => (
              <div key={field}>
                <Label
                  htmlFor={`rsm-${field}`}
                  className="text-xs text-muted-foreground"
                >
                  {t(labelKey)}
                </Label>
                <Input
                  id={`rsm-${field}`}
                  className="mt-1.5 h-11 min-h-11"
                  value={doc.header[field]}
                  maxLength={LIMITS.contact}
                  placeholder={t(phKey)}
                  autoComplete={auto}
                  onChange={(e) => setHeader(field, e.target.value)}
                />
              </div>
            ))}
          </div>
          {/* Photo (optional) */}
          <div className="flex items-center gap-3 rounded-md border bg-background p-3">
            {doc.header.photo ? (
              <img
                src={doc.header.photo}
                alt={t("resume.photoAlt", { name: doc.header.fullName })}
                className="size-14 rounded-full border object-cover"
              />
            ) : (
              <span className="flex size-14 items-center justify-center rounded-full border bg-muted text-muted-foreground">
                <ImagePlus className="size-5" aria-hidden="true" />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted-foreground">
                {t("resume.photoHint")}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                <label className="inline-flex">
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={(e) => void onPhoto(e)}
                  />
                  <span className="inline-flex h-11 min-h-11 cursor-pointer items-center gap-1.5 rounded-btn border border-input bg-background px-3 text-xs font-medium transition-colors hover:bg-muted">
                    <ImagePlus className="size-4" aria-hidden="true" />
                    {t("resume.photoAdd")}
                  </span>
                </label>
                {doc.header.photo ? (
                  <Button
                    type="button"
                    variant="outline"
                    className={`${TOOL_BTN}`}
                    onClick={() => setHeader("photo", "")}
                  >
                    <X className="size-4" aria-hidden="true" />
                    {t("resume.photoRemove")}
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Sections */}
      <div className="flex flex-col gap-3">
        {doc.sections.map((s, si) => renderSectionEditor(s, si))}
      </div>

      {/* Add section */}
      <div className="rounded-lg border bg-card p-4">
        <h2 className="mb-2 text-sm font-semibold">{t("resume.addSection")}</h2>
        <div className="flex gap-2">
          <select
            aria-label={t("resume.sectionKind")}
            className={`min-w-0 flex-1 ${selCls}`}
            value={addKind}
            onChange={(e) => setAddKind(e.target.value as ResumeSectionKind)}
          >
            {SECTION_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(KIND_LABEL[k])}
              </option>
            ))}
          </select>
          <Button
            type="button"
            className={`${TOOL_BTN} flex-none`}
            onClick={() => addSection(addKind)}
          >
            <Plus className="size-4" aria-hidden="true" />
            {t("resume.addBtn")}
          </Button>
        </div>
      </div>
    </div>
  );

  const previewColumn = (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          onClick={() => spawnRun("download")}
          disabled={exportPct !== null}
          className="h-11 min-h-11 gap-1.5 text-xs"
        >
          {exportPct !== null ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <FileDown className="size-4" aria-hidden="true" />
          )}
          {t("resume.exportPdf")}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => spawnRun("preview")}
          disabled={exportPct !== null}
          className="h-11 min-h-11 gap-1.5 text-xs"
        >
          <Eye className="size-4" aria-hidden="true" />
          {t("resume.testRender")}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={goHome}
          className="h-11 min-h-11 gap-1.5 text-xs"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t("resume.backToTemplates")}
        </Button>
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          <span className="rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground">
            {t("resume.pagesChip", { n: estPages })}
          </span>
          <span className="rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground">
            {t("resume.wordsChip", { n: stats.words })}
          </span>
          {stats.words > SOFT_WORD_CAP ? (
            <span className="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              {t("resume.longWarn")}
            </span>
          ) : null}
        </span>
      </div>

      {renderUrl ? (
        <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {t("resume.renderNote", { pages: renderPages })}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-11 min-h-11 gap-1 text-xs"
              onClick={closeRender}
            >
              <X className="size-4" aria-hidden="true" />
              {t("resume.renderClose")}
            </Button>
          </div>
          <iframe
            title={t("resume.testRender")}
            src={renderUrl}
            className="h-[60vh] min-h-96 w-full rounded-md border bg-white"
          />
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={saveName}
            onChange={(e) => setSaveName(e.target.value.slice(0, 60))}
            placeholder={defaultSaveName()}
            aria-label={t("resume.saveName")}
            className="h-11 min-h-11 w-44 min-w-0 text-xs"
          />
          <Button
            type="button"
            variant="outline"
            onClick={saveCurrent}
            className="h-11 min-h-11 gap-1.5 text-xs"
          >
            <Save className="size-4" aria-hidden="true" />
            {t("resume.save")}
          </Button>
          <select
            aria-label={t("resume.open")}
            className="h-11 min-h-11 min-w-36 max-w-52 rounded-md border border-input bg-background px-2 text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            value={savedIdx}
            onChange={(e) => loadSaved(e.target.value)}
          >
            <option value="">{t("resume.open")}</option>
            {savedList.map((x) => (
              <option key={x.name} value={String(savedList.indexOf(x))}>
                {x.name}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => {
              if (savedIdx !== "") deleteSaved(savedList[Number(savedIdx)].name);
            }}
            disabled={savedIdx === ""}
            aria-label={t("resume.delSaved")}
            title={t("resume.delSaved")}
            className="size-11 min-h-11"
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div ref={wrapRef} id="rsm-wrap" className="min-w-0 overflow-hidden">
        {previewSheet}
      </div>
    </div>
  );

  /* ---------- render ---------- */
  if (view === "home") {
    return (
      <div className="flex flex-col gap-4">
        <style dangerouslySetInnerHTML={{ __html: PREVIEW_CSS }} />
        {homeView}
      </div>
    );
  }
  return (
    <div
      className="flex flex-col gap-4"
      aria-label={t("resume.workspace")}
    >
      <style dangerouslySetInnerHTML={{ __html: PREVIEW_CSS }} />
      {/* mobile tabs — <768px: form / preview (min-w-0 grid lesson pinned) */}
      <div className="flex gap-1 overflow-x-auto lg:hidden" role="tablist">
        {(
          [
            ["form", t("resume.tabForm")],
            ["preview", t("resume.tabPreview")],
          ] as [MobileTab, string][]
        ).map(([tab, label]) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={mobileTab === tab}
            onClick={() => setMobileTab(tab)}
            className={`h-11 min-h-11 flex-1 rounded-btn px-3 text-xs font-medium transition-colors ${
              mobileTab === tab
                ? "bg-primary text-primary-foreground"
                : "border border-border bg-card text-foreground hover:bg-muted"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(320px,430px)_1fr]">
        <div
          className={
            mobileTab === "form"
              ? "flex min-w-0 flex-col"
              : "hidden min-w-0 flex-col lg:flex"
          }
        >
          {formColumn}
        </div>
        <div
          className={
            mobileTab === "preview"
              ? "min-w-0"
              : "hidden min-w-0 lg:block"
          }
        >
          {previewColumn}
        </div>
      </div>
    </div>
  );
}
