import {
  buildDocExcerpt,
  isLikelyScanned,
  type DocExcerpt,
  type ExtractedPage,
} from "../chat-with-pdf/model";

/**
 * Summarize PDF (R11) — pure, deterministic model shared by the surface and
 * scripts/smoke-summarize-pdf.ts. No DOM, no workers, no network.
 *
 * Privacy shape (identical to Chat with PDF / Translate PDF): the file is
 * extracted on-device by the SAME chat extraction worker; ONLY the bounded,
 * page-marked excerpt (reused verbatim from the chat model — buildDocExcerpt,
 * head+tail trim, [[p N]] markers) plus the option codes ever POST to
 * /api/summarize. No file bytes, no server storage, nothing logged.
 */

export const SUMMARIZE_LIMITS = {
  /** Max pages in one document (same ceiling as Translate PDF). */
  maxPages: 200,
  /** Excerpt budget — deliberately the chat model's constant. */
  excerptBudget: 48_000,
  /** Below this many extracted characters the doc counts as "no text". */
  scannedThresholdChars: 40,
} as const;

export interface SummaryLanguage {
  code: "en" | "hi";
  /** Native label shown in the select. */
  native: string;
  /** Name the model reads in the prompt. */
  promptName: string;
}

export const SUMMARY_LANGUAGES: SummaryLanguage[] = [
  { code: "en", native: "English", promptName: "English" },
  { code: "hi", native: "हिन्दी", promptName: "Hindi (Devanagari script)" },
];

export type SummaryLength = "brief" | "standard" | "detailed";

export const SUMMARY_LENGTHS: SummaryLength[] = [
  "brief",
  "standard",
  "detailed",
];

export function isSummaryLanguage(code: unknown): code is "en" | "hi" {
  return code === "en" || code === "hi";
}

export function isSummaryLength(value: unknown): value is SummaryLength {
  return value === "brief" || value === "standard" || value === "detailed";
}

/** Words the model is told to stay near, per length. */
export const SUMMARY_TARGET_WORDS: Record<SummaryLength, [number, number]> = {
  brief: [120, 180],
  standard: [280, 420],
  detailed: [480, 750],
};

/* --------------------- structured summary model --------------------- */

export type SummarySectionKey =
  | "tldr"
  | "keyPoints"
  | "actionItems"
  | "details"
  | "other";

export interface SummarySection {
  /** Canonical key (headers are always English per the prompt contract). */
  key: SummarySectionKey;
  /** Raw header text as the model wrote it (display fallback). */
  header: string;
  /** Bullet items when the body is a list. */
  bullets: string[];
  /** Paragraphs otherwise (each a run of joined non-list lines). */
  paragraphs: string[];
}

const SECTION_MATCHERS: [SummarySectionKey, RegExp][] = [
  ["tldr", /^tl;?\s*dr/i],
  ["keyPoints", /^key\s*points/i],
  ["actionItems", /^action\s*items/i],
  ["details", /^details/i],
];

function sectionKeyOf(header: string): SummarySectionKey {
  for (const [key, re] of SECTION_MATCHERS) {
    if (re.test(header.trim())) return key;
  }
  return "other";
}

/**
 * Parse the model's markdown contract (## sections, "-" bullets) into
 * structured data for display and export. Deterministic and total: junk
 * input yields empty arrays, never a throw. Text before the first ## is
 * treated as a TL;DR body (defensive — the prompt forbids preambles).
 */
