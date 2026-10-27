/**
 * DocoPDF smart format router (P3) — OUR own route planner over the tool
 * registry (the multi-hop idea studied from a competitor's converter graph,
 * implemented from scratch for our tool set with honest, curated edges).
 *
 * The graph: nodes are file formats (pdf, docx, jpg, …), edges are our
 * tools ("accepts" → "produces"). findRoutes() plans multi-hop chains a
 * user can follow manually (each hop is a real, live tool). Routes are
 * ranked by hop count, then combined popularity, then chain simplicity.
 */

import { ALL_TOOLS } from "./registry";
import type { Locale } from "@/i18n";

/** Canonical format ids (lowercase, no dots). */
export type FormatId = string;

export interface RouteStep {
  toolId: string;
  from: FormatId;
  to: FormatId;
}

export interface FormatRoute {
  steps: RouteStep[];
  /** Total popularity of the chain's tools (higher = more mainstream). */
  score: number;
}

/**
 * Curated produces-map: toolId → output format. Only tools with ONE clear
 * primary output format are listed (honest edges only). Accepts come from
 * the registry (`accepts` field) or an explicit override here.
 */
const TOOL_OUTPUT: Record<string, FormatId> = {
  // convert-to family → pdf
  "word-to-pdf": "pdf",
  "excel-to-pdf": "pdf",
  "powerpoint-to-pdf": "pdf",
  "publisher-to-pdf": "pdf",
  "odt-to-pdf": "pdf",
  "rtf-to-pdf": "pdf",
  "epub-to-pdf": "pdf",
  "txt-to-pdf": "pdf",
  "markdown-to-pdf": "pdf",
  "html-to-pdf": "pdf",
  "jpg-to-pdf": "pdf",
  "png-to-pdf": "pdf",
  "webp-to-pdf": "pdf",
  "heic-to-pdf": "pdf",
  "svg-to-pdf": "pdf",
  "tiff-to-pdf": "pdf",
  // convert-from family ← pdf
  "pdf-to-jpg": "jpg",
  "pdf-to-png": "png",
  "pdf-to-webp": "webp",
  "pdf-to-tiff": "tiff",
  "pdf-to-svg": "svg",
  "pdf-to-txt": "txt",
  "pdf-to-html": "html",
  "pdf-to-markdown": "markdown",
  "pdf-to-odt": "odt",
  "pdf-to-word": "docx",
  "pdf-to-excel": "xlsx",
  "pdf-to-powerpoint": "pptx",
  // images
  "heic-to-jpg": "jpg",
  "heic-to-png": "png",
  "webp-to-jpg": "jpg",
  "webp-to-png": "png",
  // create family
  "create-pdf": "pdf",
  "write-pdf": "pdf",
  "images-to-pdf": "pdf",
  "scan-pdf": "pdf",
  "webpage-to-pdf": "pdf",
  "generate-qr-code": "png",
  "create-photo-collage": "pdf",
  "create-card": "pdf",
  "create-resume": "pdf",
  // invoices
  "create-invoice": "pdf",
  "create-invoice-visually": "pdf",
  "create-electronic-invoice": "xml",
  "xml-invoice-to-pdf": "pdf",
};

/** Input formats per tool (from the registry `accepts` + overrides). */
const TOOL_INPUT: Record<string, FormatId[]> = {
  "word-to-pdf": ["docx", "doc"],
  "excel-to-pdf": ["xlsx", "xls", "csv"],
  "powerpoint-to-pdf": ["pptx", "ppt"],
  "publisher-to-pdf": ["pub"],
  "odt-to-pdf": ["odt"],
  "rtf-to-pdf": ["rtf"],
  "epub-to-pdf": ["epub"],
  "txt-to-pdf": ["txt"],
  "markdown-to-pdf": ["markdown", "md"],
  "html-to-pdf": ["html"],
  "jpg-to-pdf": ["jpg", "jpeg"],
  "png-to-pdf": ["png"],
  "webp-to-pdf": ["webp"],
  "heic-to-pdf": ["heic", "heif"],
  "svg-to-pdf": ["svg"],
  "tiff-to-pdf": ["tiff", "tif"],
  "pdf-to-word": ["pdf"],
  "pdf-to-excel": ["pdf"],
  "pdf-to-powerpoint": ["pdf"],
  "pdf-to-odt": ["pdf"],
  "pdf-to-txt": ["pdf"],
  "pdf-to-html": ["pdf"],
  "pdf-to-markdown": ["pdf"],
  "pdf-to-jpg": ["pdf"],
  "pdf-to-png": ["pdf"],
  "pdf-to-webp": ["pdf"],
  "pdf-to-tiff": ["pdf"],
  "pdf-to-svg": ["pdf"],
  "heic-to-jpg": ["heic", "heif"],
  "heic-to-png": ["heic", "heif"],
  "webp-to-jpg": ["webp"],
  "webp-to-png": ["webp"],
  "webpage-to-pdf": ["url"],
  "create-electronic-invoice": ["xlsx", "csv"],
  "xml-invoice-to-pdf": ["xml"],
};

