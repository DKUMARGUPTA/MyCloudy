"use client";

import { useSyncExternalStore } from "react";

import { ALL_TOOLS, getTool } from "@/lib/tools/registry";
import type { ToolDef } from "@/lib/tools/registry";
import { createLocalSnapshot } from "@/lib/storage/local-snapshot";

/**
 * Favorites + last-used tools, persisted in localStorage (device-only,
 * PRD §6.2). External-store pattern via useSyncExternalStore keeps this
 * hydration-safe with no setState-in-effect.
 *
 * `lastUsed` is written when a tool RUNS (Phase 2 ToolShell); it stays
 * empty until then, so the "Last used" chip is hidden on fresh installs —
 * exactly the PRD behavior ("pehli visit par hidden").
 */

const FAVORITES_KEY = "docopdf-favorites";
const LAST_USED_KEY = "docopdf-last-used";
const CHANGE_EVENT = "docopdf:favorites-change";

const MAX_LAST_USED = 8;

const EMPTY_LIST: string[] = [];

function parseList(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY_LIST;
    const filtered = parsed.filter(
      (item): item is string => typeof item === "string"
    );
    return filtered.length > 0 ? filtered : EMPTY_LIST;
  } catch {
    return EMPTY_LIST;
  }
}

function readList(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? EMPTY_LIST : parseList(raw);
  } catch {
    return EMPTY_LIST;
  }
}

function writeList(key: string, value: string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable — changes live only in this tab's listeners */
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

/* Stable snapshots: same reference until the raw storage string changes. */
const favoritesSnapshot = createLocalSnapshot(
  FAVORITES_KEY,
  parseList,
  EMPTY_LIST
);
const lastUsedSnapshot = createLocalSnapshot(
  LAST_USED_KEY,
  parseList,
  EMPTY_LIST
);

export function useFavoriteIds(): string[] {
  return useSyncExternalStore(
    subscribe,
    favoritesSnapshot,
    () => EMPTY_LIST
  );
}

export function useLastUsedIds(): string[] {
  return useSyncExternalStore(
    subscribe,
    lastUsedSnapshot,
    () => EMPTY_LIST
  );
}

export function isFavorite(ids: string[], toolId: string): boolean {
  return ids.includes(toolId);
}

export function toggleFavorite(toolId: string): void {
  const current = readList(FAVORITES_KEY);
  const next = current.includes(toolId)
    ? current.filter((id) => id !== toolId)
    : [...current, toolId];
  writeList(FAVORITES_KEY, next);
}

/** Records a tool run; called by the ToolShell when processing starts. */
export function trackToolUse(toolId: string): void {
  const current = readList(LAST_USED_KEY).filter((id) => id !== toolId);
  const next = [toolId, ...current].slice(0, MAX_LAST_USED);
  writeList(LAST_USED_KEY, next);
}

function resolveTools(ids: string[]): ToolDef[] {
  return ids
    .map((id) => getTool(id))
    .filter((tool): tool is ToolDef => tool !== undefined);
}

/** Favorite tools, registry-ordered by popularity. */
export function useFavoriteTools(): ToolDef[] {
  const ids = useFavoriteIds();
  const tools = resolveTools(ids);
  return tools.sort((a, b) => b.popularity - a.popularity);
}

/** Recently used tools, most recent first. */
export function useLastUsedTools(): ToolDef[] {
  return resolveTools(useLastUsedIds());
}

/** Guard used by views that must not crash on storage failures. */
export function anyEnabledTools(): boolean {
  return ALL_TOOLS.some((tool) => tool.enabled);
}