export function parseSummarySections(markdown: string): SummarySection[] {
  const flat = String(markdown ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/^```[a-z]*\n?|```$/gim, "");
  const lines = flat.split("\n");

  const sections: SummarySection[] = [];
  let current: SummarySection | null = null;
  let para: string[] = [];

  const flushPara = (): void => {
    if (!current || para.length === 0) return;
    const text = para.join(" ").trim();
    para = [];
    if (text.length > 0) current.paragraphs.push(text);
  };

  const ensure = (header: string, key: SummarySectionKey): SummarySection => {
    flushPara();
    if (current) sections.push(current);
    current = { key, header: header.trim(), bullets: [], paragraphs: [] };
    return current;
  };

  for (const raw of lines) {
    const line = raw.trim();
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const header = heading[1].replace(/[:.]+$/, "");
      ensure(header, sectionKeyOf(header));
      continue;
    }
    if (!current) {
      // Defensive: preamble text before any header becomes the TL;DR.
      if (line.length === 0) continue;
      current = { key: "tldr", header: "TL;DR", bullets: [], paragraphs: [] };
    }
    if (line.length === 0) {
      flushPara();
      continue;
    }
    const bullet = /^(?:[-*•])\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      current.bullets.push(bullet[1].trim());
      continue;
    }
    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flushPara();
      current.bullets.push(numbered[2].trim());
      continue;
    }
    // Skip markdown noise the prompt already forbids (hrules, bare #s).
    if (/^(---+|===+|#+)$/.test(line)) {
      flushPara();
      continue;
    }
    para.push(line.replace(/\*\*/g, "").trim());
  }
  flushPara();
  if (current) sections.push(current);

  // Drop empty sections entirely (e.g. an "Action items" header with no body).
  return sections.filter(
    (s) => s.bullets.length > 0 || s.paragraphs.length > 0,
  );
}

/** True when the text has Devanagari code points (font routing). */
export function hasDevanagari(text: string): boolean {
  return /[\u0900-\u097F]/.test(String(text ?? ""));
}

/* ------------------------- naming + exports ------------------------- */

export type SummaryExportFormat = "md" | "txt";

export interface SummaryExportLabels {
  title: string;
  document: string;
  generated: string;
  tldr: string;
  keyPoints: string;
  actionItems: string;
  details: string;
}

function sectionLabel(section: SummarySection, labels: SummaryExportLabels) {
  switch (section.key) {
    case "tldr":
      return labels.tldr;
    case "keyPoints":
      return labels.keyPoints;
    case "actionItems":
      return labels.actionItems;
    case "details":
      return labels.details;
    default:
      return section.header;
  }
}

function stripPdfExt(name: string): string {
  const trimmed = String(name ?? "").trim();
  return /\.pdf$/i.test(trimmed) ? trimmed.slice(0, -4) : trimmed;
}

/** Output base name: "report.pdf" + hi → "report-सारांश". */
export function summarizeBaseName(
  docName: string,
  language: "en" | "hi",
): string {
  const base = stripPdfExt(docName) || "document";
  const suffix = language === "hi" ? "सारांश" : "summary";
  return `${base}-${suffix}`;
}

/** Markdown export — localized headers, bullets, citations kept verbatim. */
export function buildSummaryMarkdown(
  docName: string,
  sections: SummarySection[],
  stamp: string,
  labels: SummaryExportLabels,
): string {
  const parts: string[] = [
    `# ${labels.title}`,
    "",
    `- **${labels.document}:** ${docName}`,
    `- **${labels.generated}:** ${stamp}`,
    "",
    "---",
    "",
  ];
  for (const section of sections) {
    parts.push(`## ${sectionLabel(section, labels)}`);
    parts.push("");
    for (const p of section.paragraphs) {
      parts.push(p);
      parts.push("");
    }
    for (const b of section.bullets) {
      parts.push(`- ${b}`);
    }
    if (section.bullets.length > 0) parts.push("");
  }
  return parts.join("\n").replace(/\n+$/, "\n");
}

/** Plain-text export — same content, ASCII structure, no markdown syntax. */
export function buildSummaryPlainText(
  docName: string,
  sections: SummarySection[],
  stamp: string,
  labels: SummaryExportLabels,
): string {
  const parts: string[] = [
    labels.title,
    `${labels.document}: ${docName}`,
    `${labels.generated}: ${stamp}`,
    "",
    "========================================",
    "",
  ];
  for (const section of sections) {
    parts.push(sectionLabel(section, labels).toUpperCase());
    parts.push("");
    for (const p of section.paragraphs) {
      parts.push(p);
      parts.push("");
    }
    for (const b of section.bullets) {
      parts.push(`- ${b}`);
    }
    if (section.bullets.length > 0) parts.push("");
  }
  return parts.join("\n").replace(/\n+$/, "\n");
}

/* --------------------- excerpt reuse (chat recipe) ------------------- */

export type { DocExcerpt, ExtractedPage };

export { buildDocExcerpt, isLikelyScanned };
