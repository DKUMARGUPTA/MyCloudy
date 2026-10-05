"use client";

import { useCallback, useReducer } from "react";

import type { GridPage } from "./model";

/**
 * Undo/redo for the PageGrid (PRD §8.1 "undo/redo", common actions).
 *
 * Snapshot stack of GridPage[] states — each entry is a tiny array of
 * small objects, so 100 snapshots of a 500-page grid stay well under a
 * few MB. A pure reducer owns the transitions (StrictMode-safe); the
 * wrappers also compute the next state through the SAME reducer so
 * callers can serialize the result for the tool options immediately.
 */

const MAX_HISTORY = 100;

interface HistoryState {
  past: GridPage[][];
  pages: GridPage[];
  future: GridPage[][];
}

type Action =
  | { type: "commit"; pages: GridPage[] }
  | { type: "reset"; pages: GridPage[] }
  | { type: "undo" }
  | { type: "redo" };

function reducer(state: HistoryState, action: Action): HistoryState {
  switch (action.type) {
    case "commit":
      return {
        past: [...state.past.slice(-(MAX_HISTORY - 1)), state.pages],
        pages: action.pages,
        future: [],
      };
    case "reset":
      return { past: [], pages: action.pages, future: [] };
    case "undo": {
      if (state.past.length === 0) return state;
      const past = [...state.past];
      const pages = past.pop() as GridPage[];
      return {
        past,
        pages,
        future: [state.pages, ...state.future].slice(0, MAX_HISTORY),
      };
    }
    case "redo": {
      if (state.future.length === 0) return state;
      const [pages, ...future] = state.future;
      return {
        past: [...state.past.slice(-(MAX_HISTORY - 1)), state.pages],
        pages,
        future,
      };
    }
  }
}

export interface GridHistory {
  pages: GridPage[];
  canUndo: boolean;
  canRedo: boolean;
  /** Applies the next grid state and clears the redo stack. */
  commit: (next: GridPage[]) => void;
  /** Replaces everything (file changed / reloaded). */
  reset: (next: GridPage[]) => void;
  /** Dispatches undo and returns the restored pages (null = nothing to undo). */
  undo: () => GridPage[] | null;
  /** Dispatches redo and returns the redone pages (null = nothing to redo). */
  redo: () => GridPage[] | null;
}

export function useGridHistory(initial: GridPage[]): GridHistory {
  const [state, dispatch] = useReducer(reducer, {
    past: [],
    pages: initial,
    future: [],
  });

  const commit = useCallback((next: GridPage[]) => {
    dispatch({ type: "commit", pages: next });
  }, []);

  const reset = useCallback((next: GridPage[]) => {
    dispatch({ type: "reset", pages: next });
  }, []);

  const undo = useCallback((): GridPage[] | null => {
    if (state.past.length === 0) return null;
    const next = reducer(state, { type: "undo" });
    dispatch({ type: "undo" });
    return next.pages;
  }, [state]);

  const redo = useCallback((): GridPage[] | null => {
    if (state.future.length === 0) return null;
    const next = reducer(state, { type: "redo" });
    dispatch({ type: "redo" });
    return next.pages;
  }, [state]);

  return {
    pages: state.pages,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    commit,
    reset,
    undo,
    redo,
  };
}
