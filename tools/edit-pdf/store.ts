"use client";

/**
 * Edit PDF — editor store (zustand).
 *
 * One source of truth for the whole editor: the output page list, every
 * object, the current tool/zoom/page, selection and undo/redo. The surface
 * subscribes and mirrors the serializable part into the run options
 * ("e:<fileId>" blob — the make-fillable epoch-key pattern), so a file
 * replacement can never leak edits from another document.
 *
 * Snapshot discipline:
 *   • beginInteraction() before a drag/draw; live mutations then go through
 *     live* actions (the FIRST one lands the armed snapshot); endInteraction()
 *     cleans up. A click that changes nothing never touches the stacks.
 *   • One-shot actions (add / delete / property edit / page op) commit
 *     directly.
 */

import { create } from "zustand";

import {
  addBlankPage,
  applyResize,
  deletePage,
  duplicatePage,
  EditorHistory,
  initialPages,
  movePage,
  newEdId,
  translateObj,
  type EdMarkKind,
  type EdObj,
  type EdPage,
  type EdShapeKind,
  type EdTool,
  type EdWire,
  type PageViewLite,
  type ResizeHandle,
  rotatePageRight,
  roundPt,
  resizeBox,
} from "./model";

export interface EditorStore {
  // --- document -----------------------------------------------------------
  pages: EdPage[];
  objects: EdObj[];
  /** Crop-box views of the ORIGINAL file's pages (empty until loaded). */
  views: PageViewLite[];
  /** Set once the file's page count is known. */
  ready: boolean;

  // --- interaction state --------------------------------------------------
  tool: EdTool;
  shapeKind: EdShapeKind;
  penColor: string;
  penWidth: number;
  /** Active text-markup kind while the highlight tool is on. */
  markKind: EdMarkKind;
  markColor: string;
  zoom: number;
  current: number;
  selection: string[];
  /** Text object currently in contentEditable mode. */
  editingId: string | null;
  /** Note object whose inline popup editor is open. */
  noteEditingId: string | null;

  // --- history ------------------------------------------------------------
  canUndo: boolean;
  canRedo: boolean;

  // --- lifecycle ----------------------------------------------------------
  initDocument(views: PageViewLite[]): void;
  reset(): void;

  setTool(tool: EdTool): void;
  setShapeKind(kind: EdShapeKind): void;
  setPenColor(color: string): void;
  setPenWidth(width: number): void;
  setMarkKind(kind: EdMarkKind): void;
  setMarkColor(color: string): void;
  setZoom(zoom: number): void;
  setCurrent(page: number): void;
  setSelection(ids: string[]): void;
  setEditingId(id: string | null): void;
  setNoteEditingId(id: string | null);

  // --- object actions -----------------------------------------------------
  addObject(obj: EdObj): void;
  /** Batch add with ONE history entry (edit-text whiteout+text pair). */
  addObjects(objs: EdObj[]): void;
  /** Property-panel edit (one-shot history entry). */
  updateObject(id: string, patch: Partial<EdObj>): void;
  /** Replace/patch several objects at once (multi-select ops). */
  updateObjects(patches: { id: string; patch: Partial<EdObj> }[]): void;
  removeObjects(ids: string[]): void;
  duplicateObjects(ids: string[]): string[];
  nudgeSelection(dx: number, dy: number): void;
  bringToFront(ids: string[]): void;
  sendToBack(ids: string[]): void;

  // --- live interaction (drag / draw / resize) ---------------------------
  beginInteraction(): void;
  endInteraction(): void;
  cancelInteraction(): void;
  liveAddObject(obj: EdObj): void;
  liveUpdateObjects(next: EdObj[]): void;
  liveRemoveObjects(ids: string[]): void;

  // --- page operations ---------------------------------------------------
  pageRotateRight(index: number): void;
  pageDelete(index: number): void;
  pageDuplicate(index: number): void;
  pageAddBlank(index: number): void;
  pageMove(from: number, to: number): void;

  // --- history -----------------------------------------------------------
  undo(): void;
  redo(): void;

  // --- wire ---------------------------------------------------------------
  toWire(assets: Record<string, number>): EdWire;
}

const history = new EditorHistory(100);

function clampPage(n: number, pages: number): number {
  if (pages === 0) return 0;
  return Math.min(Math.max(0, n), pages - 1);
}

