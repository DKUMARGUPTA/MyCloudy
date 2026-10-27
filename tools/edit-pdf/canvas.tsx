"use client";

/**
 * Edit PDF — the page canvas (PRD §8.2.1 editor, center pane).
 *
 * Renders the current page (pdf.js bitmap → <canvas>) with an
 * absolutely-positioned object overlay on top. ALL pointer handling lives
 * on the overlay layer (objects render with pointer-events: none), so
 * z-order hit-testing, multi-select marquee and handle drags go through
 * one coordinate pipeline: client px → page display points (÷ zoom).
 *
 * Text objects edit in place with a <textarea> styled like the export
 * font (see fonts.ts WYSIWYG note); on blur the text is re-wrapped and
 * the measured lines are stored for the worker to mirror.
 *
 * Sub-phase 2 adds the annotation tools: highlight / underline / strike
 * drags intersect the page's real text lines (textLines prop → quads),
 * the note tool drops a sticky note with an inline popup editor, and the
 * link tool drags a link box whose target is set in the properties panel.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, MessageSquareText } from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import {
  applyResize,
  buildEditTextObjects,
  clampN,
  defaultShapeProps,
  defaultTextProps,
  eraseAt,
  handleAt,
  hasDevanagari,
  hitTestTop,
  linesToQuads,
  matchFont,
  newEdId,
  normalizeDrag,
  pathFromPoints,
  pointsBbox,
  quadsBbox,
  translateObj,
  type EdEditLine,
  type EdLinkObj,
  type EdMarkObj,
  type EdNoteObj,
  type EdObj,
  type EdTextLine,
  type EdTextObj,
  type ResizeHandle,
  resizeBox,
  roundPt,
  arrowHeadPoints,
  CHECK_FRACTIONS,
  CROSS_FRACTIONS,
} from "./model";
import { cssFont, fontFamilyStack, measureAscent, measureText, rewrapText } from "./fonts";
import { useAssetUrl } from "./assets";
import { useEditorStore } from "./store";

export interface CanvasProps {
  bitmap: ImageBitmap | null;
  dispW: number;
  dispH: number;
  blank: boolean;
  loading: boolean;
  /** Real text lines of the current page (empty for blank pages). */
  textLines: EdTextLine[];
  /** Visual edit lines of the current page (sub-phase 3 click targets). */
  editLines: EdEditLine[];
}

type Drag =
  | { kind: "move"; ids: string[]; origs: EdObj[]; grabX: number; grabY: number; moved: boolean }
  | { kind: "resize"; id: string; handle: ResizeHandle; orig: EdObj; aspectLock: boolean }
  | { kind: "marquee"; x0: number; y0: number; x1: number; y1: number; add: boolean }
  | { kind: "box"; x0: number; y0: number; x1: number; y1: number; color: string | null }
  | { kind: "draw"; pts: number[] }
  | { kind: "marksel"; x0: number; y0: number; x1: number; y1: number };

const MIN_CREATE_PT = 6;
const HANDLE_SIZE = 11;
/** Fixed display footprint of the sticky-note icon (pt). */
const NOTE_SIZE = 24;

