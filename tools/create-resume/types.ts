/**
 * Create resume — document model (CR-66, the 66th DocoPDF tool).
 *
 * The ResumeDoc is a plain, serializable tree: a header (identity +
 * optional circular photo), an ORDERED list of sections (each typed by
 * kind and carrying its own items) and four design fields. Everything a
 * render needs — nothing about the DOM, the worker or storage — so the
 * same value flows to the HTML preview, the localStorage draft, the
 * saved copies and the worker boundary untouched.
 */

/** The three shipped templates (see render.ts for the drawing of each). */
export type ResumeTemplate = "classic" | "modern" | "compact";

/** Page size — A4 (595.28 × 841.89 pt) or US Letter (612 × 792 pt). */
export type ResumePageSize = "a4" | "letter";

/** Content language of authored strings (samples + date formatting). */
export type ResumeLocale = "en" | "hi";

/** Every section kind the editor can add. */
export type ResumeSectionKind =
  | "summary"
  | "experience"
  | "education"
  | "skills"
  | "projects"
  | "certifications"
  | "languages"
  | "custom";

/* ------------------------------------------------------------------ */
/* Header                                                              */
/* ------------------------------------------------------------------ */

export interface ResumeHeader {
  fullName: string;
  headline: string;
  email: string;
  phone: string;
  location: string;
  linkedin: string;
  website: string;
  /**
   * Optional portrait. PNG (recommended — the surface circle-crops to a
   * transparent square so the PDF needs no masking) or JPEG data-URL,
   * ≤300 px, ≤1.5 MB. Empty string = no photo (the ATS-safe default).
   */
  photo: string;
}

/* ------------------------------------------------------------------ */
/* Section item shapes                                                 */
/* ------------------------------------------------------------------ */

export interface ExperienceItem {
  id: string;
  role: string;
  company: string;
  location: string;
  /** Free-form: "2021-06", "2021" or verbatim text like "Monsoon 2020". */
  start: string;
  end: string;
  /** true → the end date is ignored and "Present" is shown. */
  current: boolean;
  /** Achievement lines, printed as real "• " text (never images). */
  bullets: string[];
}

export interface EducationItem {
  id: string;
  degree: string;
  school: string;
  location: string;
  start: string;
  end: string;
  /** Grade / percentage / GPA. */
  grade: string;
}

export interface SkillGroup {
  id: string;
  name: string;
  /** Individual skill chips. */
  items: string[];
}

export interface ProjectItem {
  id: string;
  name: string;
  link: string;
  description: string;
}

export interface CertificationItem {
  id: string;
  name: string;
  issuer: string;
  year: string;
}

export interface LanguageItem {
  id: string;
  /** Proficiency, e.g. "Native", "Professional". */
  level: string;
  name: string;
}

export interface CustomItem {
  id: string;
  /** Optional sub-heading (blank = plain text block). */
  title: string;
  text: string;
}

/* ------------------------------------------------------------------ */
/* Sections (ordered, discriminated by kind)                          */
/* ------------------------------------------------------------------ */

export type ResumeSection =
  | { id: string; kind: "summary"; title: string; text: string }
  | {
      id: string;
      kind: "experience";
      title: string;
      items: ExperienceItem[];
    }
  | { id: string; kind: "education"; title: string; items: EducationItem[] }
  | { id: string; kind: "skills"; title: string; groups: SkillGroup[] }
  | { id: string; kind: "projects"; title: string; items: ProjectItem[] }
  | {
      id: string;
      kind: "certifications";
      title: string;
      items: CertificationItem[];
    }
  | { id: string; kind: "languages"; title: string; items: LanguageItem[] }
  | { id: string; kind: "custom"; title: string; items: CustomItem[] };

/* ------------------------------------------------------------------ */
/* Document                                                            */
/* ------------------------------------------------------------------ */

export interface ResumeDoc {
  header: ResumeHeader;
  /** Render order — the ▲▼ buttons rewrite this array. */
  sections: ResumeSection[];
  /** "#rrggbb" — applied by modern (sidebar) and compact (rules); classic stays near-black. */
  accentColor: string;
  template: ResumeTemplate;
  pageSize: ResumePageSize;
  /** Locale the content was authored in (samples, default titles). */
  locale: ResumeLocale;
}

/** Labels the surface pre-resolves via t() so the PDF matches the UI language. */
export type ResumeLabels = Record<string, string>;

/** Worker run payload — the doc plus the resolved labels and locale. */
export interface ResumeRun {
  d: ResumeDoc;
  labels: ResumeLabels;
  /** Language for date ranges ("Present"/"वर्तमान", month names). */
  locale: ResumeLocale;
}
