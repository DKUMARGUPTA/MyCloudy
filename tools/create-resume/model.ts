/**
 * Create resume — pure model (CR-66). No DOM, no storage, no pdf-lib:
 * the same helpers feed the surface preview, the honesty badges and the
 * PDF renderer (render.ts imports the geometry + wrapText so the
 * estimated page count and the real pagination share one math).
 *
 *  - dateRange: EN "Jan 2021 – Mar 2023" / HI "जन 2021 – मार्च 2023",
 *    with "Present"/"वर्तमान" for current roles. Inputs stay free-form
 *    ("2021-06", "2021" or verbatim text) — never a hard parse error.
 *  - parseResumeRun: the worker-boundary parser (parseInvoiceRun
 *    pattern). Clamp arrays, strip control chars, dedupe section ids,
 *    cap every length — a tampered payload can never reach the renderer
 *    as a wrong type or an oversized image.
 *  - estimatePageBreaks: measured pagination model (wrapText over the
 *    shared per-template geometry) → the honest "≈N pages" badge.
 *  - ATS text helpers: icon-free, letter-spacing-free lines. Bullets
 *    are "• " text — always real selectable text.
 */

import type {
  CustomItem,
  EducationItem,
  ExperienceItem,
  ResumeDoc,
  ResumeLocale,
  ResumePageSize,
  ResumeRun,
  ResumeSection,
  ResumeSectionKind,
  ResumeTemplate,
} from "./types";

/* ------------------------------------------------------------------ */
/* Hard caps (mirrored by the editor inputs and the parser)             */
/* ------------------------------------------------------------------ */

export const MAX_SECTIONS = 16;
export const MAX_ITEMS_PER_SECTION = 40;
export const MAX_BULLETS_PER_ITEM = 12;
export const MAX_SKILL_GROUPS = 12;
export const MAX_SKILLS_PER_GROUP = 30;
export const MAX_IMG_DATAURL = 1_500_000; // ~1.5 MB base64

/** Per-field character caps (honesty badges + parser clamps). */
export const LIMITS = {
  fullName: 120,
  headline: 160,
  contact: 200,
  sectionTitle: 80,
  summary: 4000,
  role: 160,
  company: 160,
  degree: 200,
  school: 200,
  grade: 60,
  date: 40,
  bullet: 400,
  skillGroup: 80,
  skill: 100,
  projectName: 160,
  link: 300,
  projectDesc: 1200,
  certName: 200,
  issuer: 160,
  year: 20,
  langName: 60,
  langLevel: 40,
  customTitle: 160,
  customText: 4000,
} as const;

/** Soft word budget surfaced as a warning badge (not a hard stop). */
export const SOFT_WORD_CAP = 1000;

export const TEMPLATES: readonly ResumeTemplate[] = [
  "classic",
  "modern",
  "compact",
];
export const PAGE_SIZES: readonly ResumePageSize[] = ["a4", "letter"];

/** Point size of each page kind (A4 595.28×841.89, Letter 612×792). */
export const PAGE_PT: Record<ResumePageSize, { w: number; h: number }> = {
  a4: { w: 595.28, h: 841.89 },
  letter: { w: 612, h: 792 },
};

export const DEFAULT_ACCENT = "#0b6b4d";

/* ------------------------------------------------------------------ */
/* Text hygiene                                                        */
/* ------------------------------------------------------------------ */

/** Strips control chars (keeps \n and \t), then caps the length. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .slice(0, max);
}

/** Single-line variant: also collapses every run of whitespace. */
export function cleanLine(v: unknown, max: number): string {
  return cleanText(v, max).replace(/\s+/g, " ").trim();
}

const AC_RE = /^#[0-9a-fA-F]{6}$/;
const DATAURL_IMG_RE = /^data:image\/(png|jpeg|jpg);base64,[A-Za-z0-9+/=]+$/;

function img(v: unknown): string {
  return typeof v === "string" &&
    v.length <= MAX_IMG_DATAURL &&
    (v === "" || DATAURL_IMG_RE.test(v))
    ? v
    : "";
}