export function EditorCanvas(props: CanvasProps): React.JSX.Element | null {
  const { bitmap, dispW, dispH, blank, loading, textLines, editLines } = props;
  const { t } = useI18n();
  const { toast } = useToast();

  const tool = useEditorStore((s) => s.tool);
  const zoom = useEditorStore((s) => s.zoom);
  const objects = useEditorStore((s) => s.objects);
  const selection = useEditorStore((s) => s.selection);
  const current = useEditorStore((s) => s.current);
  const shapeKind = useEditorStore((s) => s.shapeKind);
  const penColor = useEditorStore((s) => s.penColor);
  const penWidth = useEditorStore((s) => s.penWidth);
  const editingId = useEditorStore((s) => s.editingId);
  const markKind = useEditorStore((s) => s.markKind);
  const markColor = useEditorStore((s) => s.markColor);
  const noteEditingId = useEditorStore((s) => s.noteEditingId);

  const store = useEditorStore;

  const pageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [dragTick, setDragTick] = useState(0);
  const [draft, setDraft] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const [hoverEdit, setHoverEdit] = useState(-1);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const noteAreaRef = useRef<HTMLTextAreaElement | null>(null);

  const pageObjects = useMemo(
    () => objects.filter((o) => o.page === current),
    [objects, current]
  );
  const selectionSet = useMemo(() => new Set(selection), [selection]);

  // --- coordinate helpers -------------------------------------------------

  const pagePos = useCallback(
    (event: { clientX: number; clientY: number }): { x: number; y: number } => {
      const box = pageRef.current?.getBoundingClientRect();
      if (!box) return { x: 0, y: 0 };
      return {
        x: (event.clientX - box.left) / zoom,
        y: (event.clientY - box.top) / zoom,
      };
    },
    [zoom]
  );

  /** Page pixel color under a display point (whiteout eyedropper). */
  const sampleColor = useCallback(
    (px: number, py: number): string => {
      const canvas = canvasRef.current;
      if (!canvas || dispW <= 0) return "#ffffff";
      const ctx = canvas.getContext("2d");
      if (!ctx) return "#ffffff";
      const cx = clampN(Math.round((px / dispW) * canvas.width), 1, canvas.width - 2);
      const cy = clampN(Math.round((py / dispH) * canvas.height), 1, canvas.height - 2);
      try {
        const data = ctx.getImageData(cx - 1, cy - 1, 3, 3).data;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let i = 0; i < data.length; i += 4) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
        }
        const n = data.length / 4;
        const to2 = (v: number) =>
          Math.round(v / n)
            .toString(16)
            .padStart(2, "0");
        return `#${to2(r)}${to2(g)}${to2(b)}`;
      } catch {
        return "#ffffff";
      }
    },
    [dispW, dispH]
  );

  // --- edit-existing-text (sub-phase 3) -----------------------------------

  /** Topmost edit line under a display point (±2pt grab room), or -1. */
  const hitEditLine = useCallback(
    (px: number, py: number): number => {
      for (let i = editLines.length - 1; i >= 0; i -= 1) {
        const l = editLines[i];
        if (
          px >= l.x - 2 &&
          px <= l.x + l.w + 2 &&
          py >= l.y - 2 &&
          py <= l.y + l.h + 2
        ) {
          return i;
        }
      }
      return -1;
    },
    [editLines]
  );

  /**
   * Sample the line's own pixels: the MODE color is the background
   * (whiteout fill), the bucket FURTHEST from it is the ink (text color).
   * Works for dark-on-light AND light-on-dark pages; falls back to a
   * high-contrast pair when the box is uniform.
   */
  const sampleLineColors = useCallback(
    (line: EdEditLine): { bg: string; text: string } => {
      const fallback = { bg: "#ffffff", text: "#000000" };
      const canvas = canvasRef.current;
      if (!canvas || dispW <= 0 || dispH <= 0) return fallback;
      const ctx = canvas.getContext("2d");
      if (!ctx) return fallback;
      const sx = clampN(Math.round((line.x / dispW) * canvas.width), 0, Math.max(0, canvas.width - 1));
      const sy = clampN(Math.round((line.y / dispH) * canvas.height), 0, Math.max(0, canvas.height - 1));
      const sw = clampN(Math.round((line.w / dispW) * canvas.width), 1, canvas.width - sx);
      const sh = clampN(Math.round((line.h / dispH) * canvas.height), 1, canvas.height - sy);
      try {
        const data = ctx.getImageData(sx, sy, sw, sh).data;
        // 4-bit-per-channel buckets (16³) — antialiasing blends stay near
        // their glyph core, so the far bucket is the ink color.
        const buckets = new Map<
          number,
          { n: number; r: number; g: number; b: number }
        >();
        let total = 0;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
          const bucket = buckets.get(key);
          if (bucket === undefined) {
            buckets.set(key, { n: 1, r, g, b });
          } else {
            bucket.n += 1;
            bucket.r += r;
            bucket.g += g;
            bucket.b += b;
          }
          total += 1;
        }
        if (total === 0) return fallback;
        let bg = { n: 0, r: 0, g: 0, b: 0 };
        for (const bucket of buckets.values()) {
          if (bucket.n > bg.n) bg = bucket;
        }
        const bgR = bg.r / bg.n;
        const bgG = bg.g / bg.n;
        const bgB = bg.b / bg.n;
        let ink: { r: number; g: number; b: number; d: number } | null = null;
        for (const bucket of buckets.values()) {
          if (bucket.n < total * 0.01) continue; // ignore single stray px
          const r = bucket.r / bucket.n;
          const g = bucket.g / bucket.n;
          const b = bucket.b / bucket.n;
          const d =
            Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB);
          if (ink === null || d > ink.d) ink = { r, g, b, d };
        }
        const to2 = (v: number): string =>
          Math.round(clampN(v, 0, 255)).toString(16).padStart(2, "0");
        const bgHex = `#${to2(bgR)}${to2(bgG)}${to2(bgB)}`;
        if (ink === null || ink.d < 60) {
          // Uniform box — pick the readable default against the sampled bg.
          const lum = bgR * 0.299 + bgG * 0.587 + bgB * 0.114;
          return { bg: bgHex, text: lum > 140 ? "#000000" : "#ffffff" };
        }
        return { bg: bgHex, text: `#${to2(ink.r)}${to2(ink.g)}${to2(ink.b)}` };
      } catch {
        return fallback;
      }
    },
    [dispH, dispW]
  );

  /** Click on a text line → whiteout + matched text, straight into editing. */
  const editLineAt = useCallback(
    (line: EdEditLine) => {
      const match = matchFont(line, hasDevanagari(line.str));
      const colors = sampleLineColors(line);
      const ascent = measureAscent(
        match.family,
        line.size,
        match.bold,
        match.italic
      );
      const textW = measureText(
        line.str,
        cssFont(match.family, line.size, match.bold, match.italic)
      );
      const { whiteout, text: textObj } = buildEditTextObjects(
        line,
        match,
        {
          whiteoutColor: colors.bg,
          textColor: colors.text,
          ascent,
          textW,
        }
      );
      whiteout.page = current;
      textObj.page = current;
      store.getState().addObjects([whiteout, textObj]);
      store.getState().setTool("select");
      store.getState().setEditingId(textObj.id);
      setDraft(line.str);
      // PRD: the clear "font matched / closest" message at edit time.
      const familyLabel = t(`edit.family_${match.family}`);
      toast({
        title: match.exact
          ? t("edit.fontMatched", { name: match.origName })
          : t("edit.fontClosest", {
              family: familyLabel,
              name: match.origName,
            }),
      });
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.select();
      });
    },
    [current, sampleLineColors, t, toast]
  );

  // --- object creation ----------------------------------------------------

  const createTextAt = useCallback(
    (box: { x: number; y: number; w: number; h: number }) => {
      const obj: EdTextObj = {
        ...defaultTextProps(),
        id: newEdId(),
        page: current,
        x: roundPt(clampN(box.x, 0, Math.max(0, dispW - 40))),
        y: roundPt(clampN(box.y, 0, Math.max(0, dispH - 20))),
        w: roundPt(Math.max(box.w, 60)),
        h: roundPt(Math.max(box.h, 24)),
        opacity: 1,
        text: "",
        lines: [{ t: "", w: 0 }],
      };
      store.getState().addObject(obj);
      store.getState().setTool("select");
      store.getState().setEditingId(obj.id);
      setDraft("");
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.select();
      });
    },
    [current, dispH, dispW]
  );

  const commitDraft = useCallback(() => {
    const id = editingId;
    if (id === null) return;
    const obj = store
      .getState()
      .objects.find((o) => o.id === id);
    if (!obj || obj.kind !== "text") {
      store.getState().setEditingId(null);
      setDraft(null);
      return;
    }
    const text = (draft ?? "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n");
    if (text.trim() === "") {
      store.getState().setEditingId(null);
      setDraft(null);
      // An emptied edit also removes its covering whiteout — an empty
      // white patch over the original line would look like a bug.
      const pairId = obj.pairId;
      store.getState().removeObjects(
        pairId !== undefined ? [id, pairId] : [id]
      );
      return;
    }
    store.getState().updateObject(id, rewrapText({ ...obj, text }));
    store.getState().setEditingId(null);
    setDraft(null);
  }, [draft, editingId]);

  const commitNote = useCallback(() => {
    const id = noteEditingId;
    if (id === null) return;
    const obj = store.getState().objects.find((o) => o.id === id);
    if (obj && obj.kind === "note") {
      const text = (noteDraft ?? "").replace(/\r\n/g, "\n").slice(0, 5000);
      if (text !== obj.text) {
        store.getState().updateObject(id, { text });
      }
    }
    store.getState().setNoteEditingId(null);
    setNoteDraft(null);
  }, [noteDraft, noteEditingId]);

  const openNoteEditor = useCallback(
    (id: string) => {
      const obj = store.getState().objects.find((o) => o.id === id);
      if (!obj || obj.kind !== "note") return;
      store.getState().setSelection([id]);
      store.getState().setNoteEditingId(id);
      setNoteDraft(obj.text);
      requestAnimationFrame(() => {
        noteAreaRef.current?.focus();
      });
    },
    []
  );

  // When the popup is opened from outside (properties panel), seed the
  // draft from the object so a commit can't wipe the existing text.
  useEffect(() => {
    if (noteEditingId === null) return;
    const obj = store.getState().objects.find((o) => o.id === noteEditingId);
    if (obj && obj.kind === "note") setNoteDraft(obj.text);
  }, [noteEditingId]);

  // --- pointer interactions ------------------------------------------------

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (editingId !== null) commitDraft();
      if (noteEditingId !== null) commitNote();
      if (event.button !== 0) return;
      const { x, y } = pagePos(event);
      const state = store.getState();
      const layer = pageRef.current;
      if (!layer) return;

      if (tool === "select") {
        // Handle of the single selected object?
        const selectedObj =
          selection.length === 1
            ? pageObjects.find((o) => o.id === selection[0])
            : undefined;
        if (selectedObj) {
          const handle = handleAt(selectedObj, x, y, zoom);
          if (handle) {
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              /* synthetic pointers */
            }
            state.beginInteraction();
            dragRef.current = {
              kind: "resize",
              id: selectedObj.id,
              handle,
              orig: selectedObj,
              aspectLock: selectedObj.kind === "image",
            };
            event.preventDefault();
            return;
          }
        }
        const hit = hitTestTop(pageObjects, x, y);
        if (hit) {
          const additive = event.shiftKey;
          if (additive) {
            const next = selection.includes(hit.id)
              ? selection.filter((id) => id !== hit.id)
              : [...selection, hit.id];
            state.setSelection(next);
            return;
          }
          if (!selection.includes(hit.id)) {
            state.setSelection([hit.id]);
          }
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            /* synthetic pointers */
          }
          state.beginInteraction();
          const ids = selection.includes(hit.id) ? selection : [hit.id];
          dragRef.current = {
            kind: "move",
            ids,
            origs: pageObjects.filter((o) => ids.includes(o.id)),
            grabX: x,
            grabY: y,
            moved: false,
          };
          event.preventDefault();
          return;
        }
        // Empty area — marquee (shift = additive).
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* synthetic pointers */
        }
        dragRef.current = {
          kind: "marquee",
          x0: x,
          y0: y,
          x1: x,
          y1: y,
          add: event.shiftKey,
        };
        if (!event.shiftKey) state.setSelection([]);
        setDragTick((n) => n + 1);
        event.preventDefault();
        return;
      }

      if (tool === "edittext") {
        const idx = hitEditLine(x, y);
        if (idx === -1) {
          state.setSelection([]);
          return;
        }
        editLineAt(editLines[idx]);
        event.preventDefault();
        return;
      }

      if (tool === "highlight" || tool === "link") {
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* synthetic pointers */
        }
        if (tool === "highlight") {
          dragRef.current = { kind: "marksel", x0: x, y0: y, x1: x, y1: y };
        } else {
          dragRef.current = { kind: "box", x0: x, y0: y, x1: x, y1: y, color: null };
        }
        setDragTick((n) => n + 1);
        event.preventDefault();
        return;
      }

      if (tool === "note") {
        // One click drops a note and opens its popup editor right there.
        const id = newEdId();
        const obj: EdNoteObj = {
          id,
          kind: "note",
          page: current,
          x: roundPt(clampN(x - NOTE_SIZE / 2, 0, Math.max(0, dispW - NOTE_SIZE))),
          y: roundPt(clampN(y - NOTE_SIZE / 2, 0, Math.max(0, dispH - NOTE_SIZE))),
          w: NOTE_SIZE,
          h: NOTE_SIZE,
          opacity: 1,
          color: "#f59e0b",
          text: "",
        };
        state.addObject(obj);
        state.setTool("select");
        openNoteEditor(id);
        event.preventDefault();
        return;
      }

      if (tool === "text") {
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* synthetic pointers */
        }
        dragRef.current = { kind: "box", x0: x, y0: y, x1: x, y1: y, color: null };
        setDragTick((n) => n + 1);
        event.preventDefault();
        return;
      }

      if (tool === "shape" || tool === "whiteout") {
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* synthetic pointers */
        }
        const color =
          tool === "whiteout" ? sampleColor(x, y) : null;
        dragRef.current = { kind: "box", x0: x, y0: y, x1: x, y1: y, color };
        setDragTick((n) => n + 1);
        event.preventDefault();
        return;
      }

      if (tool === "draw") {
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* synthetic pointers */
        }
        state.beginInteraction();
        dragRef.current = { kind: "draw", pts: [x, y] };
        setDragTick((n) => n + 1);
        event.preventDefault();
        return;
      }

      if (tool === "eraser") {
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* synthetic pointers */
        }
        state.beginInteraction();
        const hits = eraseAt(pageObjects, x, y).map((o) => o.id);
        if (hits.length > 0) state.liveRemoveObjects(hits);
        dragRef.current = { kind: "draw", pts: [x, y] };
        event.preventDefault();
      }
    },
    [
      commitDraft,
      commitNote,
      current,
      dispH,
      dispW,
      editLineAt,
      editLines,
      editingId,
      hitEditLine,
      noteEditingId,
      openNoteEditor,
      pageObjects,
      pagePos,
      sampleColor,
      selection,
      tool,
      zoom,
    ]
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const { x, y } = pagePos(event);
      if (tool === "edittext" && dragRef.current === null) {
        // Hover affordance: outline the editable line under the pointer.
        const idx = hitEditLine(x, y);
        if (idx !== hoverEdit) setHoverEdit(idx);
        return;
      }
      const drag = dragRef.current;
      if (!drag) return;
      const state = store.getState();
      switch (drag.kind) {
        case "move": {
          const dx = x - drag.grabX;
          const dy = y - drag.grabY;
          if (!drag.moved && Math.hypot(dx, dy) < 1.5) return;
          drag.moved = true;
          const next = state.objects.map((o) => {
            const orig = drag.origs.find((orig) => orig.id === o.id);
            if (!orig) return o;
            const nx = roundPt(
              clampN(orig.x + dx, -o.w + 10, Math.max(10, dispW - 10))
            );
            const ny = roundPt(
              clampN(orig.y + dy, -o.h + 10, Math.max(10, dispH - 10))
            );
            return translateObj(o, nx - orig.x, ny - orig.y);
          });
          state.liveUpdateObjects(next);
          return;
        }
        case "resize": {
          const aspect = drag.aspectLock !== event.shiftKey;
          const target = state.objects.find((o) => o.id === drag.id);
          if (!target) return;
          const nextObj = applyResize(
            target,
            resizeBox(drag.orig, drag.handle, x, y, aspect)
          );
          const next = state.objects.map((o) => (o.id === drag.id ? nextObj : o));
          state.liveUpdateObjects(next);
          return;
        }
        case "marquee":
        case "box":
        case "marksel": {
          drag.x1 = x;
          drag.y1 = y;
          setDragTick((n) => n + 1);
          return;
        }
        case "draw": {
          drag.pts.push(x, y);
          if (tool === "eraser") {
            const hits = eraseAt(
              state.objects.filter((o) => o.page === current),
              x,
              y
            ).map((o) => o.id);
            if (hits.length > 0) state.liveRemoveObjects(hits);
          }
          setDragTick((n) => n + 1);
          return;
        }
      }
    },
    [current, dispH, dispW, hitEditLine, hoverEdit, pagePos, tool]
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag) return;
      const state = store.getState();
      switch (drag.kind) {
        case "move": {
          state.endInteraction();
          return;
        }
        case "resize": {
          state.endInteraction();
          return;
        }
        case "marquee": {
          const box = normalizeDrag(drag.x0, drag.y0, drag.x1, drag.y1);
          if (box.w * box.h < 16) return;
          const base = drag.add ? new Set(selection) : new Set<string>();
          for (const obj of pageObjects) {
            const hit =
              obj.x < box.x + box.w &&
              obj.x + obj.w > box.x &&
              obj.y < box.y + box.h &&
              obj.y + obj.h > box.y;
            if (hit) base.add(obj.id);
          }
          state.setSelection([...base]);
          return;
        }
        case "marksel": {
          const box = normalizeDrag(drag.x0, drag.y0, drag.x1, drag.y1);
          const quads = linesToQuads(textLines, box);
          if (quads.length === 0) return; // nothing text-shaped under the drag
          const bbox = quadsBbox(quads);
          const obj: EdMarkObj = {
            id: newEdId(),
            kind: "mark",
            page: current,
            x: roundPt(bbox.x),
            y: roundPt(bbox.y),
            w: roundPt(bbox.w),
            h: roundPt(bbox.h),
            opacity: markKind === "highlight" ? 0.45 : 0.9,
            mark: markKind,
            color: markColor,
            quads: quads.map((n) => roundPt(n)),
          };
          state.addObject(obj);
          // Stay in the highlight tool — marking several passages in a row
          // is the normal flow.
          return;
        }
        case "box": {
          const box = normalizeDrag(drag.x0, drag.y0, drag.x1, drag.y1);
          if (tool === "text") {
            if (box.w >= MIN_CREATE_PT && box.h >= MIN_CREATE_PT) {
              createTextAt(box);
            } else {
              createTextAt({
                x: drag.x0,
                y: drag.y0,
                w: 220,
                h: Math.round(
                  defaultTextProps().size * defaultTextProps().lineGap * 1.6
                ),
              });
            }
            return;
          }
          if (tool === "shape") {
            if (box.w < 3 && box.h < 3) return;
            const props = defaultShapeProps(shapeKind);
            const id = newEdId();
            const forwardX = drag.x1 >= drag.x0;
            const forwardY = drag.y1 >= drag.y0;
            const obj: EdObj = {
              ...props,
              shape: shapeKind,
              id,
              page: current,
              x: roundPt(box.x),
              y: roundPt(box.y),
              w: roundPt(Math.max(box.w, 4)),
              h: roundPt(Math.max(box.h, 4)),
              opacity: 1,
              x1f: forwardX ? 0 : 1,
              y1f: forwardY ? 0 : 1,
              x2f: forwardX ? 1 : 0,
              y2f: forwardY ? 1 : 0,
            };
            state.addObject(obj);
            state.setTool("select");
            return;
          }
          if (tool === "link") {
            if (box.w < 4 && box.h < 4) return;
            const id = newEdId();
            const obj: EdLinkObj = {
              id,
              kind: "link",
              page: current,
              x: roundPt(box.x),
              y: roundPt(box.y),
              w: roundPt(Math.max(box.w, 12)),
              h: roundPt(Math.max(box.h, 12)),
              opacity: 1,
              linkType: "url",
              url: "",
              destPage: 0,
            };
            state.addObject(obj);
            state.setTool("select");
            return;
          }
          if (tool === "whiteout") {
            if (box.w < 3 && box.h < 3) return;
            const id = newEdId();
            const obj: EdObj = {
              id,
              page: current,
              x: roundPt(box.x),
              y: roundPt(box.y),
              w: roundPt(Math.max(box.w, 4)),
              h: roundPt(Math.max(box.h, 4)),
              opacity: 1,
              kind: "whiteout",
              color: drag.color ?? "#ffffff",
            };
            state.addObject(obj);
            return;
          }
          return;
        }
        case "draw": {
          if (tool === "eraser") {
            state.endInteraction();
            return;
          }
          const path = pathFromPoints(
            drag.pts,
            penColor,
            penWidth,
            1,
            current
          );
          if (path) state.liveAddObject(path);
          else state.endInteraction();
          return;
        }
      }
    },
    [
      createTextAt,
      current,
      markColor,
      markKind,
      pageObjects,
      pagePos,
      penColor,
      penWidth,
      selection,
      shapeKind,
      textLines,
      tool,
    ]
  );

  // --- wheel: ctrl/⌘ + wheel zooms (non-passive) ---------------------------

  useEffect(() => {
    const layer = pageRef.current;
    if (!layer) return;
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const state = store.getState();
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      state.setZoom(state.zoom * factor);
    };
    layer.addEventListener("wheel", onWheel, { passive: false });
    return () => layer.removeEventListener("wheel", onWheel);
  }, []);

  // --- keyboard -----------------------------------------------------------

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (editingId !== null) {
        if (event.key === "Escape") {
          commitDraft();
        }
        return;
      }
      if (noteEditingId !== null) return; // the popup textarea owns keys
      const target = event.target as HTMLElement | null;
      if (
        target !== null &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      const state = store.getState();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) state.redo();
        else state.undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        state.redo();
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (state.selection.length > 0) {
          event.preventDefault();
          state.removeObjects(state.selection);
        }
        return;
      }
      if (event.key === "Escape") {
        if (state.selection.length > 0) state.setSelection([]);
        else if (state.tool !== "select") state.setTool("select");
        return;
      }
      if (event.key.startsWith("Arrow") && state.selection.length > 0) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const dx =
          event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
        const dy =
          event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
        state.nudgeSelection(dx, dy);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        const page = state.objects.filter((o) => o.page === state.current);
        state.setSelection(page.map((o) => o.id));
        return;
      }
      if (event.ctrlKey || event.metaKey) return;
      const keyTool: Record<string, string> = {
        v: "select",
        t: "text",
        x: "edittext",
        s: "shape",
        d: "draw",
        e: "eraser",
        w: "whiteout",
        i: "image",
        h: "highlight",
        n: "note",
        l: "link",
      };
      const next = keyTool[event.key.toLowerCase()];
      if (next) state.setTool(next as never);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commitDraft, editingId, noteEditingId]);

  // --- derived render state -----------------------------------------------

  const drag = dragRef.current; // re-read each render (ticked by dragTick)
  void dragTick;
  const previewBox =
    drag && (drag.kind === "box" || drag.kind === "marquee" || drag.kind === "marksel")
      ? normalizeDrag(drag.x0, drag.y0, drag.x1, drag.y1)
      : null;
  const markPreviewQuads =
    drag && drag.kind === "marksel" && previewBox
      ? linesToQuads(textLines, previewBox)
      : null;
  const drawPreview =
    drag && drag.kind === "draw" && drag.pts.length >= 4
      ? pointsBbox(drag.pts)
      : null;

  const editingObj =
    editingId !== null
      ? (pageObjects.find((o) => o.id === editingId) as EdTextObj | undefined)
      : undefined;
  const noteEditingObj =
    noteEditingId !== null
      ? (pageObjects.find((o) => o.id === noteEditingId) as EdNoteObj | undefined)
      : undefined;

  const pageW = Math.round(dispW * zoom);
  const pageH = Math.round(dispH * zoom);

  const cursor =
    tool === "select"
      ? "default"
      : tool === "eraser"
        ? "cell"
        : tool === "text" || tool === "highlight" || tool === "edittext"
          ? "text"
          : "crosshair";

  const hoverLine =
    tool === "edittext" && hoverEdit >= 0 && hoverEdit < editLines.length
      ? editLines[hoverEdit]
      : null;

  // --- render ---------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex h-[420px] items-center justify-center rounded-card border border-border bg-card">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="sr-only">{t("edit.loadingPage")}</span>
      </div>
    );
  }

  return (
    <div className="editor-scroll flex-1 overflow-auto rounded-card border border-border bg-muted/40 p-4 sm:p-6">
      <div
        className="relative mx-auto"
        style={{ width: pageW > 0 ? pageW : undefined }}
        role="application"
        aria-label={t("edit.canvasLabel")}
      >
        <div
          ref={pageRef}
          className="relative bg-card shadow-md ring-1 ring-border"
          style={{ width: pageW, height: pageH }}
        >
          {blank || !bitmap ? (
            <div className="absolute inset-0 bg-white" />
          ) : (
            <canvas
              ref={(canvas) => {
                if (!canvas) return;
                const ctx = canvas.getContext("2d");
                if (!ctx) return;
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
                ctx.drawImage(bitmap, 0, 0);
                canvasRef.current = canvas;
              }}
              className="block"
              style={{ width: pageW, height: pageH }}
              aria-hidden="true"
            />
          )}

          {/* Interaction + object overlay */}
          <div
            className="absolute inset-0 touch-none select-none"
            style={{ cursor }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={(event) => {
              const { x, y } = pagePos(event);
              const hit = hitTestTop(pageObjects, x, y);
              if (hit && hit.kind === "text") {
                store.getState().setSelection([hit.id]);
                store.getState().setTool("select");
                store.getState().setEditingId(hit.id);
                setDraft(hit.text);
                requestAnimationFrame(() => {
                  textareaRef.current?.focus();
                  textareaRef.current?.select();
                });
              } else if (hit && hit.kind === "note") {
                store.getState().setTool("select");
                openNoteEditor(hit.id);
              }
            }}
          >
            {/* Objects (visual only) */}
            {pageObjects.map((obj) => (
              <ObjectView
                key={obj.id}
                obj={obj}
                zoom={zoom}
                selected={selectionSet.has(obj.id)}
                editing={editingId === obj.id}
              />
            ))}

            {/* Editing textarea */}
            {editingObj ? (
              <textarea
                ref={textareaRef}
                value={draft ?? ""}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commitDraft}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    commitDraft();
                  }
                  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    commitDraft();
                  }
                }}
                className="absolute z-30 resize-none rounded-[2px] bg-transparent p-0 text-foreground outline-none ring-[1.5px] ring-primary"
                style={{
                  left: editingObj.x * zoom,
                  top: editingObj.y * zoom,
                  width: editingObj.w * zoom,
                  height: Math.max(
                    editingObj.h * zoom,
                    editingObj.size * editingObj.lineGap * zoom
                  ),
                  fontFamily: fontFamilyStack(
                    editingObj.family === "deva" ? "deva" : editingObj.family
                  ),
                  fontSize: editingObj.size * zoom,
                  fontWeight: editingObj.bold ? 700 : 400,
                  fontStyle: editingObj.italic ? "italic" : "normal",
                  lineHeight: `${editingObj.size * editingObj.lineGap * zoom}px`,
                  textAlign: editingObj.align,
                  color: editingObj.color,
                }}
                aria-label={t("edit.textEditLabel")}
                spellCheck={false}
              />
            ) : null}

            {/* Selection outlines + handles */}
            {pageObjects
              .filter((o) => selectionSet.has(o.id) && o.id !== editingId)
              .map((obj) => {
                const resizable = obj.kind !== "mark" && obj.kind !== "note";
                return (
                <div key={`sel-${obj.id}`}>
                  <div
                    className="pointer-events-none absolute border-[1.5px] border-primary"
                    style={{
                      left: obj.x * zoom,
                      top: obj.y * zoom,
                      width: obj.w * zoom,
                      height: obj.h * zoom,
                    }}
                  />
                  {selection.length === 1 && resizable
                    ? (
                        [
                          ["nw", obj.x, obj.y],
                          ["n", obj.x + obj.w / 2, obj.y],
                          ["ne", obj.x + obj.w, obj.y],
                          ["e", obj.x + obj.w, obj.y + obj.h / 2],
                          ["se", obj.x + obj.w, obj.y + obj.h],
                          ["s", obj.x + obj.w / 2, obj.y + obj.h],
                          ["sw", obj.x, obj.y + obj.h],
                          ["w", obj.x, obj.y + obj.h / 2],
                        ] as [ResizeHandle, number, number][]
                      ).map(([handle, hx, hy]) => (
                        <div
                          key={handle}
                          className="pointer-events-none absolute rounded-full border-[1.5px] border-primary bg-background"
                          style={{
                            left: hx * zoom - HANDLE_SIZE / 2,
                            top: hy * zoom - HANDLE_SIZE / 2,
                            width: HANDLE_SIZE,
                            height: HANDLE_SIZE,
                          }}
                        />
                      ))
                    : null}
                </div>
                );
              })}

            {/* Note popup editor (sticky note text) */}
            {noteEditingObj ? (
              (() => {
                const W = 232;
                const left =
                  noteEditingObj.x * zoom + noteEditingObj.w * zoom + 10 + W > pageW
                    ? Math.max(4, noteEditingObj.x * zoom - W - 10)
                    : noteEditingObj.x * zoom + noteEditingObj.w * zoom + 10;
                const top = Math.min(
                  Math.max(4, noteEditingObj.y * zoom - 40),
                  Math.max(4, pageH - 130)
                );
                const done = t("edit.noteDone");
                const label = t("edit.noteEditLabel");
                return (
                  <div
                    className="absolute z-40 flex flex-col gap-2 rounded-lg border border-border bg-card p-2 shadow-lg"
                    style={{ left, top, width: W }}
                    role="dialog"
                    aria-label={label}
                  >
                    <textarea
                      ref={noteAreaRef}
                      value={noteDraft ?? ""}
                      onChange={(event) => setNoteDraft(event.target.value)}
                      onBlur={commitNote}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          commitNote();
                        }
                        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                          event.preventDefault();
                          commitNote();
                        }
                      }}
                      rows={4}
                      className="w-full resize-none rounded-md border border-input bg-background p-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      placeholder={label}
                      aria-label={label}
                      maxLength={5000}
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className="inline-flex h-8 items-center justify-center gap-1.5 self-end rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                      onClick={commitNote}
                    >
                      <Check className="size-3.5" aria-hidden="true" />
                      {done}
                    </button>
                  </div>
                );
              })()
            ) : null}

            {/* Box preview (shape / whiteout / text / marquee / link) */}
            {previewBox ? (
              drag?.kind === "marquee" ? (
                <div
                  className="pointer-events-none absolute border border-primary/70 bg-primary/10"
                  style={{
                    left: previewBox.x * zoom,
                    top: previewBox.y * zoom,
                    width: previewBox.w * zoom,
                    height: previewBox.h * zoom,
                  }}
                />
              ) : drag?.kind === "marksel" ? (
                <div
                  className="pointer-events-none absolute border border-primary/50"
                  style={{
                    left: previewBox.x * zoom,
                    top: previewBox.y * zoom,
                    width: previewBox.w * zoom,
                    height: previewBox.h * zoom,
                  }}
                />
              ) : tool === "whiteout" ? (
                <div
                  className="pointer-events-none absolute border border-dashed border-foreground/60"
                  style={{
                    left: previewBox.x * zoom,
                    top: previewBox.y * zoom,
                    width: previewBox.w * zoom,
                    height: previewBox.h * zoom,
                    backgroundColor: drag?.kind === "box" ? drag.color ?? "#ffffff" : undefined,
                    opacity: 0.9,
                  }}
                />
              ) : (
                <div
                  className="pointer-events-none absolute border-2 border-dashed border-primary"
                  style={{
                    left: previewBox.x * zoom,
                    top: previewBox.y * zoom,
                    width: previewBox.w * zoom,
                    height: previewBox.h * zoom,
                  }}
                />
              )
            ) : null}

            {/* Editable-line hover affordance (sub-phase 3) */}
            {hoverLine ? (
              <div
                className="pointer-events-none absolute rounded-[2px] border border-primary/70 bg-primary/10"
                style={{
                  left: hoverLine.x * zoom,
                  top: hoverLine.y * zoom,
                  width: hoverLine.w * zoom,
                  height: hoverLine.h * zoom,
                }}
              />
            ) : null}

            {/* Live text-markup preview — quads snap to real text lines */}
            {markPreviewQuads && markPreviewQuads.length > 0
              ? markPreviewQuads.map((_, i) => {
                  const qx = markPreviewQuads[i * 4];
                  const qy = markPreviewQuads[i * 4 + 1];
                  const qw = markPreviewQuads[i * 4 + 2];
                  const qh = markPreviewQuads[i * 4 + 3];
                  return (
                    <div
                      key={`mp-${i}`}
                      className="pointer-events-none absolute"
                      style={{
                        left: qx * zoom,
                        top: qy * zoom,
                        width: qw * zoom,
                        height: qh * zoom,
                        backgroundColor: markColor,
                        opacity: markKind === "highlight" ? 0.45 : 0.35,
                        mixBlendMode: "multiply",
                      }}
                    />
                  );
                })
              : null}

            {/* Freehand preview */}
            {drawPreview && drag?.kind === "draw" ? (
              <svg
                className="pointer-events-none absolute overflow-visible"
                style={{
                  left: drawPreview.x * zoom,
                  top: drawPreview.y * zoom,
                  width: drawPreview.w * zoom,
                  height: drawPreview.h * zoom,
                }}
                viewBox={`${drawPreview.x} ${drawPreview.y} ${drawPreview.w} ${drawPreview.h}`}
              >
                <polyline
                  points={drag.pts.reduce(
                    (acc, n, i) =>
                      i % 2 === 0 ? `${acc}${acc === "" ? "" : " "}${n}` : `${acc},${n}`,
                    ""
                  )}
                  fill="none"
                  stroke={penColor}
                  strokeWidth={penWidth}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Object rendering (pure visuals — pointer events stay on the overlay)
// ---------------------------------------------------------------------------

function ObjectView(props: {
  obj: EdObj;
  zoom: number;
  selected: boolean;
  editing: boolean;
}): React.JSX.Element | null {
  const { obj, zoom, editing } = props;
  const style: React.CSSProperties = {
    left: obj.x * zoom,
    top: obj.y * zoom,
    width: obj.w * zoom,
    height: obj.h * zoom,
    opacity: obj.opacity,
  };

  switch (obj.kind) {
    case "mark": {
      const boxes: React.JSX.Element[] = [];
      for (let i = 0; i < obj.quads.length; i += 4) {
        const qx = obj.quads[i];
        const qy = obj.quads[i + 1];
        const qw = obj.quads[i + 2];
        const qh = obj.quads[i + 3];
        boxes.push(
          <div
            key={i}
            className="absolute"
            style={{
              left: (qx - obj.x) * zoom,
              top: (qy - obj.y) * zoom,
              width: Math.max(1, qw * zoom),
              height: Math.max(1, qh * zoom),
            }}
          >
            <div
              className="absolute inset-0"
              style={{
                backgroundColor: obj.color,
                opacity: obj.mark === "highlight" ? 1 : 0.3,
                mixBlendMode: "multiply",
              }}
            />
            {obj.mark === "underline" ? (
              <span
                className="absolute inset-x-0 bottom-[12%] block"
                style={{
                  height: Math.max(1, 1.5 * zoom),
                  backgroundColor: obj.color,
                }}
              />
            ) : null}
            {obj.mark === "strike" ? (
              <span
                className="absolute inset-x-0 top-1/2 block -translate-y-1/2"
                style={{
                  height: Math.max(1, 1.5 * zoom),
                  backgroundColor: obj.color,
                }}
              />
            ) : null}
          </div>
        );
      }
      return (
        <div className="pointer-events-none absolute" style={style}>
          {boxes}
        </div>
      );
    }
    case "note": {
      return (
        <div
          className="pointer-events-none absolute flex items-center justify-center rounded-[6px] shadow-md ring-1 ring-black/15"
          style={{ ...style, backgroundColor: obj.color }}
          aria-label={obj.text === "" ? undefined : obj.text}
        >
          <MessageSquareText className="size-[60%] text-black/70" aria-hidden="true" />
        </div>
      );
    }
    case "link": {
      return (
        <div
          className="pointer-events-none absolute rounded-[3px] border-2 border-dashed border-emerald-600/80 bg-emerald-500/5"
          style={style}
        />
      );
    }
    case "text": {
      if (editing) return null;
      const lineHeight = obj.size * obj.lineGap * zoom;
      return (
        <div
          className="pointer-events-none absolute whitespace-pre"
          style={{
            ...style,
            color: obj.color,
            fontSize: obj.size * zoom,
            fontWeight: obj.bold ? 700 : 400,
            fontStyle: obj.italic ? "italic" : "normal",
            lineHeight: `${lineHeight}px`,
            textAlign: obj.align,
            backgroundColor: obj.bg ?? undefined,
            fontFamily:
              obj.family === "deva"
                ? "var(--font-noto-devanagari), 'Noto Sans Devanagari', sans-serif"
                : obj.family === "serif"
                  ? "'Times New Roman', 'Liberation Serif', serif"
                  : obj.family === "mono"
                    ? "'Courier New', 'Liberation Mono', monospace"
                    : "Helvetica, Arial, 'Liberation Sans', sans-serif",
            textDecoration: obj.underline ? "underline" : undefined,
          }}
        >
          {obj.lines.map((line, i) => (
            <div key={i}>{line.t === "" ? "\u00A0" : line.t}</div>
          ))}
        </div>
      );
    }
    case "whiteout": {
      return (
        <div
          className="pointer-events-none absolute"
          style={{ ...style, backgroundColor: obj.color }}
        />
      );
    }
    case "image": {
      return (
        <AssetImage obj={obj} style={style} />
      );
    }
    case "path": {
      return (
        <svg
          className="pointer-events-none absolute overflow-visible"
          style={style}
          viewBox={`${obj.x} ${obj.y} ${obj.w} ${obj.h}`}
        >
          <polyline
            points={obj.pts.reduce(
              (acc, n, i) =>
                i % 2 === 0 ? `${acc}${acc === "" ? "" : " "}${n}` : `${acc},${n}`,
              ""
            )}
            fill="none"
            stroke={obj.stroke}
            strokeWidth={obj.strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    }
    case "shape": {
      return (
        <ShapeSvg obj={obj} style={style} />
      );
    }
  }
}

/** Shape rendering inside an SVG sized to the object box (viewBox = pts). */
function ShapeSvg(props: {
  obj: Extract<EdObj, { kind: "shape" }>;
  style: React.CSSProperties;
}): React.JSX.Element {
  const { obj, style } = props;
  const { w, h } = obj;
  const stroke = obj.stroke ?? "none";
  const fill = obj.fill ?? "none";
  const strokeProps = {
    stroke: obj.stroke === null ? "none" : stroke,
    strokeWidth: obj.strokeWidth,
    strokeDasharray: obj.dash ? `${obj.strokeWidth * 2.2} ${obj.strokeWidth * 1.6}` : undefined,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  let contents: React.JSX.Element | null = null;
  switch (obj.shape) {
    case "rect":
      contents = (
        <rect
          x={obj.strokeWidth / 2}
          y={obj.strokeWidth / 2}
          width={Math.max(0.5, w - obj.strokeWidth)}
          height={Math.max(0.5, h - obj.strokeWidth)}
          fill={fill}
          {...strokeProps}
        />
      );
      break;
    case "ellipse":
      contents = (
        <ellipse
          cx={w / 2}
          cy={h / 2}
          rx={Math.max(0.5, w / 2 - obj.strokeWidth / 2)}
          ry={Math.max(0.5, h / 2 - obj.strokeWidth / 2)}
          fill={fill}
          {...strokeProps}
        />
      );
      break;
    case "line":
    case "arrow": {
      const x1 = obj.x1f * w;
      const y1 = obj.y1f * h;
      const x2 = obj.x2f * w;
      const y2 = obj.y2f * h;
      const head =
        obj.shape === "arrow"
          ? arrowHeadPoints(x1, y1, x2, y2).map(
              ([hx1, hy1, hx2, hy2], i) => (
                <line
                  key={i}
                  x1={hx1}
                  y1={hy1}
                  x2={hx2}
                  y2={hy2}
                  {...strokeProps}
                />
              )
            )
          : null;
      contents = (
        <>
          <line x1={x1} y1={y1} x2={x2} y2={y2} {...strokeProps} />
          {head}
        </>
      );
      break;
    }
    case "check": {
      const [a, b, c] = CHECK_FRACTIONS;
      contents = (
        <polyline
          points={`${a[0] * w},${a[1] * h} ${b[0] * w},${b[1] * h} ${c[0] * w},${c[1] * h}`}
          fill="none"
          {...strokeProps}
        />
      );
      break;
    }
    case "cross": {
      contents = (
        <>
          {CROSS_FRACTIONS.map(([fx1, fy1, fx2, fy2], i) => (
            <line
              key={i}
              x1={fx1 * w}
              y1={fy1 * h}
              x2={fx2 * w}
              y2={fy2 * h}
              {...strokeProps}
            />
          ))}
        </>
      );
      break;
    }
  }
  return (
    <svg
      className="pointer-events-none absolute overflow-visible"
      style={props.style}
      viewBox={`0 0 ${w} ${h}`}
    >
      {contents}
    </svg>
  );
}

/** Image object — resolves its blob URL from the shared asset registry. */
function AssetImage(props: {
  obj: Extract<EdObj, { kind: "image" }>;
  style: React.CSSProperties;
}): React.JSX.Element | null {
  const { obj, style } = props;
  const url = useAssetUrl(obj.assetId);
  if (url === null) return null;
  return (
    <img
      src={url}
      alt=""
      draggable={false}
      className="pointer-events-none absolute"
      style={style}
    />
  );
}