/** Every format that appears on any edge (for query parsing). */
export const KNOWN_FORMATS: FormatId[] = (() => {
  const set = new Set<FormatId>();
  for (const [id, out] of Object.entries(TOOL_OUTPUT)) {
    set.add(out);
    for (const f of TOOL_INPUT[id] ?? []) set.add(f);
  }
  // Registry accepts also feed the vocabulary.
  for (const t of ALL_TOOLS) {
    if (t.accepts && t.accepts !== "pdf") set.add(t.accepts);
  }
  return [...set];
})();

interface Edge {
  toolId: string;
  from: FormatId;
  to: FormatId;
  popularity: number;
}

const EDGES: Edge[] = (() => {
  const byId = new Map(ALL_TOOLS.map((t) => [t.id, t]));
  const list: Edge[] = [];
  for (const [toolId, to] of Object.entries(TOOL_OUTPUT)) {
    const tool = byId.get(toolId);
    if (!tool) continue; // honest edges only — registry entries that exist
    const inputs = TOOL_INPUT[toolId] ?? (tool.accepts ? [tool.accepts] : []);
    for (const from of inputs) {
      list.push({ toolId, from, to, popularity: tool.popularity });
    }
  }
  return list;
})();

/** Does a DIRECT tool exist for from → to? */
export function hasDirectRoute(from: FormatId, to: FormatId): boolean {
  return EDGES.some((e) => e.from === from && e.to === to);
}

/**
 * Find multi-hop routes from → to (BFS by hop count; up to `maxHops` tool
 * steps). Returns routes WITHOUT the direct edge (callers check
 * hasDirectRoute first), ranked by hops then combined popularity.
 */
export function findRoutes(
  from: FormatId,
  to: FormatId,
  maxHops = 3
): FormatRoute[] {
  if (from === to) return [];
  // BFS over formats, carrying the best (fewest-hop) path per format.
  interface State {
    format: FormatId;
    steps: RouteStep[];
  }
  const bestHops = new Map<FormatId, number>();
  const routes: FormatRoute[] = [];
  const queue: State[] = [{ format: from, steps: [] }];
  bestHops.set(from, 0);

  while (queue.length > 0) {
    const state = queue.shift() as State;
    const hops = state.steps.length;
    if (hops >= maxHops) continue;
    for (const e of EDGES) {
      if (e.from !== state.format) continue;
      const hopCount = hops + 1;
      const prev = bestHops.get(e.to);
      if (prev !== undefined && prev < hopCount) continue;
      if (hopCount > 1 && e.to === from) continue; // no pointless loops back
      const steps = [...state.steps, { toolId: e.toolId, from: e.from, to: e.to }];
      if (e.to === to) {
        if (!hasDirectRoute(from, to) || steps.length > 1) {
          // Only surface as a "route" when it adds value over the direct hop.
          if (steps.length > 1 || !hasDirectRoute(from, to)) {
            routes.push({
              steps,
              score: steps.reduce((s, st) => s + toolPopularity(st.toolId), 0),
            });
          }
        }
        continue;
      }
      if (prev === undefined || hopCount < prev) {
        bestHops.set(e.to, hopCount);
      }
      // Explore onward (allow equal-hop alternate paths for route variety,
      // bounded by maxHops so this terminates).
      if (hopCount < maxHops) {
        queue.push({ format: e.to, steps });
      }
    }
  }

  routes.sort((a, b) => a.steps.length - b.steps.length || b.score - a.score);
  // Deduplicate by tool-chain signature.
  const seen = new Set<string>();
  const unique: FormatRoute[] = [];
  for (const r of routes) {
    const key = r.steps.map((s) => s.toolId).join(">");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }
  return unique.slice(0, 3);
}

function toolPopularity(toolId: string): number {
  const tool = ALL_TOOLS.find((t) => t.id === toolId);
  return tool ? tool.popularity : 0;
}

/**
 * Parse a user query like "docx to png" / "epub → jpg" / "heic 2 pdf".
 * Returns { from, to } when both sides are known formats, else null.
 */
export function parseRouteQuery(query: string): { from: FormatId; to: FormatId } | null {
  const q = query.toLowerCase().trim();
  const m = q.match(/^([a-z0-9]+)\s*(?:to|→|->|2|=>)\s*([a-z0-9]+)$/);
  if (!m) return null;
  let from = normalizeFormat(m[1]);
  let to = normalizeFormat(m[2]);
  if (!KNOWN_FORMATS.includes(from) || !KNOWN_FORMATS.includes(to)) return null;
  if (from === to) return null;
  return { from, to };
}

const FORMAT_ALIASES: Record<string, FormatId> = {
  jpeg: "jpg",
  tif: "tiff",
  heif: "heic",
  md: "markdown",
  doc: "docx",
  xls: "xlsx",
  word: "docx",
  excel: "xlsx",
  powerpoint: "pptx",
  photo: "jpg",
  image: "jpg",
  picture: "jpg",
};

function normalizeFormat(raw: string): FormatId {
  return FORMAT_ALIASES[raw] ?? raw;
}

/** Human label for a route step ("Word to PDF" in the active locale). */
export function routeStepLabel(step: RouteStep, locale: Locale): string {
  const tool = ALL_TOOLS.find((t) => t.id === step.toolId);
  return tool ? tool.name[locale] : step.toolId;
}
