import { useSyncExternalStore } from "react";

import { ALL_TOOLS, CATEGORIES, getTool } from "@/lib/tools/registry";
import type { ToolDef } from "@/lib/tools/registry";
import type { ToolCategoryId } from "@/lib/tools/registry";
import { TOOL_CONFIGS } from "@/lib/tools/configs";
import type { ToolConfig, OptionValues } from "@/lib/tools/config-types";
import { defaultOptionValues } from "@/lib/tools/config-types";
import { createLocalSnapshot } from "@/lib/storage/local-snapshot";

/**
 * Workflow Builder core (PHASE-6) — pure, testable, node-safe logic:
 * types, the auto-built tool library, pipeline validation, presets and
 * localStorage persistence. Worker orchestration lives in runner.ts
 * (client-only, imports the toolRunner pool); the surface imports both.
 *
 * Library rule: a tool is chainable when it is enabled, runnable
 * (createWorker), PDF-in → PDF-out (accepts pdf/any + outputKind pdf)
 * and NOT one of the excluded ids below (page-grid family needs
 * workspace file ids inside its options; the builder itself can't be
 * a step).
 */

export const WORKFLOW_VERSION = 1;
export const MAX_STEPS = 12;
export const MAX_SAVED = 30;
const WORKFLOWS_KEY = "docopdf-workflows";
const CHANGE_EVENT = "docopdf:workflows-change";

/** Page-grid family: options embed per-workspace-file grids (fileIds)
 *  that a workflow step cannot produce — excluded from the library. */
const WORKFLOW_EXCLUDED = new Set([
  "workflow-builder",
  "multi-tool-pdf",
  "rotate-pdf-pages",
  "rearrange-pdf-pages",
  "remove-pdf-pages",
  "extract-pdf-pages",
]);

export interface WorkflowStep {
  /** Unique inside a workflow doc ("s1", "s2"…). */
  id: string;
  toolId: string;
  options: OptionValues;
}

export interface WorkflowDoc {
  version: number;
  id: string;
  name: string;
  steps: WorkflowStep[];
  createdAt: string;
  updatedAt: string;
}

export interface LibraryTool {
  tool: ToolDef;
  config: ToolConfig;
}

/** Auto-built from the live registry — the "node library". */
export function buildWorkflowLibrary(): LibraryTool[] {
  const out: LibraryTool[] = [];
  for (const tool of ALL_TOOLS) {
    if (!tool.enabled) continue;
    if (WORKFLOW_EXCLUDED.has(tool.id)) continue;
    if (tool.accepts !== "pdf" && tool.accepts !== "any") continue;
    const config = TOOL_CONFIGS[tool.id];
    if (!config) continue;
    if (!config.createWorker) continue; // viewer tools
    if (config.viewerOnly || config.noFile) continue;
    if (config.outputKind !== "pdf") continue; // chain safety
    out.push({ tool, config });
  }
  return out.sort((a, b) => b.tool.popularity - a.tool.popularity);
}

export function groupLibraryByCategory(
  library: LibraryTool[]
): { category: ToolCategoryId; label: string; tools: LibraryTool[] }[] {
  const groups = new Map<ToolCategoryId, LibraryTool[]>();
  for (const item of library) {
    const list = groups.get(item.tool.category) ?? [];
    list.push(item);
    groups.set(item.tool.category, list);
  }
  // Registry category order, then popularity (already sorted above).
  return CATEGORIES.map((category) => ({
    category: category.id,
    label: category.name.en,
    tools: groups.get(category.id) ?? [],
  })).filter((group) => group.tools.length > 0);
}

/* ------------------------------------------------------------------ */
/* Steps + docs                                                        */
/* ------------------------------------------------------------------ */

let stepCounter = 0;

export function newStepId(): string {
  stepCounter += 1;
  return `s${stepCounter}-${Date.now().toString(36)}${Math.floor(
    Math.random() * 1e4
  ).toString(36)}`;
}

export function makeStep(toolId: string): WorkflowStep {
  const config = TOOL_CONFIGS[toolId];
  const options = config ? defaultOptionValues(config.options) : {};
  return { id: newStepId(), toolId, options };
}

