/**
 * Create resume — the 8 templates (P3-RESUME).
 *
 * A template is PURE DATA: accent colour, page margins, text density, the
 * section order, an optional sidebar band, the section-title style and the
 * default photo shape. model.ts turns (resume + template + measurer) into
 * pages of draw ops; nothing here touches a platform API, so the same
 * definition drives the canvas preview, the PDF worker and the smoke.
 *
 * Template name/description strings live in i18n (nameKey/descKey); the
 * merge script cross-checks they exist in both catalogs.
 *
 * Colours: warm, print-friendly. NO indigo/blue anywhere (project rule).
 */

import type { LocaleId, PageSizeId } from "./types";

/* ------------------------------ section ids ------------------------------ */

export type SectionId =
  | "personal"
  | "summary"
  | "experience"
  | "education"
  | "skills"
  | "projects"
  | "certifications"
  | "languages"
  | "custom"
  | "declaration";

/** The default order (single-column templates). */
export const DEFAULT_SECTION_ORDER: SectionId[] = [
  "personal",
  "summary",
  "experience",
  "education",
  "skills",
  "projects",
  "certifications",
  "languages",
  "custom",
  "declaration",
];

/* ------------------------------ shapes ------------------------------ */

export interface SidebarConfig {
  /** Band width in pt. */
  width: number;
  /** Band background (#rrggbb). */
  fill: string;
  /** Primary text colour ON the band. */
  ink: string;
  /** Secondary text colour ON the band. */
  muted: string;
  /** Hairline rule colour ON the band. */
  rule: string;
}

export interface Density {
  /** Body text size in pt. */
  bodySize: number;
  /** Secondary text size in pt. */
  smallSize: number;
  /** Line height as a multiple of the font size. */
  lineHeight: number;
  /** Space above each section title (pt). */
  sectionGap: number;
  /** Space between entries inside a section (pt). */
  entryGap: number;
  /** Space between wrapped paragraphs (pt). */
  paraGap: number;
}

export interface ResumeTemplate {
  id: string;
  /** i18n key for the template name. */
  nameKey: string;
  /** i18n key for the template description. */
  descKey: string;
  /** #rrggbb accent (overridable by the swatches). */
  accentHex: string;
  /** Page margin in pt. */
  pageMargin: number;
  density: Density;
  sectionOrder: SectionId[];
  /** Null = single column. Sidebar content: contact + skills + languages. */
  sidebar: SidebarConfig | null;
  sectionTitle: {
    size: number;
    style: "rule" | "uppercase" | "plain";
    color: "accent" | "ink";
  };
  photoStyle: "circle" | "square" | "none";
  nameSize: number;
  titleSize: number;
  header: "centered" | "left" | "band";
  /** Skills rendered as rows with level dots, or inline chips. */
  skillsStyle: "rows" | "chips";
  /** Experience entries hang on a vertical rail with dots. */
  timelineRail: boolean;
  /** Declaration gets a hairline box (classic biodata look). */
  declEmphasis: boolean;
}

/* ------------------------------ the templates ------------------------------ */

const SIDEBAR_MAIN_ORDER: SectionId[] = [
  "personal",
  "summary",
  "experience",
  "education",
  "projects",
  "certifications",
  "custom",
  "declaration",
];