/** New unique-enough id for sections/items (main thread + worker safe). */
let idSeq = 0;
export function newId(prefix: string): string {
  idSeq = (idSeq + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${idSeq.toString(36)}`;
}

function dedupeId(id: unknown, taken: Set<string>, prefix: string): string {
  const base = cleanLine(id, 40) || newId(prefix);
  let out = base;
  let n = 2;
  while (taken.has(out)) out = `${base}-${n++}`;
  taken.add(out);
  return out;
}

/* ------------------------------------------------------------------ */
/* Dates — EN "Jan 2021 – Mar 2023" / HI "जन 2021 – मार्च 2023"          */
/* ------------------------------------------------------------------ */

const EN_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const HI_MONTHS = [
  "जन",
  "फ़र",
  "मार्च",
  "अप्रै",
  "मई",
  "जून",
  "जुल",
  "अग",
  "सित",
  "अक्टू",
  "नव",
  "दिस",
];

/**
 * One month value → display string.
 * "2021-06-15" / "2021-06" → "Jun 2021" / "जून 2021"; "2021" → "2021";
 * any other non-empty text is used verbatim (honest pass-through).
 */
export function formatMonth(value: string, locale: ResumeLocale): string {
  const v = cleanLine(value, LIMITS.date);
  if (!v) return "";
  const m = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/.exec(v);
  if (m) {
    const year = m[1];
    const idx = Number.parseInt(m[2], 10);
    if (idx >= 1 && idx <= 12) {
      return locale === "hi"
        ? `${HI_MONTHS[idx - 1]} ${year}`
        : `${EN_MONTHS[idx - 1]} ${year}`;
    }
    return year;
  }
  if (/^\d{4}$/.test(v)) return v;
  return v;
}

/**
 * "Jan 2021 – Mar 2023" / "जन 2021 – मार्च 2023"; end ignored + `present`
 * shown when `current`. One-sided ranges degrade to the single month.
 */
export function formatDateRange(
  start: string,
  end: string,
  current: boolean,
  locale: ResumeLocale,
  present: string
): string {
  const s = formatMonth(start, locale);
  if (!s) return current ? present : "";
  const e = current ? present : formatMonth(end, locale);
  return e ? `${s} – ${e}` : s;
}

/* ------------------------------------------------------------------ */
/* ATS text helpers (icon-free, letter-spacing-free)                   */
/* ------------------------------------------------------------------ */

/**
 * Contact as ONE plain text line joined with " · " (middot U+00B7 —
 * WinAnsi-safe). ATS parsers read it as ordinary text; no icons, no
 * ligature glyphs, no letter-spacing tricks.
 */
export function atsContactLine(
  h: ResumeDoc["header"]
): string {
  return [
    cleanLine(h.email, LIMITS.contact),
    cleanLine(h.phone, LIMITS.contact),
    cleanLine(h.location, LIMITS.contact),
    cleanLine(h.linkedin, LIMITS.contact),
    cleanLine(h.website, LIMITS.contact),
  ]
    .filter(Boolean)
    .join(" \u00b7 ");
}

/** One bullet line — "• " + text, both real selectable text in the PDF. */
export function atsBulletLine(text: string): string {
  return "\u2022 " + text;
}

/** Location/company join "A · B" with the blanks dropped. */
export function joinMeta(parts: string[]): string {
  return parts.map((p) => cleanLine(p, 300)).filter(Boolean).join(" \u00b7 ");
}

/* ------------------------------------------------------------------ */
/* WinAnsi detection → Helvetica vs embedded Noto                       */
/* ------------------------------------------------------------------ */

const WINANSI_EXTRA = new Set(
  [
    0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
    0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
    0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
  ]
);

/** true when every char is encodable in WinAnsi (CP1252) minus controls. */
export function isWinAnsiText(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c <= 0x7e) continue;
    if (c >= 0xa0 && c <= 0xff) continue;
    if (WINANSI_EXTRA.has(c)) continue;
    return false;
  }
  return true;
}

/** Every string the renderer can draw for this run (content + labels + dates). */
export function resumeAllText(run: ResumeRun): string[] {
  const out: string[] = [];
  const d = run.d;
  const push = (s: string): void => {
    if (s) out.push(s);
  };
  push(d.header.fullName);
  push(d.header.headline);
  push(atsContactLine(d.header));
  for (const s of d.sections) {
    push(s.title);
    switch (s.kind) {
      case "summary":
        push(s.text);
        break;
      case "experience":
        for (const it of s.items) {
          push(it.role);
          push(it.company);
          push(it.location);
          push(
            formatDateRange(
              it.start,
              it.end,
              it.current,
              run.locale,
              run.labels.present ?? "Present"
            )
          );
          for (const b of it.bullets) push(b);
        }
        break;
      case "education":
        for (const it of s.items) {
          push(it.degree);
          push(it.school);
          push(it.location);
          push(it.grade);
          push(formatDateRange(it.start, it.end, false, run.locale, ""));
        }
        break;
      case "skills":
        for (const g of s.groups) {
          push(g.name);
          for (const sk of g.items) push(sk);
        }
        break;
      case "projects":
        for (const it of s.items) {
          push(it.name);
          push(it.link);
          push(it.description);
        }
        break;
      case "certifications":
        for (const it of s.items) push(it.name + " " + it.issuer + " " + it.year);
        break;
      case "languages":
        for (const it of s.items) push(it.name + " " + it.level);
        break;
      case "custom":
        for (const it of s.items) {
          push(it.title);
          push(it.text);
        }
        break;
    }
  }
  for (const v of Object.values(run.labels)) push(v);
  return out;
}

/**
 * true → the renderer must embed the self-hosted Noto Sans Devanagari
 * (fontkit subset). false → pure-WinAnsi content, and the PDF uses the
 * non-embedded base-14 Helvetica (smallest possible, 100% ATS).
 */
export function resumeNeedsNoto(run: ResumeRun): boolean {
  return resumeAllText(run).some((s) => !isWinAnsiText(s));
}

/* ------------------------------------------------------------------ */
/* Geometry — ONE source shared by render.ts + estimatePageBreaks       */
/* ------------------------------------------------------------------ */

export interface ResumeGeometry {
  pageW: number;
  pageH: number;
  /** 44 pt on every side (modern's sidebar is full-bleed instead). */
  margin: number;
  /** Usable bottom (margin + footer allowance). */
  bottom: number;
  /** Main column left edge + width (modern: right of the sidebar). */
  x: number;
  w: number;
  body: number;
  lh: number;
  name: number;
  headline: number;
  contact: number;
  title: number;
  itemTitle: number;
  date: number;
  small: number;
  gapHeader: number;
  gapSection: number;
  gapItem: number;
  bulletIndent: number;
  /** Modern only — 0 otherwise. */
  sidebarW: number;
  sidePad: number;
  sideW: number;
  photoMain: number;
  photoSide: number;
}

const MARGIN = 44;
const FOOTER_ALLOW = 24;

export function geometryFor(
  template: ResumeTemplate,
  pageSize: ResumePageSize
): ResumeGeometry {
  const pt = PAGE_PT[pageSize];
  const base: ResumeGeometry = {
    pageW: pt.w,
    pageH: pt.h,
    margin: MARGIN,
    bottom: MARGIN + FOOTER_ALLOW,
    x: MARGIN,
    w: pt.w - 2 * MARGIN,
    body: 10,
    lh: 13.8,
    name: 22,
    headline: 11.5,
    contact: 9.5,
    title: 11,
    itemTitle: 10.5,
    date: 9.5,
    small: 9,
    gapHeader: 20,
    gapSection: 16,
    gapItem: 10,
    bulletIndent: 12,
    sidebarW: 0,
    sidePad: 24,
    sideW: 0,
    photoMain: 64,
    photoSide: 92,
  };
  if (template === "compact") {
    return {
      ...base,
      body: 9.5,
      lh: 12.2,
      name: 18,
      headline: 10,
      contact: 8.5,
      title: 10,
      itemTitle: 9.5,
      date: 8.5,
      small: 8.5,
      gapHeader: 12,
      gapSection: 11,
      gapItem: 7,
      photoMain: 52,
    };
  }
  if (template === "modern") {
    // Spec's "64pt sidebar" is unusable for contact/skills text —
    // interpreted as 64 mm (181.42 pt), the standard ~30% resume rail.
    const sidebarW = (64 * 72) / 25.4;
    return {
      ...base,
      sidebarW,
      x: sidebarW + 28,
      w: pt.w - sidebarW - 28 - MARGIN,
      name: 20,
      headline: 11,
    };
  }
  return base;
}

/* ------------------------------------------------------------------ */
/* Measuring + wrapping                                                 */
/* ------------------------------------------------------------------ */

export type MeasureFn = (text: string, size: number, bold?: boolean) => number;

/**
 * Greedy word-wrap honouring explicit \n. A word wider than the whole
 * width is hard-broken at glyph level (long URLs never overflow).
 * Never returns [].
 */
export function wrapText(
  text: string,
  width: number,
  size: number,
  measure: MeasureFn,
  bold = false
): string[] {
  const out: string[] = [];
  const paras = String(text ?? "")
    .split("\n")
    .map((p) => p.replace(/[\t\r]+/g, " ").trim());
  for (const para of paras) {
    if (para === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (let word of para.split(" ").filter(Boolean)) {
      // hard-break pathological single words
      while (measure(word, size, bold) > width && word.length > 1) {
        let cut = word.length;
        while (
          cut > 1 &&
          measure(word.slice(0, cut - 1) + "…", size, bold) > width
        ) {
          cut--;
        }
        const head = word.slice(0, Math.max(1, cut - 1));
        const tail = word.slice(Math.max(1, cut - 1));
        const piece = line ? line + " " + head : head;
        out.push(piece);
        line = "";
        word = tail;
      }
      const next = line ? line + " " + word : word;
      if (measure(next, size, bold) <= width || !line) line = next;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out.length ? out : [""];
}

/**
 * Helvetica-flavoured approximation (per-char class widths, thousandths
 * of an em) — good enough for the honest "≈N pages" badge without any
 * DOM or pdf-lib dependency. Non-ASCII (Devanagari etc.) is treated
 * slightly wider than the Latin average.
 */
const NARROW = new Set(
  "iljt.,:;'!|()[]{}fIrI/\\-\" ".split("")
);
const WIDE = new Set("mwMW@%&".split(""));

export function approxMeasure(text: string, size: number): number {
  let units = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      if (NARROW.has(c)) units += 0.29;
      else if (WIDE.has(c)) units += 0.82;
      else if (c >= "A" && c <= "Z") units += 0.68;
      else if (c >= "0" && c <= "9") units += 0.56;
      else units += 0.52;
    } else {
      units += 0.62; // Devanagari and other scripts — honest average
    }
  }
  return units * size;
}

/* ------------------------------------------------------------------ */
/* Stats (honesty badges)                                               */
/* ------------------------------------------------------------------ */

export interface ResumeStats {
  words: number;
  chars: number;
  sections: number;
  items: number;
}

export function resumeStats(doc: ResumeDoc): ResumeStats {
  const texts: string[] = [];
  const push = (s: string): void => {
    if (s) texts.push(s);
  };
  push(doc.header.fullName);
  push(doc.header.headline);
  push(atsContactLine(doc.header));
  let items = 0;
  for (const s of doc.sections) {
    push(s.title);
    switch (s.kind) {
      case "summary":
        push(s.text);
        break;
      case "experience":
        for (const it of s.items) {
          items++;
          push(it.role + " " + it.company + " " + it.location);
          for (const b of it.bullets) push(b);
        }
        break;
      case "education":
        for (const it of s.items) {
          items++;
          push(it.degree + " " + it.school + " " + it.location + " " + it.grade);
        }
        break;
      case "skills":
        for (const g of s.groups) {
          items++;
          push(g.name);
          push(g.items.join(" "));
        }
        break;
      case "projects":
        for (const it of s.items) {
          items++;
          push(it.name + " " + it.description);
        }
        break;
      case "certifications":
      case "languages":
        for (const it of s.items) {
          items++;
          push(Object.values(it).join(" "));
        }
        break;
      case "custom":
        for (const it of s.items) {
          items++;
          push(it.title + " " + it.text);
        }
        break;
    }
  }
  const joined = texts.join(" ");
  return {
    words: joined.split(/\s+/).filter(Boolean).length,
    chars: joined.replace(/\s+/g, " ").length,
    sections: doc.sections.length,
    items,
  };
}

/* ------------------------------------------------------------------ */
/* estimatePageBreaks — the shared pagination model                     */
/* ------------------------------------------------------------------ */

/**
 * Simulates the renderer's flow with the given measure (the real font
 * inside the worker, approxMeasure on the surface): every block height
 * uses the SAME wrapText + ResumeGeometry the drawing walks, breaking
 * pages at the same bottom limit. Returns the page count (≥1) — the
 * honest "≈N pages" badge.
 */
export function estimatePageBreaks(
  doc: ResumeDoc,
  measure: MeasureFn,
  locale: ResumeLocale = doc.locale,
  present = "Present"
): number {
  const geo = geometryFor(doc.template, doc.pageSize);
  const measureWrapped: MeasureFn = (t, s, b) =>
    measure(t, s, b ?? false);
  let pages = 1;
  let y = geo.pageH - geo.margin;
  const block = (h: number): void => {
    if (y - h < geo.bottom) {
      pages++;
      y = geo.pageH - geo.margin;
    }
    y -= h;
  };
  const lines = (text: string, width: number, size: number, bold = false) => {
    for (const ln of wrapText(text, width, size, measureWrapped, bold)) {
      block(geo.lh);
    }
  };

  /* main column flow */
  const hasPhoto = doc.header.photo !== "";
  if (doc.template !== "modern") {
    const w = hasPhoto ? geo.w - geo.photoMain - 16 : geo.w;
    block(geo.name * 1.25);
    if (doc.header.headline) lines(doc.header.headline, w, geo.headline);
    lines(atsContactLine(doc.header), w, geo.contact);
    block(geo.gapHeader);
  } else {
    block(geo.name * 1.25);
    if (doc.header.headline) lines(doc.header.headline, geo.w, geo.headline);
    block(geo.gapHeader);
  }

  for (const s of doc.sections) {
    if (doc.template === "modern" && s.kind === "skills") continue; // sidebar
    block(geo.title * 1.35 + 6 + geo.gapSection * 0.35);
    const w = geo.w - geo.bulletIndent;
    switch (s.kind) {
      case "summary":
        lines(s.text, geo.w, geo.body);
        break;
      case "experience":
        for (const it of s.items) {
          block(geo.lh * 2 + 2);
          for (const b of it.bullets)
            lines(atsBulletLine(b), w, geo.body);
          block(geo.gapItem);
        }
        break;
      case "education":
        for (const it of s.items) {
          block(geo.lh * 2);
          block(geo.gapItem);
        }
        break;
      case "skills":
        for (const g of s.groups) {
          lines(joinMeta([g.name]) + " " + g.items.join(" · "), geo.w, geo.body);
        }
        break;
      case "projects":
        for (const it of s.items) {
          block(geo.lh);
          lines(it.description, w, geo.body);
          block(geo.gapItem);
        }
        break;
      case "certifications":
      case "languages":
        for (const it of s.items) lines(Object.values(it).join(" — "), geo.w, geo.body);
        break;
      case "custom":
        for (const it of s.items) {
          if (it.title) block(geo.lh);
          lines(it.text, geo.w, geo.body);
          block(geo.gapItem);
        }
        break;
    }
    block(geo.gapSection * 0.65);
  }

  /* sidebar flow (modern): photo + contact + skills */
  if (doc.template === "modern") {
    let sidePages = 1;
    let sy = geo.pageH - geo.margin;
    const sBlock = (h: number): void => {
      if (sy - h < geo.margin) {
        sidePages++;
        sy = geo.pageH - geo.margin;
      }
      sy -= h;
    };
    const sLines = (text: string, size: number): void => {
      for (const _ln of wrapText(text, geo.sideW, size, measureWrapped)) {
        sBlock(geo.lh);
      }
    };
    if (doc.header.photo) sBlock(geo.photoSide + 14);
    sLines(doc.header.fullName, 12);
    sLines(atsContactLine(doc.header), geo.small);
    for (const s of doc.sections) {
      if (s.kind !== "skills") continue;
      sBlock(geo.title * 1.3 + 4);
      for (const g of s.groups) {
        sLines(g.name, geo.body);
        sLines(g.items.join(" · "), geo.small);
        sBlock(4);
      }
    }
    pages = Math.max(pages, sidePages);
  }

  return pages;
}

/* ------------------------------------------------------------------ */
/* Section defaults + samples (EN and हिंदी variants)                   */
/* ------------------------------------------------------------------ */

export function defaultSectionTitle(
  kind: ResumeSectionKind,
  locale: ResumeLocale
): string {
  const en: Record<ResumeSectionKind, string> = {
    summary: "Summary",
    experience: "Experience",
    education: "Education",
    skills: "Skills",
    projects: "Projects",
    certifications: "Certifications",
    languages: "Languages",
    custom: "Custom section",
  };
  const hi: Record<ResumeSectionKind, string> = {
    summary: "सारांश",
    experience: "कार्य अनुभव",
    education: "शिक्षा",
    skills: "कौशल",
    projects: "परियोजनाएँ",
    certifications: "प्रमाणपत्र",
    languages: "भाषाएँ",
    custom: "अन्य अनुभाग",
  };
  return locale === "hi" ? hi[kind] : en[kind];
}

export const SECTION_KINDS: readonly ResumeSectionKind[] = [
  "summary",
  "experience",
  "education",
  "skills",
  "projects",
  "certifications",
  "languages",
  "custom",
];

/** A fresh section of any kind with one empty item where items exist. */
export function defaultSection(
  kind: ResumeSectionKind,
  locale: ResumeLocale
): ResumeSection {
  const id = newId(kind);
  const title = defaultSectionTitle(kind, locale);
  switch (kind) {
    case "summary":
      return { id, kind, title, text: "" };
    case "experience":
      return {
        id,
        kind,
        title,
        items: [
          {
            id: newId("exp"),
            role: "",
            company: "",
            location: "",
            start: "",
            end: "",
            current: false,
            bullets: [""],
          },
        ],
      };
    case "education":
      return {
        id,
        kind,
        title,
        items: [
          {
            id: newId("edu"),
            degree: "",
            school: "",
            location: "",
            start: "",
            end: "",
            grade: "",
          },
        ],
      };
    case "skills":
      return {
        id,
        kind,
        title,
        groups: [{ id: newId("grp"), name: "", items: [""] }],
      };
    case "projects":
      return {
        id,
        kind,
        title,
        items: [{ id: newId("prj"), name: "", link: "", description: "" }],
      };
    case "certifications":
      return {
        id,
        kind,
        title,
        items: [{ id: newId("crt"), name: "", issuer: "", year: "" }],
      };
    case "languages":
      return {
        id,
        kind,
        title,
        items: [{ id: newId("lng"), name: "", level: "" }],
      };
    case "custom":
      return {
        id,
        kind,
        title,
        items: [{ id: newId("cst"), title: "", text: "" }],
      };
  }
}

/** A blank resume: header + the four core sections, in the given locale. */
export function blankResume(locale: ResumeLocale): ResumeDoc {
  return {
    header: {
      fullName: "",
      headline: "",
      email: "",
      phone: "",
      location: "",
      linkedin: "",
      website: "",
      photo: "",
    },
    sections: [
      defaultSection("summary", locale),
      defaultSection("experience", locale),
      defaultSection("education", locale),
      defaultSection("skills", locale),
    ],
    accentColor: DEFAULT_ACCENT,
    template: "classic",
    pageSize: "a4",
    locale,
  };
}

/** The filled example — EN and हिंदी variants (real Hindi, no transliteration). */
export function sampleResume(locale: ResumeLocale): ResumeDoc {
  if (locale === "hi") {
    return {
      header: {
        fullName: "प्रिया शर्मा",
        headline: "वरिष्ठ सॉफ़्टवेयर इंजीनियर · फुल-स्टैक",
        email: "priya.sharma@example.com",
        phone: "+91 98765 43210",
        location: "बेंगलुरु, भारत",
        linkedin: "linkedin.com/in/priyasharma",
        website: "priyasharma.dev",
        photo: "",
      },
      sections: [
        {
          id: "sm-hi",
          kind: "summary",
          title: "सारांश",
          text: "6 वर्षों का अनुभव रखने वाली फुल-स्टैक डेवलपर। बड़े पैमाने वाली वेब सेवाओं की रेखा-चित्र (architecture) बनाने और टीमों को सफल डिलीवरी के लिए ले जाने का रिकॉर्ड। React, Node.js और क्लाउड तकनीकों में माहिर।",
        },
        {
          id: "ex-hi",
          kind: "experience",
          title: "कार्य अनुभव",
          items: [
            {
              id: "ex-hi-1",
              role: "वरिष्ठ सॉफ़्टवेयर इंजीनियर",
              company: "टेकसेवा सॉल्यूशंस",
              location: "बेंगलुरु",
              start: "2022-03",
              end: "",
              current: true,
              bullets: [
                "8 लाख मासिक उपयोगकर्ताओं वाला बिलिंग प्लेटफ़ॉर्म फिर से बनाया — डाउनटाइम 40% घटा।",
                "10 सदस्यों की टीम को कोड रिव्यू और डिज़ाइन निर्णयों में मार्गदर्शन दिया।",
                "CI पाइपलाइन सुधारकर रिलीज़ समय 3 दिन से घटाकर 1 दिन किया।",
              ],
            },
            {
              id: "ex-hi-2",
              role: "सॉफ़्टवेयर इंजीनियर",
              company: "डिजिटल निगम",
              location: "पुणे",
              start: "2019-07",
              end: "2022-02",
              current: false,
              bullets: [
                "ग्राहक पोर्टल React + Node.js स्टैक पर विकसित किया।",
                "REST API की औसत प्रतिक्रिया समय 220 मि॰से॰ से 90 मि॰से॰ पर लाया।",
              ],
            },
          ],
        },
        {
          id: "ed-hi",
          kind: "education",
          title: "शिक्षा",
          items: [
            {
              id: "ed-hi-1",
              degree: "बी.टेक, कंप्यूटर विज्ञान",
              school: "राष्ट्रीय प्रौद्योगिकी संस्थान",
              location: "जयपुर",
              start: "2015",
              end: "2019",
              grade: "8.6 CGPA",
            },
          ],
        },
        {
          id: "sk-hi",
          kind: "skills",
          title: "कौशल",
          groups: [
            {
              id: "sk-hi-1",
              name: "भाषाएँ और फ़्रेमवर्क",
              items: ["TypeScript", "React", "Node.js", "Python"],
            },
            {
              id: "sk-hi-2",
              name: "क्लाउड और उपकरण",
              items: ["AWS", "Docker", "PostgreSQL", "GitHub Actions"],
            },
          ],
        },
        {
          id: "pr-hi",
          kind: "projects",
          title: "परियोजनाएँ",
          items: [
            {
              id: "pr-hi-1",
              name: "खुला-स्रोत बजट ऐप",
              link: "github.com/priyasharma/budget",
              description:
                "खर्चों को ट्रैक करने वाला PWA — 1,200+ स्टार, हर महीने 5,000 सक्रिय उपयोगकर्ता।",
            },
          ],
        },
        {
          id: "ce-hi",
          kind: "certifications",
          title: "प्रमाणपत्र",
          items: [
            {
              id: "ce-hi-1",
              name: "AWS सॉल्यूशंस आर्किटेक्ट – एसोसिएट",
              issuer: "Amazon Web Services",
              year: "2023",
            },
          ],
        },
        {
          id: "lg-hi",
          kind: "languages",
          title: "भाषाएँ",
          items: [
            { id: "lg-hi-1", name: "हिंदी", level: "मातृभाषा" },
            { id: "lg-hi-2", name: "अंग्रेज़ी", level: "व्यावसायिक" },
          ],
        },
      ],
      accentColor: DEFAULT_ACCENT,
      template: "classic",
      pageSize: "a4",
      locale: "hi",
    };
  }
  return {
    header: {
      fullName: "Priya Sharma",
      headline: "Senior Software Engineer · Full-stack",
      email: "priya.sharma@example.com",
      phone: "+91 98765 43210",
      location: "Bengaluru, India",
      linkedin: "linkedin.com/in/priyasharma",
      website: "priyasharma.dev",
      photo: "",
    },
    sections: [
      {
        id: "sm-en",
        kind: "summary",
        title: "Summary",
        text: "Full-stack developer with 6 years of experience shipping large-scale web services. Track record of designing clean architectures and guiding teams to on-time delivery. Strong in React, Node.js and cloud platforms.",
      },
      {
        id: "ex-en",
        kind: "experience",
        title: "Experience",
        items: [
          {
            id: "ex-en-1",
            role: "Senior Software Engineer",
            company: "Techseva Solutions",
            location: "Bengaluru",
            start: "2022-03",
            end: "",
            current: true,
            bullets: [
              "Rebuilt the billing platform used by 800k monthly users — cut downtime by 40%.",
              "Mentored a team of 10 through code reviews and design decisions.",
              "Improved the CI pipeline, taking releases from 3 days to 1 day.",
            ],
          },
          {
            id: "ex-en-2",
            role: "Software Engineer",
            company: "Digital Nimbus",
            location: "Pune",
            start: "2019-07",
            end: "2022-02",
            current: false,
            bullets: [
              "Developed the customer portal on a React + Node.js stack.",
              "Brought median REST API latency down from 220 ms to 90 ms.",
            ],
          },
        ],
      },
      {
        id: "ed-en",
        kind: "education",
        title: "Education",
        items: [
          {
            id: "ed-en-1",
            degree: "B.Tech, Computer Science",
            school: "National Institute of Technology",
            location: "Jaipur",
            start: "2015",
            end: "2019",
            grade: "8.6 CGPA",
          },
        ],
      },
      {
        id: "sk-en",
        kind: "skills",
        title: "Skills",
        groups: [
          {
            id: "sk-en-1",
            name: "Languages & frameworks",
            items: ["TypeScript", "React", "Node.js", "Python"],
          },
          {
            id: "sk-en-2",
            name: "Cloud & tools",
            items: ["AWS", "Docker", "PostgreSQL", "GitHub Actions"],
          },
        ],
      },
      {
        id: "pr-en",
        kind: "projects",
        title: "Projects",
        items: [
          {
            id: "pr-en-1",
            name: "Open-source budget app",
            link: "github.com/priyasharma/budget",
            description:
              "Expense-tracking PWA — 1,200+ stars and 5,000 monthly active users.",
          },
        ],
      },
      {
        id: "ce-en",
        kind: "certifications",
        title: "Certifications",
        items: [
          {
            id: "ce-en-1",
            name: "AWS Solutions Architect – Associate",
            issuer: "Amazon Web Services",
            year: "2023",
          },
        ],
      },
      {
        id: "lg-en",
        kind: "languages",
        title: "Languages",
        items: [
          { id: "lg-en-1", name: "Hindi", level: "Native" },
          { id: "lg-en-2", name: "English", level: "Professional" },
        ],
      },
    ],
    accentColor: DEFAULT_ACCENT,
    template: "classic",
    pageSize: "a4",
    locale: "en",
  };
}

/* ------------------------------------------------------------------ */
/* Worker boundary: defensive parse                                     */
/* ------------------------------------------------------------------ */

function str(v: unknown, max: number): string {
  return cleanText(v, max);
}
function line(v: unknown, max: number): string {
  return cleanLine(v, max);
}

function parseExperience(v: unknown): ExperienceItem {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<
    string,
    unknown
  >;
  return {
    id: String(o.id ?? ""),
    role: line(o.role, LIMITS.role),
    company: line(o.company, LIMITS.company),
    location: line(o.location, LIMITS.company),
    start: line(o.start, LIMITS.date),
    end: line(o.end, LIMITS.date),
    current: o.current === true,
    bullets: (Array.isArray(o.bullets) ? o.bullets : [])
      .slice(0, MAX_BULLETS_PER_ITEM)
      .map((b) => line(b, LIMITS.bullet))
      .filter((b) => b !== ""),
  };
}

function parseEducation(v: unknown): EducationItem {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<
    string,
    unknown
  >;
  return {
    id: String(o.id ?? ""),
    degree: line(o.degree, LIMITS.degree),
    school: line(o.school, LIMITS.school),
    location: line(o.location, LIMITS.company),
    start: line(o.start, LIMITS.date),
    end: line(o.end, LIMITS.date),
    grade: line(o.grade, LIMITS.grade),
  };
}

function parseSkills(v: unknown): {
  id: string;
  kind: "skills";
  title: string;
  groups: { id: string; name: string; items: string[] }[];
} {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<
    string,
    unknown
  >;
  const groups = (
    Array.isArray(o.groups) ? o.groups : []
  )
    .slice(0, MAX_SKILL_GROUPS)
    .map((g) => {
      const go = (typeof g === "object" && g !== null ? g : {}) as Record<
        string,
        unknown
      >;
      return {
        id: String(go.id ?? ""),
        name: line(go.name, LIMITS.skillGroup),
        items: (Array.isArray(go.items) ? go.items : [])
          .slice(0, MAX_SKILLS_PER_GROUP)
          .map((x) => line(x, LIMITS.skill))
          .filter((x) => x !== ""),
      };
    })
    .filter((g) => g.name !== "" || g.items.length > 0);
  return {
    id: String(o.id ?? ""),
    kind: "skills",
    title: line(o.title, LIMITS.sectionTitle),
    groups: groups.length
      ? groups
      : [{ id: "", name: "", items: [] }],
  };
}

function parseProjects(v: unknown): {
  id: string;
  kind: "projects";
  title: string;
  items: { id: string; name: string; link: string; description: string }[];
} {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<
    string,
    unknown
  >;
  return {
    id: String(o.id ?? ""),
    kind: "projects",
    title: line(o.title, LIMITS.sectionTitle),
    items: (Array.isArray(o.items) ? o.items : [])
      .slice(0, MAX_ITEMS_PER_SECTION)
      .map((it) => {
        const io = (typeof it === "object" && it !== null ? it : {}) as Record<
          string,
          unknown
        >;
        return {
          id: String(io.id ?? ""),
          name: line(io.name, LIMITS.projectName),
          link: line(io.link, LIMITS.link),
          description: cleanText(io.description, LIMITS.projectDesc),
        };
      }),
  };
}

function parseCerts(v: unknown): {
  id: string;
  kind: "certifications";
  title: string;
  items: { id: string; name: string; issuer: string; year: string }[];
} {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<
    string,
    unknown
  >;
  return {
    id: String(o.id ?? ""),
    kind: "certifications",
    title: line(o.title, LIMITS.sectionTitle),
    items: (Array.isArray(o.items) ? o.items : [])
      .slice(0, MAX_ITEMS_PER_SECTION)
      .map((it) => {
        const io = (typeof it === "object" && it !== null ? it : {}) as Record<
          string,
          unknown
        >;
        return {
          id: String(io.id ?? ""),
          name: line(io.name, LIMITS.certName),
          issuer: line(io.issuer, LIMITS.issuer),
          year: line(io.year, LIMITS.year),
        };
      }),
  };
}

function parseLanguages(v: unknown): {
  id: string;
  kind: "languages";
  title: string;
  items: { id: string; name: string; level: string }[];
} {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<
    string,
    unknown
  >;
  return {
    id: String(o.id ?? ""),
    kind: "languages",
    title: line(o.title, LIMITS.sectionTitle),
    items: (Array.isArray(o.items) ? o.items : [])
      .slice(0, MAX_ITEMS_PER_SECTION)
      .map((it) => {
        const io = (typeof it === "object" && it !== null ? it : {}) as Record<
          string,
          unknown
        >;
        return {
          id: String(io.id ?? ""),
          name: line(io.name, LIMITS.langName),
          level: line(io.level, LIMITS.langLevel),
        };
      }),
  };
}

function parseCustom(
  v: unknown
): {
  id: string;
  kind: "custom";
  title: string;
  items: CustomItem[];
} {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<
    string,
    unknown
  >;
  return {
    id: String(o.id ?? ""),
    kind: "custom",
    title: line(o.title, LIMITS.sectionTitle),
    items: (Array.isArray(o.items) ? o.items : [])
      .slice(0, MAX_ITEMS_PER_SECTION)
      .map((it) => {
        const io = (typeof it === "object" && it !== null ? it : {}) as Record<
          string,
          unknown
        >;
        return {
          id: String(io.id ?? ""),
          title: line(io.title, LIMITS.customTitle),
          text: cleanText(io.text, LIMITS.customText),
        };
      }),
  };
}

function coerceDoc(v: unknown): ResumeDoc {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<
    string,
    unknown
  >;
  const h = (typeof o.header === "object" && o.header !== null ? o.header : {}) as Record<
    string,
    unknown
  >;
  const rawSections = Array.isArray(o.sections)
    ? o.sections.slice(0, MAX_SECTIONS)
    : [];
  const taken = new Set<string>();
  const sections: ResumeSection[] = [];
  for (const sv of rawSections) {
    const so = (typeof sv === "object" && sv !== null ? sv : {}) as Record<
      string,
      unknown
    >;
    const kind = so.kind;
    const common = {
      id: dedupeId(so.id, taken, String(kind ?? "sec")),
      title: line(so.title, LIMITS.sectionTitle),
    };
    if (kind === "summary") {
      sections.push({
        ...common,
        kind: "summary",
        text: str(so.text, LIMITS.summary),
      });
    } else if (kind === "experience") {
      const p = {
        id: "",
        kind: "experience" as const,
        title: common.title,
        items: (Array.isArray(so.items) ? so.items : [])
          .slice(0, MAX_ITEMS_PER_SECTION)
          .map(parseExperience),
      };
      sections.push({ ...p, id: common.id });
    } else if (kind === "education") {
      sections.push({
        id: common.id,
        kind: "education",
        title: common.title,
        items: (Array.isArray(so.items) ? so.items : [])
          .slice(0, MAX_ITEMS_PER_SECTION)
          .map(parseEducation),
      });
    } else if (kind === "skills") {
      const p = parseSkills(so);
      sections.push({ ...p, id: common.id, title: common.title });
    } else if (kind === "projects") {
      const p = parseProjects(so);
      sections.push({ ...p, id: common.id, title: common.title });
    } else if (kind === "certifications") {
      const p = parseCerts(so);
      sections.push({ ...p, id: common.id, title: common.title });
    } else if (kind === "languages") {
      const p = parseLanguages(so);
      sections.push({ ...p, id: common.id, title: common.title });
    } else if (kind === "custom") {
      const p = parseCustom(so);
      sections.push({ ...p, id: common.id, title: common.title });
    }
    // unknown kinds are dropped (worker-boundary contract)
  }

  const template = TEMPLATES.includes(o.template as ResumeTemplate)
    ? (o.template as ResumeTemplate)
    : "classic";
  const pageSize = PAGE_SIZES.includes(o.pageSize as ResumePageSize)
    ? (o.pageSize as ResumePageSize)
    : "a4";
  const locale: ResumeLocale = o.locale === "hi" ? "hi" : "en";
  const accent =
    typeof o.accentColor === "string" && AC_RE.test(o.accentColor)
      ? o.accentColor
      : DEFAULT_ACCENT;

  return {
    header: {
      fullName: line(h.fullName, LIMITS.fullName),
      headline: line(h.headline, LIMITS.headline),
      email: line(h.email, LIMITS.contact),
      phone: line(h.phone, LIMITS.contact),
      location: line(h.location, LIMITS.contact),
      linkedin: line(h.linkedin, LIMITS.contact),
      website: line(h.website, LIMITS.contact),
      photo: img(h.photo),
    },
    sections,
    accentColor: accent,
    template,
    pageSize,
    locale,
  };
}

/**
 * Parse the serialized `resume` option / run payload. Everything
 * untrusted is clamped/validated — a tampered or stale payload can
 * never reach the renderer as a wrong type, an unknown kind or an
 * oversized image. Unreadable JSON falls back to a blank resume.
 */
export function parseResumeRun(raw: string): ResumeRun {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const o = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  const labels: Record<string, string> = {};
  if (typeof o.labels === "object" && o.labels !== null) {
    for (const [k, v] of Object.entries(o.labels as Record<string, unknown>)) {
      if (typeof v === "string" && k.length <= 16) labels[k] = v.slice(0, 300);
    }
  }
  return {
    d: coerceDoc(o.d),
    labels,
    locale: o.locale === "hi" ? "hi" : "en",
  };
}

/* ------------------------------------------------------------------ */
/* Output file name (unicode-safe, no regex property escapes)           */
/* ------------------------------------------------------------------ */

function safeNameChar(c: string): boolean {
  const code = c.charCodeAt(0);
  if (code >= 0x80) return true; // Devanagari and every other script
  return /[A-Za-z0-9._-]/.test(c);
}

/**
 * "Priya Sharma" + "Resume" → "Priya-Sharma-Resume". Falls back to the
 * file word alone, then "resume". Unicode letters survive (Hindi names
 * make Hindi file names), path separators and symbols do not.
 */
export function outputBaseName(doc: ResumeDoc, fileWord: string): string {
  const parts = [cleanLine(doc.header.fullName, 120), cleanLine(fileWord, 60)]
    .filter(Boolean)
    .map((p) =>
      p
        .split(" ")
        .map((word) =>
          [...word].filter((c) => c !== " " && safeNameChar(c)).join("")
        )
        .filter((word) => word.length > 0)
        .join("-")
    )
    .filter((p) => p.length > 0);
  const name = parts.join("-").slice(0, 80);
  return name || "resume";
}