export function makeWorkflow(name = "", steps: WorkflowStep[] = []): WorkflowDoc {
  const now = new Date().toISOString();
  return {
    version: WORKFLOW_VERSION,
    id: `wf-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    name,
    steps,
    createdAt: now,
    updatedAt: now,
  };
}

function isOptionValue(value: unknown): value is string | number | boolean {
  const t = typeof value;
  return t === "string" || t === "number" || t === "boolean";
}

/** Strict shape check for anything coming from storage or an import. */
export function validateWorkflowDoc(
  input: unknown,
  library: LibraryTool[]
): WorkflowDoc | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;
  if (raw.version !== WORKFLOW_VERSION) return null;
  if (typeof raw.id !== "string" || raw.id.length === 0 || raw.id.length > 64)
    return null;
  if (typeof raw.name !== "string" || raw.name.length > 80) return null;
  if (!Array.isArray(raw.steps) || raw.steps.length > MAX_STEPS) return null;
  const byId = new Map(library.map((item) => [item.tool.id, item]));
  const steps: WorkflowStep[] = [];
  for (const entry of raw.steps) {
    if (typeof entry !== "object" || entry === null) return null;
    const step = entry as Record<string, unknown>;
    if (typeof step.id !== "string" || step.id.length === 0) return null;
    if (typeof step.toolId !== "string") return null;
    const item = byId.get(step.toolId);
    if (!item) return null; // unknown / not chainable tool
    const values: Record<string, unknown> =
      typeof step.options === "object" && step.options !== null
        ? (step.options as Record<string, unknown>)
        : {};
    // Keep only values the schema still knows (drops stale ids safely)
    // and only JSON-safe scalars.
    const options: OptionValues = {};
    for (const field of item.config.options) {
      const value = values[field.id];
      if (isOptionValue(value)) options[field.id] = value;
    }
    steps.push({ id: step.id, toolId: step.toolId, options });
  }
  const now = new Date().toISOString();
  const created = typeof raw.createdAt === "string" ? raw.createdAt : now;
  const updated = typeof raw.updatedAt === "string" ? raw.updatedAt : now;
  return {
    version: WORKFLOW_VERSION,
    id: raw.id,
    name: raw.name,
    steps,
    createdAt: created,
    updatedAt: updated,
  };
}

/* ------------------------------------------------------------------ */
/* Presets (starter recipes)                                           */
/* ------------------------------------------------------------------ */

export interface WorkflowPreset {
  key: string;
  toolIds: string[];
  /** Option overrides on top of each tool's defaults. */
  overrides?: Record<string, OptionValues>;
}

export const WORKFLOW_PRESETS: WorkflowPreset[] = [
  {
    // Acceptance pipeline: compress → watermark → page numbers.
    key: "emailReady",
    toolIds: ["compress-pdf", "add-watermark", "add-page-numbers"],
    overrides: {
      "compress-pdf": { preset: "recommended" },
    },
  },
  {
    key: "scanClean",
    toolIds: ["pdf-to-greyscale", "scanner-effect", "compress-pdf"],
  },
  {
    key: "archivePrep",
    toolIds: ["add-page-numbers", "change-pdf-doc-info", "compress-pdf"],
  },
];

export function presetToDoc(preset: WorkflowPreset): WorkflowDoc {
  const doc = makeWorkflow("", preset.toolIds.map((id) => makeStep(id)));
  if (preset.overrides) {
    for (const step of doc.steps) {
      const override = preset.overrides[step.toolId];
      if (override) step.options = { ...step.options, ...override };
    }
  }
  return doc;
}

/* ------------------------------------------------------------------ */
/* localStorage persistence (favorites.ts pattern)                     */
/* ------------------------------------------------------------------ */

const EMPTY_DOCS: WorkflowDoc[] = [];

function parseDocs(raw: string): WorkflowDoc[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY_DOCS;
    const library = buildWorkflowLibrary();
    const docs: WorkflowDoc[] = [];
    for (const entry of parsed.slice(0, MAX_SAVED)) {
      const doc = validateWorkflowDoc(entry, library);
      if (doc) docs.push(doc);
    }
    return docs;
  } catch {
    return EMPTY_DOCS;
  }
}

function readDocs(): WorkflowDoc[] {
  try {
    const raw = window.localStorage.getItem(WORKFLOWS_KEY);
    return raw === null ? EMPTY_DOCS : parseDocs(raw);
  } catch {
    return EMPTY_DOCS;
  }
}

function writeDocs(docs: WorkflowDoc[]): void {
  try {
    window.localStorage.setItem(WORKFLOWS_KEY, JSON.stringify(docs));
  } catch {
    /* storage unavailable — this tab keeps its in-memory copy */
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  window.addEventListener(CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(CHANGE_EVENT, callback);
  };
}

const savedSnapshot = createLocalSnapshot(WORKFLOWS_KEY, parseDocs, EMPTY_DOCS);

export function useSavedWorkflows(): WorkflowDoc[] {
  return useSyncExternalStore(
    subscribe,
    savedSnapshot,
    () => EMPTY_DOCS
  );
}

/** Insert or update (by doc.id), newest first, capped at MAX_SAVED. */
export function saveWorkflow(doc: WorkflowDoc): void {
  const stamped: WorkflowDoc = { ...doc, updatedAt: new Date().toISOString() };
  const rest = readDocs().filter((item) => item.id !== stamped.id);
  writeDocs([stamped, ...rest].slice(0, MAX_SAVED));
}

export function deleteWorkflow(id: string): void {
  writeDocs(readDocs().filter((item) => item.id !== id));
}

/* ------------------------------------------------------------------ */
/* Export / import helpers                                             */
/* ------------------------------------------------------------------ */

export function workflowToJson(doc: WorkflowDoc): string {
  return JSON.stringify(doc, null, 2);
}

export function workflowFileName(doc: WorkflowDoc): string {
  const base =
    doc.name.trim().length > 0
      ? doc.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
      : "workflow";
  return `${base || "workflow"}.docopdf-workflow.json`;
}

/** Parse a JSON export (file text) — invalid shape returns null. */
export function parseWorkflowExport(
  text: string,
  library: LibraryTool[]
): WorkflowDoc | null {
  try {
    return validateWorkflowDoc(JSON.parse(text), library);
  } catch {
    return null;
  }
}

/** The tool name for a step, locale-aware, registry-backed. */
export function stepToolDef(toolId: string): ToolDef | undefined {
  return getTool(toolId);
}