export const TEMPLATES: ResumeTemplate[] = [
  {
    id: "classic",
    nameKey: "resume.tplClassic",
    descKey: "resume.tplClassicDesc",
    accentHex: "#7f1d1d",
    pageMargin: 42,
    density: {
      bodySize: 9.5,
      smallSize: 8.5,
      lineHeight: 1.3,
      sectionGap: 11,
      entryGap: 8,
      paraGap: 4,
    },
    sectionOrder: [...DEFAULT_SECTION_ORDER],
    sidebar: null,
    sectionTitle: { size: 10.5, style: "rule", color: "ink" },
    photoStyle: "square",
    nameSize: 20,
    titleSize: 11,
    header: "centered",
    skillsStyle: "rows",
    timelineRail: false,
    declEmphasis: true,
  },
  {
    id: "modern",
    nameKey: "resume.tplModern",
    descKey: "resume.tplModernDesc",
    accentHex: "#0f766e",
    pageMargin: 44,
    density: {
      bodySize: 10,
      smallSize: 9,
      lineHeight: 1.4,
      sectionGap: 13,
      entryGap: 9,
      paraGap: 4,
    },
    sectionOrder: [...SIDEBAR_MAIN_ORDER],
    sidebar: {
      width: 185,
      fill: "#f4f1ec",
      ink: "#1c1917",
      muted: "#57534e",
      rule: "#d6d3d1",
    },
    sectionTitle: { size: 10.5, style: "rule", color: "accent" },
    photoStyle: "circle",
    nameSize: 21,
    titleSize: 11,
    header: "left",
    skillsStyle: "rows",
    timelineRail: false,
    declEmphasis: false,
  },
  {
    id: "minimal",
    nameKey: "resume.tplMinimal",
    descKey: "resume.tplMinimalDesc",
    accentHex: "#57534e",
    pageMargin: 56,
    density: {
      bodySize: 10,
      smallSize: 9,
      lineHeight: 1.5,
      sectionGap: 18,
      entryGap: 12,
      paraGap: 5,
    },
    sectionOrder: [...DEFAULT_SECTION_ORDER],
    sidebar: null,
    sectionTitle: { size: 10, style: "rule", color: "ink" },
    photoStyle: "circle",
    nameSize: 20,
    titleSize: 11,
    header: "left",
    skillsStyle: "rows",
    timelineRail: false,
    declEmphasis: false,
  },
  {
    id: "compact",
    nameKey: "resume.tplCompact",
    descKey: "resume.tplCompactDesc",
    accentHex: "#374151",
    pageMargin: 32,
    density: {
      bodySize: 9,
      smallSize: 8,
      lineHeight: 1.28,
      sectionGap: 8,
      entryGap: 5,
      paraGap: 2,
    },
    sectionOrder: [...DEFAULT_SECTION_ORDER],
    sidebar: null,
    sectionTitle: { size: 9.5, style: "plain", color: "ink" },
    photoStyle: "square",
    nameSize: 17,
    titleSize: 10,
    header: "left",
    skillsStyle: "chips",
    timelineRail: false,
    declEmphasis: false,
  },
  {
    id: "timeline",
    nameKey: "resume.tplTimeline",
    descKey: "resume.tplTimelineDesc",
    accentHex: "#166534",
    pageMargin: 42,
    density: {
      bodySize: 9.5,
      smallSize: 8.5,
      lineHeight: 1.3,
      sectionGap: 11,
      entryGap: 8,
      paraGap: 4,
    },
    sectionOrder: [...DEFAULT_SECTION_ORDER],
    sidebar: null,
    sectionTitle: { size: 10.5, style: "rule", color: "accent" },
    photoStyle: "circle",
    nameSize: 20,
    titleSize: 11,
    header: "left",
    skillsStyle: "rows",
    timelineRail: true,
    declEmphasis: false,
  },
  {
    id: "sidebar-dark",
    nameKey: "resume.tplSidebarDark",
    descKey: "resume.tplSidebarDarkDesc",
    accentHex: "#92400e",
    pageMargin: 44,
    density: {
      bodySize: 10,
      smallSize: 9,
      lineHeight: 1.4,
      sectionGap: 13,
      entryGap: 9,
      paraGap: 4,
    },
    sectionOrder: [...SIDEBAR_MAIN_ORDER],
    sidebar: {
      width: 185,
      fill: "#1c1917",
      ink: "#fafaf9",
      muted: "#d6d3d1",
      rule: "#44403c",
    },
    sectionTitle: { size: 10.5, style: "uppercase", color: "accent" },
    photoStyle: "circle",
    nameSize: 21,
    titleSize: 11,
    header: "left",
    skillsStyle: "rows",
    timelineRail: false,
    declEmphasis: false,
  },
  {
    id: "elegant",
    nameKey: "resume.tplElegant",
    descKey: "resume.tplElegantDesc",
    accentHex: "#881337",
    pageMargin: 46,
    density: {
      bodySize: 10,
      smallSize: 9,
      lineHeight: 1.42,
      sectionGap: 15,
      entryGap: 10,
      paraGap: 4,
    },
    sectionOrder: [...DEFAULT_SECTION_ORDER],
    sidebar: null,
    sectionTitle: { size: 10, style: "uppercase", color: "accent" },
    photoStyle: "circle",
    nameSize: 24,
    titleSize: 12,
    header: "band",
    skillsStyle: "rows",
    timelineRail: false,
    declEmphasis: false,
  },
  {
    id: "fresher",
    nameKey: "resume.tplFresher",
    descKey: "resume.tplFresherDesc",
    accentHex: "#3f6212",
    pageMargin: 42,
    density: {
      bodySize: 9.5,
      smallSize: 8.5,
      lineHeight: 1.3,
      sectionGap: 11,
      entryGap: 8,
      paraGap: 4,
    },
    // India-specific ordering: education and projects before experience.
    sectionOrder: [
      "personal",
      "summary",
      "education",
      "skills",
      "projects",
      "experience",
      "certifications",
      "languages",
      "custom",
      "declaration",
    ],
    sidebar: null,
    sectionTitle: { size: 10.5, style: "rule", color: "ink" },
    photoStyle: "square",
    nameSize: 20,
    titleSize: 11,
    header: "left",
    skillsStyle: "rows",
    timelineRail: false,
    declEmphasis: false,
  },
];

export const DEFAULT_TEMPLATE_ID = "classic";

const TEMPLATE_BY_ID = new Map<string, ResumeTemplate>(
  TEMPLATES.map((template) => [template.id, template])
);

/** Safe lookup — unknown ids fall back to the default template. */
export function templateById(id: string): ResumeTemplate {
  return (
    TEMPLATE_BY_ID.get(id) ??
    (TEMPLATE_BY_ID.get(DEFAULT_TEMPLATE_ID) as ResumeTemplate)
  );
}

export function isTemplateId(id: string): boolean {
  return TEMPLATE_BY_ID.has(id);
}

/* ------------------------------ accent swatches ------------------------------ */

/**
 * Accent overrides offered in the UI (NO indigo/blue — project rule).
 * `null` = the template's own accent.
 */
export const ACCENT_SWATCHES: { hex: string | null; key: string }[] = [
  { hex: null, key: "resume.accentDefault" },
  { hex: "#71797e", key: "resume.accentSteel" },
  { hex: "#166534", key: "resume.accentForest" },
  { hex: "#7f1d1d", key: "resume.accentMaroon" },
  { hex: "#0f766e", key: "resume.accentTeal" },
  { hex: "#374151", key: "resume.accentGraphite" },
];

/* ------------------------------ page sizes ------------------------------ */

/** Exact PDF points. */
export const PAGE_SIZES: Record<PageSizeId, { w: number; h: number }> = {
  a4: { w: 595.28, h: 841.89 },
  letter: { w: 612, h: 792 },
};

export type { LocaleId };