function topmostAfter(
  objects: EdObj[],
  ids: string[],
  toFront: boolean
): EdObj[] {
  const idSet = new Set(ids);
  const moving = objects.filter((o) => idSet.has(o.id));
  const rest = objects.filter((o) => !idSet.has(o.id));
  return toFront ? [...rest, ...moving] : [...moving, ...rest];
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  pages: [],
  objects: [],
  views: [],
  ready: false,

  tool: "select",
  shapeKind: "rect",
  penColor: "#b91c1c",
  penWidth: 2,
  markKind: "highlight",
  markColor: "#fde047",
  zoom: 1,
  current: 0,
  selection: [],
  editingId: null,
  noteEditingId: null,

  canUndo: false,
  canRedo: false,

  initDocument(views) {
    history.clear();
    set({
      views,
      pages: initialPages(views.length),
      objects: [],
      ready: true,
      current: 0,
      selection: [],
      editingId: null,
      noteEditingId: null,
      tool: "select",
      canUndo: false,
      canRedo: false,
    });
  },

  reset() {
    history.clear();
    set({
      pages: [],
      objects: [],
      views: [],
      ready: false,
      current: 0,
      selection: [],
      editingId: null,
      noteEditingId: null,
      tool: "select",
      canUndo: false,
      canRedo: false,
    });
  },

  setTool(tool) {
    set({ tool, editingId: null });
  },
  setShapeKind(shapeKind) {
    set({ shapeKind });
  },
  setPenColor(penColor) {
    set({ penColor });
  },
  setPenWidth(penWidth) {
    set({ penWidth });
  },
  setMarkKind(markKind) {
    set({ markKind });
  },
  setMarkColor(markColor) {
    set({ markColor });
  },
  setZoom(zoom) {
    set({ zoom: Math.min(4, Math.max(0.25, zoom)) });
  },
  setCurrent(page) {
    set({ current: clampPage(page, get().pages.length), editingId: null });
  },
  setSelection(selection) {
    set({ selection });
  },
  setEditingId(editingId) {
    set({ editingId });
  },
  setNoteEditingId(noteEditingId) {
    set({ noteEditingId });
  },

  addObject(obj) {
    const { pages, objects } = get();
    const next = [...objects, obj];
    history.commit({ pages, objects }, { pages, objects: next });
    set({
      objects: next,
      selection: [obj.id],
      canUndo: history.canUndo,
      canRedo: history.canRedo,
    });
  },

  addObjects(objs) {
    if (objs.length === 0) return;
    const { pages, objects } = get();
    const next = [...objects, ...objs];
    history.commit({ pages, objects }, { pages, objects: next });
    set({
      objects: next,
      selection: [objs[objs.length - 1].id],
      canUndo: history.canUndo,
      canRedo: history.canRedo,
    });
  },

  updateObject(id, patch) {
    const { pages, objects } = get();
    const next = objects.map((o) =>
      o.id === id ? ({ ...o, ...patch } as EdObj) : o
    );
    history.commit({ pages, objects }, { pages, objects: next });
    set({ objects: next, canUndo: history.canUndo, canRedo: history.canRedo });
  },

  updateObjects(patches) {
    if (patches.length === 0) return;
    const { pages, objects } = get();
    const byId = new Map(patches.map((p) => [p.id, p.patch]));
    const next = objects.map((o) =>
      byId.has(o.id) ? ({ ...o, ...byId.get(o.id) } as EdObj) : o
    );
    history.commit({ pages, objects }, { pages, objects: next });
    set({ objects: next, canUndo: history.canUndo, canRedo: history.canRedo });
  },

  removeObjects(ids) {
    if (ids.length === 0) return;
    const { pages, objects, selection } = get();
    const idSet = new Set(ids);
    const next = objects.filter((o) => !idSet.has(o.id));
    history.commit({ pages, objects }, { pages, objects: next });
    set({
      objects: next,
      selection: selection.filter((id) => !idSet.has(id)),
      editingId: null,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
    });
  },

  duplicateObjects(ids) {
    if (ids.length === 0) return [];
    const { pages, objects } = get();
    const idSet = new Set(ids);
    const copies: EdObj[] = [];
    const next = [...objects];
    for (const obj of objects) {
      if (!idSet.has(obj.id)) continue;
      const copy = translateObj(
        { ...obj, id: newEdId() },
        16,
        16
      );
      copies.push(copy);
      next.push(copy);
    }
    history.commit({ pages, objects }, { pages, objects: next });
    set({
      objects: next,
      selection: copies.map((c) => c.id),
      canUndo: history.canUndo,
      canRedo: history.canRedo,
    });
    return copies.map((c) => c.id);
  },

  nudgeSelection(dx, dy) {
    const { selection, objects, pages } = get();
    if (selection.length === 0) return;
    const idSet = new Set(selection);
    const next = objects.map((o) =>
      idSet.has(o.id)
        ? translateObj(o, roundPt(o.x + dx) - o.x, roundPt(o.y + dy) - o.y)
        : o
    );
    history.commit({ pages, objects }, { pages, objects: next });
    set({ objects: next, canUndo: history.canUndo, canRedo: history.canRedo });
  },

  bringToFront(ids) {
    const { pages, objects } = get();
    const next = topmostAfter(objects, ids, true);
    history.commit({ pages, objects }, { pages, objects: next });
    set({ objects: next, canUndo: history.canUndo, canRedo: history.canRedo });
  },

  sendToBack(ids) {
    const { pages, objects } = get();
    const next = topmostAfter(objects, ids, false);
    history.commit({ pages, objects }, { pages, objects: next });
    set({ objects: next, canUndo: history.canUndo, canRedo: history.canRedo });
  },

  beginInteraction() {
    const { pages, objects } = get();
    history.beginInteraction({ pages, objects });
  },

  endInteraction() {
    history.cancelInteraction();
  },

  cancelInteraction() {
    history.cancelInteraction();
  },

  liveAddObject(obj) {
    const { pages, objects } = get();
    const next = [...objects, obj];
    history.liveCommit({ pages, objects: next });
    set({
      objects: next,
      selection: [obj.id],
      canUndo: history.canUndo,
      canRedo: history.canRedo,
    });
  },

  liveUpdateObjects(next) {
    const { pages, objects } = get();
    history.liveCommit({ pages, objects: next });
    set({ objects: next, canUndo: history.canUndo, canRedo: history.canRedo });
  },

  liveRemoveObjects(ids) {
    if (ids.length === 0) return;
    const { pages, objects, selection } = get();
    const idSet = new Set(ids);
    const next = objects.filter((o) => !idSet.has(o.id));
    history.liveCommit({ pages, objects: next });
    set({
      objects: next,
      selection: selection.filter((id) => !idSet.has(id)),
      canUndo: history.canUndo,
      canRedo: history.canRedo,
    });
  },

  pageRotateRight(index) {
    const state = get();
    const { pages, objects } = rotatePageRight(
      state.pages,
      state.objects,
      state.views,
      index
    );
    history.commit(
      { pages: state.pages, objects: state.objects },
      { pages, objects }
    );
    set({
      pages,
      objects,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
    });
  },

  pageDelete(index) {
    const state = get();
    const { pages, objects } = deletePage(
      state.pages,
      state.objects,
      index
    );
    if (pages === state.pages) return;
    history.commit(
      { pages: state.pages, objects: state.objects },
      { pages, objects }
    );
    set({
      pages,
      objects,
      current: clampPage(state.current, pages.length),
      selection: [],
      canUndo: history.canUndo,
      canRedo: history.canRedo,
    });
  },

  pageDuplicate(index) {
    const state = get();
    const { pages, objects } = duplicatePage(
      state.pages,
      state.objects,
      index
    );
    history.commit(
      { pages: state.pages, objects: state.objects },
      { pages, objects }
    );
    set({
      pages,
      objects,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
    });
  },

  pageAddBlank(index) {
    const state = get();
    const { pages, objects } = addBlankPage(
      state.pages,
      state.objects,
      index
    );
    history.commit(
      { pages: state.pages, objects: state.objects },
      { pages, objects }
    );
    set({
      pages,
      objects,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
    });
  },

  pageMove(from, to) {
    const state = get();
    const { pages, objects } = movePage(state.pages, state.objects, from, to);
    if (pages === state.pages) return;
    history.commit(
      { pages: state.pages, objects: state.objects },
      { pages, objects }
    );
    set({
      pages,
      objects,
      current: to,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
    });
  },

  undo() {
    const { pages, objects } = get();
    const restore = history.undo({ pages, objects });
    if (restore === null) return;
    set({
      pages: restore.pages,
      objects: restore.objects,
      current: clampPage(get().current, restore.pages.length),
      selection: [],
      editingId: null,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
    });
  },

  redo() {
    const { pages, objects } = get();
    const restore = history.redo({ pages, objects });
    if (restore === null) return;
    set({
      pages: restore.pages,
      objects: restore.objects,
      current: clampPage(get().current, restore.pages.length),
      selection: [],
      editingId: null,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
    });
  },

  toWire(assets) {
    const { pages, objects, views } = get();
    return { v: 1 as const, pages, objects, views, assets };
  },
}));

/**
 * Live-resize helper used by the canvas during a handle drag: produces the
 * next objects array for `liveUpdateObjects` (paths rescale their points).
 */
export function resizeSelectionLive(
  objects: EdObj[],
  id: string,
  handle: ResizeHandle,
  px: number,
  py: number,
  aspect: boolean
): EdObj[] {
  const target = objects.find((o) => o.id === id);
  if (!target) return objects;
  const next = applyResize(
    target,
    resizeBox(target, handle, px, py, aspect)
  );
  return objects.map((o) => (o.id === id ? next : o));
}
