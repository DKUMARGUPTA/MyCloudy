"use client";

/**
 * Write PDF live surface (PRD §8 "Write PDF") — the entire product for a
 * no-file tool (the generate-qr-code pattern): the template picker renders
 * in place of the DropZone on the landing page, then the block editor
 * (uncontrolled contentEditable text blocks + tables + images + breaks)
 * with a formatting toolbar, page setup, coalesced doc-wide undo/redo and
 * a paginated live preview that runs the SAME pure layout engine as the
 * export worker (canvas metrics vs pdf-lib metrics — metric-compatible
 * browser faces keep them aligned).
 *
 * Export stays honest: the surface spawns the tool's real Web Worker and
 * speaks the shared protocol directly (progress → on-device download via
 * downloadBlob). The document rides options.doc as JSON; image assets ride
 * the message's files[] in assetOrderOf order. Zero network with data.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { CheckCircle2, FileText, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { useI18n } from "@/components/providers/locale-provider";
import { downloadBlob } from "@/lib/files/output";
import {
  BlockShell,
  BLOCK_MENU_ITEMS,
  EditableText,
  ExportButton,
  ExportProgress,
  FormatToolbar,
  HistoryButtons,
  ModeToggle,
  PageSetupPanel,
  RailControls,
  SetupToggle,
  TableEditor,
  TemplatePicker,
  fontFamilyCss,
  parseEditableRuns,
  previewCssFamily,
  runsToHtml,
} from "./parts";
import {
  W_PAGE_SIZES,
  W_STYLES,
  assetOrderOf,
  layoutDoc,
  type LPiece,
  type WAlign,
  type WBlock,
  type WDoc,
  type WFamily,
  type WLaidResult,
  type WTextKind,
} from "./model";
import { buildTemplate, type TemplateId } from "./templates";
import {
  addImageFile,
  collectAssetsInOrder,
  getAssetsSnapshot,
  removeAsset,
  subscribeAssets,
} from "./asset-store";
import type { WorkerResponse } from "@/lib/workers/protocol";

/* --------------------------- ids + blocks -------------------------- */

let idSeq = 0;
function nid(): string {
  idSeq += 1;
  return `wb${idSeq}`;
}

const TEXT_KINDS: WTextKind[] = [
  "p",
  "h1",
  "h2",
  "h3",
  "bullet",
  "numbered",
  "quote",
];

function isTextBlock(block: WBlock): block is Extract<WBlock, { runs: unknown[] }> {
  return TEXT_KINDS.includes(block.kind as WTextKind);
}

function cloneDoc(doc: WDoc): WDoc {
  return JSON.parse(JSON.stringify(doc)) as WDoc;
}

function makeBlock(kind: string, previous?: WBlock): WBlock {
  if (kind === "table") {
    return { id: nid(), kind: "table", rows: [["", ""], ["", ""]], header: true };
  }
  if (kind === "hr") return { id: nid(), kind: "hr" };
  if (kind === "pagebreak") return { id: nid(), kind: "pagebreak" };
  if (kind === "image") {
    // image blocks are created by the file input handler, never here
    return { id: nid(), kind: "hr" };
  }
  const prevText =
    previous && isTextBlock(previous)
      ? previous
      : undefined;
  return {
    id: nid(),
    kind: (TEXT_KINDS.includes(kind as WTextKind) ? kind : "p") as WTextKind,
    runs: [],
    align: prevText?.align ?? "left",
    family: prevText?.family ?? "sans",
  };
}

/* --------------------------- component ----------------------------- */

export function WriteSurface(props: ToolSurfaceProps): JSX.Element {
  void props;
  const { t, locale } = useI18n();
  const { toast } = useToast();

  const [doc, setDoc] = useState<WDoc | null>(null);
  const docRef = useRef<WDoc | null>(null);
  const [blockVersion, setBlockVersion] = useState(0);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [setupOpen, setSetupOpen] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const stickyTextIdRef = useRef<string | null>(null);
  const [stickyTextId, setStickyTextId] = useState<string | null>(null);
  const [formatState, setFormatState] = useState({
    bold: false,
    italic: false,
    underline: false,
  });
  const [exportPct, setExportPct] = useState<number | null>(null);
  const [exported, setExported] = useState<{
    name: string;
    pages?: number;
    words?: number;
  } | null>(null);
  const [fontsReady, setFontsReady] = useState(false);
  const [laid, setLaid] = useState<WLaidResult | null>(null);
  const [autoFocus, setAutoFocus] = useState<{ id: string; token: number } | null>(
    null
  );
  const [historyPos, setHistoryPos] = useState({ index: 0, length: 1 });

  const historyRef = useRef<{ stack: WDoc[]; index: number }>({
    stack: [],
    index: -1,
  });
  const lastPushRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imagePickRef = useRef<string | null>(null); // replace target
  const workerRef = useRef<Worker | null>(null);
  const measureCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const previewWrapRef = useRef<HTMLDivElement>(null);
  const [previewScale, setPreviewScale] = useState(1);

  const assets = useSyncExternalStore(subscribeAssets, getAssetsSnapshot);
  const assetMap = useMemo(() => {
    const map = new Map(assets.map((asset) => [asset.key, asset]));
    return map;
  }, [assets]);

  /* ---------------------- history + doc updates -------------------- */

  const pushHistory = useCallback((next: WDoc, immediate: boolean): void => {
    const h = historyRef.current;
    const now = Date.now();
    const coalesce = !immediate && now - lastPushRef.current < 800;
    if (coalesce && h.index >= 0) {
      h.stack[h.index] = next;
    } else {
      h.stack = h.stack.slice(0, h.index + 1);
      h.stack.push(next);
      if (h.stack.length > 100) h.stack.shift();
      h.index = h.stack.length - 1;
    }
    lastPushRef.current = now;
    setHistoryPos({
      index: h.index,
      length: h.stack.length,
    });
  }, []);

  /** Single door for doc mutations (docRef stays StrictMode-pure). */
  const applyDoc = useCallback(
    (next: WDoc, opts: { immediate?: boolean; resync?: boolean }): void => {
      docRef.current = next;
      setDoc(next);
      pushHistory(next, opts.immediate !== false);
      if (opts.resync === true) setBlockVersion((v) => v + 1);
    },
    [pushHistory]
  );

  const mutate = useCallback(
    (
      mutator: (draft: WDoc) => void,
      opts: { immediate?: boolean; resync?: boolean } = { immediate: true }
    ): void => {
      const current = docRef.current;
      if (!current) return;
      const next = cloneDoc(current);
      mutator(next);
      applyDoc(next, opts);
    },
    [applyDoc]
  );

  const undo = useCallback((): void => {
    const h = historyRef.current;
    if (h.index <= 0) return;
    h.index -= 1;
    const next = h.stack[h.index];
    docRef.current = next;
    setDoc(next);
    setBlockVersion((v) => v + 1);
    setHistoryPos({ index: h.index, length: h.stack.length });
  }, []);

  const redo = useCallback((): void => {
    const h = historyRef.current;
    if (h.index >= h.stack.length - 1) return;
    h.index += 1;
    const next = h.stack[h.index];
    docRef.current = next;
    setDoc(next);
    setBlockVersion((v) => v + 1);
    setHistoryPos({ index: h.index, length: h.stack.length });
  }, []);

  const canUndo = historyPos.index > 0;
  const canRedo = historyPos.index < historyPos.length - 1;

  /* ---------------------- template start --------------------------- */

  const startTemplate = useCallback(
    (id: TemplateId): void => {
      const dateText = new Intl.DateTimeFormat(
        locale === "hi" ? "hi-IN" : "en-IN"
      ).format(new Date());
      const next = buildTemplate(id, dateText);
      docRef.current = next;
      setDoc(next);
      historyRef.current = { stack: [cloneDoc(next)], index: 0 };
      lastPushRef.current = 0;
      setHistoryPos({ index: 0, length: 1 });
      setMode("edit");
      setExported(null);
      setLaid(null);
    },
    [locale]
  );

  /* ---------------------- block operations ------------------------- */

  const commitText = useCallback(
    (blockId: string, element: HTMLElement): void => {
      const runs = parseEditableRuns(element);
      mutate(
        (draft) => {
          const block = draft.blocks.find((b) => b.id === blockId);
          if (block && isTextBlock(block)) block.runs = runs;
        },
        { immediate: false }
      );
    },
    [mutate]
  );

  const addBlockAfter = useCallback(
    (kind: string, afterId: string | null): void => {
      if (kind === "image") {
        imagePickRef.current = null;
        fileInputRef.current?.click();
        return;
      }
      let newId = "";
      mutate((draft) => {
        const index = afterId
          ? draft.blocks.findIndex((b) => b.id === afterId)
          : draft.blocks.length - 1;
        const insertAt = index >= 0 ? index + 1 : draft.blocks.length;
        const previous =
          insertAt > 0 ? draft.blocks[insertAt - 1] : undefined;
        const block = makeBlock(kind, previous);
        newId = block.id;
        draft.blocks.splice(insertAt, 0, block);
      });
      if (newId !== "" && TEXT_KINDS.includes(kind as WTextKind)) {
        setAutoFocus({ id: newId, token: Date.now() });
      }
    },
    [mutate]
  );

  const removeBlock = useCallback(
    (blockId: string): void => {
      const current = docRef.current;
      if (!current) return;
      const index = current.blocks.findIndex((b) => b.id === blockId);
      if (index < 0) return;
      // focus the nearest text neighbour so typing continues there
      let neighbour: WBlock | undefined = current.blocks[index - 1];
      if (!neighbour || !isTextBlock(neighbour)) {
        neighbour = current.blocks
          .slice(index + 1)
          .find((b) => isTextBlock(b));
      }
      if (neighbour && current.blocks.length > 1) {
        setAutoFocus({ id: neighbour.id, token: Date.now() });
      }
      mutate((draft) => {
        const block = draft.blocks.find((b) => b.id === blockId);
        if (block?.kind === "image") {
          // drop the asset only if no other block uses it
          const stillUsed = draft.blocks.some(
            (b) =>
              b.kind === "image" &&
              b.id !== blockId &&
              b.assetKey === block.assetKey
          );
          if (!stillUsed) removeAsset(block.assetKey);
        }
        draft.blocks = draft.blocks.filter((b) => b.id !== blockId);
      });
    },
    [mutate]
  );

  const duplicateBlock = useCallback(
    (blockId: string): void => {
      mutate((draft) => {
        const index = draft.blocks.findIndex((b) => b.id === blockId);
        if (index < 0) return;
        const copy = cloneDoc({
          title: "",
          setup: draft.setup,
          blocks: [draft.blocks[index]],
        }).blocks[0];
        copy.id = nid();
        draft.blocks.splice(index + 1, 0, copy);
      });
    },
    [mutate]
  );

  const moveBlock = useCallback(
    (blockId: string, direction: -1 | 1): void => {
      mutate((draft) => {
        const index = draft.blocks.findIndex((b) => b.id === blockId);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= draft.blocks.length) return;
        const [moved] = draft.blocks.splice(index, 1);
        draft.blocks.splice(target, 0, moved);
      });
    },
    [mutate]
  );

  /* ---------------------- inline formatting ------------------------ */

  useEffect(() => {
    const onSelectionChange = (): void => {
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        active.getAttribute("contenteditable") === "true"
      ) {
        try {
          const next = {
            bold: document.queryCommandState("bold"),
            italic: document.queryCommandState("italic"),
            underline: document.queryCommandState("underline"),
          };
          setFormatState((prev) =>
            prev.bold === next.bold &&
            prev.italic === next.italic &&
            prev.underline === next.underline
              ? prev
              : next
          );
        } catch {
          /* some engines throw on queryCommandState — keep last state */
        }
      }
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  const execFormat = useCallback(
    (cmd: "bold" | "italic" | "underline"): void => {
      try {
        document.execCommand("styleWithCSS", false, "true");
        document.execCommand(cmd, false);
      } catch {
        /* legacy engines without execCommand lose run formatting — honest */
      }
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.getAttribute("contenteditable") === "true") {
        commitText(stickyTextIdRef.current ?? "", active);
        setFormatState((prev) => ({ ...prev, [cmd]: !prev[cmd] }));
      }
    },
    [commitText]
  );

  const applyColor = useCallback(
    (hex: string): void => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.getAttribute("contenteditable") === "true") {
        try {
          document.execCommand("styleWithCSS", false, "true");
          document.execCommand("foreColor", false, hex);
        } catch {
          /* ignore */
        }
        commitText(stickyTextIdRef.current ?? "", active);
      }
    },
    [commitText]
  );

  const patchTextBlock = useCallback(
    (
      blockId: string,
      patch: Partial<Extract<WBlock, { runs: unknown[] }>> | { scale?: number; align?: WAlign }
    ): void => {
      mutate((draft) => {
        const block = draft.blocks.find((b) => b.id === blockId);
        if (!block) return;
        if (isTextBlock(block)) {
          const textPatch = patch as Partial<Extract<WBlock, { runs: unknown[] }>>;
          if (textPatch.align !== undefined) block.align = textPatch.align;
          if (textPatch.family !== undefined) block.family = textPatch.family;
          if (textPatch.size !== undefined) block.size = textPatch.size;
          if (textPatch.kind !== undefined) block.kind = textPatch.kind;
        } else if (block.kind === "image") {
          const imagePatch = patch as { scale?: number; align?: WAlign };
          if (
            imagePatch.scale !== undefined &&
            [0.25, 0.5, 0.75, 1].includes(imagePatch.scale)
          ) {
            block.scale = imagePatch.scale as typeof block.scale;
          }
          if (imagePatch.align !== undefined) block.align = imagePatch.align;
        }
      });
    },
    [mutate]
  );

  /* ---------------------- key handling ----------------------------- */

  const onEditableKeyDown = useCallback(
    (blockId: string, event: ReactKeyboardEvent<HTMLDivElement>): void => {
      const key = event.key.toLowerCase();
      const meta = event.metaKey || event.ctrlKey;
      if (meta && key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (meta && key === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if (key === "enter") {
        event.preventDefault();
        addBlockAfter("p", blockId);
        return;
      }
      if (key === "backspace") {
        const el = event.currentTarget;
        const current = docRef.current;
        if (
          (el.textContent ?? "").trim().length === 0 &&
          current &&
          current.blocks.length > 1
        ) {
          event.preventDefault();
          removeBlock(blockId);
        }
      }
    },
    [addBlockAfter, redo, removeBlock, undo]
  );

  /* ---------------------- table ops -------------------------------- */

  const patchTable = useCallback(
    (
      blockId: string,
      mutator: (rows: string[][], header: boolean) => { rows: string[][]; header: boolean } | void
    ): void => {
      mutate(
        (draft) => {
          const block = draft.blocks.find((b) => b.id === blockId);
          if (!block || block.kind !== "table") return;
          const result = mutator(block.rows, block.header);
          if (result) {
            block.rows = result.rows;
            block.header = result.header;
          }
        },
        { immediate: false }
      );
    },
    [mutate]
  );

  /* ---------------------- images ----------------------------------- */

  const onPickImage = useCallback(
    async (file: File): Promise<void> => {
      const current = docRef.current;
      if (!current) return;
      try {
        const asset = await addImageFile(file);
        const replaceKey = imagePickRef.current;
        imagePickRef.current = null;
        if (replaceKey) {
          mutate((draft) => {
            for (const block of draft.blocks) {
              if (block.kind === "image" && block.assetKey === replaceKey) {
                block.assetKey = asset.key;
              }
            }
          });
          removeAsset(replaceKey);
          return;
        }
        mutate((draft) => {
          draft.blocks.push({
            id: nid(),
            kind: "image",
            assetKey: asset.key,
            scale: 0.75,
            align: "center",
          });
        });
      } catch {
        toast({
          title: t("tool.errorTitle"),
          description: t("write.errorImage", { name: file.name }),
          variant: "destructive",
        });
      }
    },
    [mutate, t, toast]
  );

  /* ---------------------- preview (shared engine) ------------------- */

  useEffect(() => {
    let cancelled = false;
    const face = new FontFace(
      "DocoWriteDeva",
      "url(/fonts/NotoSansDevanagari-Regular.ttf)"
    );
    document.fonts.add(face);
    face.load()
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setFontsReady(true);
      });
    return () => {
      cancelled = true;
      document.fonts.delete(face);
    };
  }, []);

  const measure = useCallback(
    (
      text: string,
      spec: { family: WFamily; bold: boolean; italic: boolean },
      size: number,
      script: "std" | "noto"
    ): number => {
      if (!measureCtxRef.current) {
        measureCtxRef.current =
          document.createElement("canvas").getContext("2d");
      }
      const ctx = measureCtxRef.current;
      if (!ctx) return text.length * size * 0.5;
      const family = previewCssFamily(spec.family, script);
      ctx.font = `${spec.italic ? "italic " : ""}${spec.bold ? "700" : "400"} ${size}px ${family}`;
      return ctx.measureText(text).width;
    },
    []
  );

  const pageW = doc
    ? doc.setup.landscape
      ? W_PAGE_SIZES[doc.setup.pageSize].height
      : W_PAGE_SIZES[doc.setup.pageSize].width
    : 595.28;
  const pageH = doc
    ? doc.setup.landscape
      ? W_PAGE_SIZES[doc.setup.pageSize].width
      : W_PAGE_SIZES[doc.setup.pageSize].height
    : 841.89;

  useEffect(() => {
    if (mode !== "preview" || !doc || !fontsReady) return;
    const timer = setTimeout(() => {
      const imageSizes: Record<string, { w: number; h: number }> = {};
      for (const asset of assets) {
        imageSizes[asset.key] = { w: asset.w, h: asset.h };
      }
      try {
        setLaid(layoutDoc({ doc, imageSizes, measure }));
      } catch {
        setLaid(null);
      }
    }, 160);
    return () => clearTimeout(timer);
  }, [doc, mode, fontsReady, assets, measure]);

  useEffect(() => {
    if (mode !== "preview") return;
    const update = (): void => {
      const width = previewWrapRef.current?.clientWidth ?? 620;
      setPreviewScale(Math.min(1, width / pageW));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [mode, pageW]);

  /* ---------------------- export ----------------------------------- */

  const exportPdf = useCallback((): void => {
    const current = docRef.current;
    if (!current) return;
    const hasContent = current.blocks.some((block) => {
      if (block.kind === "pagebreak") return false;
      if (block.kind === "hr" || block.kind === "table" || block.kind === "image") {
        return true;
      }
      return block.runs.length > 0;
    });
    if (!hasContent) {
      toast({
        title: t("tool.errorTitle"),
        description: t("write.errorEmpty"),
        variant: "destructive",
      });
      return;
    }
    if (workerRef.current) return;
    const files = collectAssetsInOrder(assetOrderOf(current));
    setExportPct(0);
    setExported(null);
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    const runId = Date.now();
    const cleanup = (): void => {
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };
    worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      const data = event.data;
      if (!data || data.runId !== runId) return;
      if (data.type === "progress") {
        setExportPct(data.pct);
        return;
      }
      if (data.type === "result") {
        const output = data.outputs[0];
        setExportPct(null);
        if (output) {
          downloadBlob(output.blob, output.name);
          setExported({
            name: output.name,
            pages: data.detail?.pages,
            words: data.detail?.words,
          });
          toast({
            title: t("write.doneTitle"),
            description: t("write.doneDesc", { name: output.name }),
          });
        }
        cleanup();
        return;
      }
      if (data.type === "error") {
        setExportPct(null);
        toast({
          title: t("tool.errorTitle"),
          description: t(data.code, { detail: data.detail ?? "" }),
          variant: "destructive",
        });
        cleanup();
      }
    });
    worker.addEventListener("error", () => {
      setExportPct(null);
      toast({
        title: t("tool.errorTitle"),
        description: t("tool.errorGeneric"),
        variant: "destructive",
      });
      cleanup();
    });
    worker.postMessage({
      type: "run",
      runId,
      toolId: "write-pdf",
      options: { doc: JSON.stringify(current) },
      files,
    });
  }, [t, toast]);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  /* ---------------------- derived toolbar state -------------------- */

  const currentTextBlock = useMemo(() => {
    if (!doc) return null;
    const id = focusId ?? stickyTextId;
    if (!id) return null;
    const block = doc.blocks.find((b) => b.id === id);
    return block && isTextBlock(block) ? block : null;
  }, [doc, focusId, stickyTextId]);

  /* ---------------------- render ----------------------------------- */

  if (!doc) {
    return (
      <div className="flex flex-col gap-4">
        <TemplatePicker onPick={startTemplate} />
        <p className="text-xs text-muted-foreground">{t("write.pickHint")}</p>
      </div>
    );
  }

  const contentW = pageW - 2 * ({ narrow: 36, normal: 72, wide: 108 } as const)[doc.setup.margins];

  return (
    <div className="flex flex-col gap-3">
      {/* hidden file input for image blocks */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void onPickImage(file);
        }}
      />

      {/* top bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-40 flex-1">
          <FileText
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={doc.title}
            onChange={(e) =>
              mutate((draft) => {
                draft.title = e.target.value;
              }, { immediate: false })
            }
            placeholder={t("write.titlePlaceholder")}
            aria-label={t("write.titleLabel")}
            className="h-9 rounded-btn pl-9 text-sm"
          />
        </div>
        <HistoryButtons
          onUndo={undo}
          onRedo={redo}
          canUndo={canUndo}
          canRedo={canRedo}
          t={t}
        />
        <ModeToggle mode={mode} onMode={setMode} t={t} />
        <SetupToggle
          open={setupOpen}
          onToggle={() => setSetupOpen((open) => !open)}
          t={t}
        />
        <ExportButton onClick={exportPdf} busy={exportPct !== null} t={t} />
      </div>

      {setupOpen ? (
        <PageSetupPanel
          setup={doc.setup}
          onChange={(patch) =>
            mutate((draft) => {
              Object.assign(draft.setup, patch);
            })
          }
          t={t}
        />
      ) : null}

      {mode === "edit" ? (
        <>
          <FormatToolbar
            bold={formatState.bold}
            italic={formatState.italic}
            underline={formatState.underline}
            onFormat={execFormat}
            family={currentTextBlock?.family ?? "sans"}
            onFamily={(family) => {
              if (currentTextBlock) {
                patchTextBlock(currentTextBlock.id, { family });
              }
            }}
            align={currentTextBlock?.align ?? "left"}
            onAlign={(align) => {
              if (currentTextBlock) {
                patchTextBlock(currentTextBlock.id, { align });
              }
            }}
            size={
              currentTextBlock?.kind === "p"
                ? (currentTextBlock.size ?? W_STYLES.p.size)
                : null
            }
            onSize={(size) => {
              if (currentTextBlock) {
                patchTextBlock(currentTextBlock.id, { size });
              }
            }}
            onColor={applyColor}
            color="#1a1a1f"
            kind={currentTextBlock?.kind ?? "p"}
            onKind={(kind) => {
              if (currentTextBlock) {
                mutate((draft) => {
                  const block = draft.blocks.find((b) => b.id === currentTextBlock.id);
                  if (block && isTextBlock(block)) {
                    block.kind = kind as WTextKind;
                    if (kind !== "p") delete block.size;
                  }
                });
              }
            }}
            t={t}
            textFocused={focusId !== null}
          />

          {/* the paper column */}
          <div className="mx-auto w-full rounded-card border border-border bg-card p-4 shadow-sm sm:p-6 md:p-8">
            <div
              className="mx-auto flex flex-col"
              style={{ maxWidth: `${contentW}pt`, minHeight: "12rem" }}
            >
              {doc.blocks.map((block, index) => (
                <BlockRow
                  key={block.id}
                  block={block}
                  index={index}
                  total={doc.blocks.length}
                  number={numberFor(doc.blocks, index)}
                  version={blockVersion}
                  autoFocusToken={autoFocus?.id === block.id ? autoFocus.token : undefined}
                  t={t}
                  onInput={commitText}
                  onKeyDown={onEditableKeyDown}
                  onFocusBlock={(id) => {
                    setFocusId(id);
                    setStickyTextId(id);
                    stickyTextIdRef.current = id;
                  }}
                  onPatch={patchTextBlock}
                  onRemove={removeBlock}
                  onDuplicate={duplicateBlock}
                  onMove={moveBlock}
                  onAddAfter={(kind) => addBlockAfter(kind, block.id)}
                  onTable={(mutator) => patchTable(block.id, mutator)}
                  onPickImage={() => {
                    imagePickRef.current = null;
                    fileInputRef.current?.click();
                  }}
                  onReplaceImage={(key) => {
                    imagePickRef.current = key;
                    fileInputRef.current?.click();
                  }}
                  assetUrl={
                    block.kind === "image"
                      ? (assetMap.get(block.assetKey)?.url ?? null)
                      : null
                  }
                />
              ))}

              {/* add block */}
              <div className="mt-6 flex justify-center">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="touch"
                      className="rounded-btn"
                    >
                      <Plus className="size-4" aria-hidden="true" />
                      {t("write.addBlock")}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="center" className="rounded-card">
                    {BLOCK_MENU_ITEMS.map((item) => (
                      <DropdownMenuItem
                        key={item.kind}
                        onClick={() => addBlockAfter(item.kind, null)}
                        className="gap-2 rounded-btn text-sm"
                      >
                        {item.icon}
                        {t(item.labelKey)}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>
        </>
      ) : (
        <div ref={previewWrapRef} className="flex flex-col items-center gap-4">
          <p className="text-xs text-muted-foreground">
            {t("write.previewPages", {
              n: laid?.pages.length ?? 1,
            })}
          </p>
          {(laid?.pages ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("write.previewEmpty")}</p>
          ) : null}
          {(laid?.pages ?? []).map((page, pageIndex) => (
            <div
              key={pageIndex}
              className="relative overflow-hidden rounded-sm border border-border bg-white shadow-md"
              style={{
                width: pageW * previewScale,
                height: pageH * previewScale,
              }}
              aria-label={t("write.previewPageOf", {
                n: pageIndex + 1,
                total: laid?.pages.length ?? pageIndex + 1,
              })}
            >
              {page.rects.map((rect, i) => (
                <div
                  key={`r${i}`}
                  className="absolute"
                  style={{
                    left: rect.x * previewScale,
                    top: (pageH - rect.y - rect.h) * previewScale,
                    width: rect.w * previewScale,
                    height: rect.h * previewScale,
                    backgroundColor: rect.color,
                  }}
                />
              ))}
              {page.images.map((image, i) => {
                const key = assetOrderOf(doc)[image.index];
                const url = key ? assetMap.get(key)?.url : undefined;
                if (!url) return null;
                return (
                  <img
                    key={`i${i}`}
                    src={url}
                    alt=""
                    className="absolute"
                    style={{
                      left: image.x * previewScale,
                      top: (pageH - image.y - image.h) * previewScale,
                      width: image.w * previewScale,
                      height: image.h * previewScale,
                    }}
                  />
                );
              })}
              {page.lines.map((line, i) => {
                const horizontal = Math.abs(line.y2 - line.y1) < 0.5;
                return (
                  <div
                    key={`l${i}`}
                    className="absolute"
                    style={
                      horizontal
                        ? {
                            left: Math.min(line.x1, line.x2) * previewScale,
                            // LLine y is PDF-space (bottom origin) — flip for CSS top
                            top: (pageH - line.y1) * previewScale,
                            width: Math.abs(line.x2 - line.x1) * previewScale,
                            height: Math.max(1, line.w * previewScale),
                            backgroundColor: line.color,
                          }
                        : {
                            left: line.x1 * previewScale,
                            top:
                              (pageH - Math.max(line.y1, line.y2)) *
                              previewScale,
                            width: Math.max(1, line.w * previewScale),
                            height: Math.abs(line.y2 - line.y1) * previewScale,
                            backgroundColor: line.color,
                          }
                    }
                  />
                );
              })}
              {page.pieces.map((piece, i) => (
                <PreviewPiece
                  key={`p${i}`}
                  piece={piece}
                  scale={previewScale}
                  pageH={pageH}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {exportPct !== null ? <ExportProgress pct={exportPct} t={t} /> : null}

      {exported ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-card p-3 text-sm text-foreground"
          role="status"
        >
          <CheckCircle2
            className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
            aria-hidden="true"
          />
          <span className="font-medium">{exported.name}</span>
          <span className="text-xs text-muted-foreground">
            {t("write.doneDetail", {
              pages: exported.pages ?? 1,
              words: exported.words ?? 0,
            })}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One editor row (block + hover controls)                             */
/* ------------------------------------------------------------------ */

function numberFor(blocks: WBlock[], index: number): number {
  const kind = blocks[index].kind;
  if (kind !== "numbered") return 0;
  let n = 1;
  for (let j = index - 1; j >= 0; j -= 1) {
    if (blocks[j].kind === "numbered") n += 1;
    else break;
  }
  return n;
}

function BlockRow(props: {
  block: WBlock;
  index: number;
  total: number;
  number: number;
  version: number;
  autoFocusToken?: number;
  t: (key: string, params?: Record<string, string | number>) => string;
  onInput: (blockId: string, element: HTMLDivElement) => void;
  onKeyDown: (blockId: string, event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onFocusBlock: (id: string) => void;
  onPatch: (
    blockId: string,
    patch:
      | Partial<Extract<WBlock, { runs: unknown[] }>>
      | { scale?: number; align?: WAlign }
  ) => void;
  onRemove: (blockId: string) => void;
  onDuplicate: (blockId: string) => void;
  onMove: (blockId: string, direction: -1 | 1) => void;
  onAddAfter: (kind: string) => void;
  onTable: (
    mutator: (
      rows: string[][],
      header: boolean
    ) => { rows: string[][]; header: boolean } | void
  ) => void;
  onPickImage: () => void;
  onReplaceImage: (key: string) => void;
  assetUrl: string | null;
}): JSX.Element {
  const { block, index, total, t } = props;
  const controls = (
    <RailControls
      onUp={() => props.onMove(block.id, -1)}
      onDown={() => props.onMove(block.id, 1)}
      onDuplicate={() => props.onDuplicate(block.id)}
      onDelete={() => props.onRemove(block.id)}
      t={t}
      first={index === 0}
      last={index === total - 1}
    />
  );

  if (block.kind === "hr") {
    return (
      <BlockShell controls={controls}>
        <hr className="my-3 border-0 border-t border-border" />
      </BlockShell>
    );
  }

  if (block.kind === "pagebreak") {
    return (
      <BlockShell controls={controls}>
        <div className="my-4 flex items-center gap-2" aria-label={t("write.blockBreak")}>
          <span className="h-px flex-1 border-t border-dashed border-border" />
          <span className="rounded-full bg-muted px-3 py-1 text-[11px] font-medium text-muted-foreground">
            {t("write.blockBreak")}
          </span>
          <span className="h-px flex-1 border-t border-dashed border-border" />
        </div>
      </BlockShell>
    );
  }

  if (block.kind === "table") {
    return (
      <BlockShell controls={controls}>
        <TableEditor
          rows={block.rows}
          header={block.header}
          onCell={(r, c, value) =>
            props.onTable((rows) => {
              if (rows[r]) rows[r][c] = value;
            })
          }
          onAddRow={() =>
            props.onTable((rows) => {
              rows.push(new Array(rows[0]?.length ?? 2).fill(""));
            })
          }
          onAddCol={() =>
            props.onTable((rows) => {
              for (const row of rows) row.push("");
            })
          }
          onDelRow={() =>
            props.onTable((rows, header) => {
              if (rows.length > (header ? 2 : 1)) rows.pop();
            })
          }
          onDelCol={() =>
            props.onTable((rows) => {
              if ((rows[0]?.length ?? 0) > 1) {
                for (const row of rows) row.pop();
              }
            })
          }
          onToggleHeader={(header) => props.onTable(() => ({ rows: block.rows, header }))}
          t={t}
        />
      </BlockShell>
    );
  }

  if (block.kind === "image") {
    return (
      <BlockShell
        controls={
          <>
            {controls}
            <button
              type="button"
              onClick={props.onReplaceImage.bind(null, block.assetKey)}
              className="rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {t("write.imageReplace")}
            </button>
          </>
        }
      >
        {props.assetUrl ? (
          <figure className="flex flex-col gap-2">
            <img
              src={props.assetUrl}
              alt={t("write.blockImage")}
              className="mx-auto max-w-full rounded-sm border border-border object-contain"
              style={{
                width: `${Math.round(block.scale * 100)}%`,
                ...(block.align === "center"
                  ? { marginInline: "auto" }
                  : block.align === "right"
                    ? { marginInline: "auto 0" }
                    : { marginInline: "0 auto" }),
              }}
            />
            <figcaption className="flex flex-wrap items-center justify-center gap-1">
              <Select
                value={String(block.scale)}
                onValueChange={(v) =>
                  props.onPatch(block.id, { scale: Number(v) })
                }
              >
                <SelectTrigger
                  className="h-8 w-20 rounded-btn text-xs"
                  aria-label={t("write.imageSize")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0.25">25%</SelectItem>
                  <SelectItem value="0.5">50%</SelectItem>
                  <SelectItem value="0.75">75%</SelectItem>
                  <SelectItem value="1">100%</SelectItem>
                </SelectContent>
              </Select>
            </figcaption>
          </figure>
        ) : (
          <button
            type="button"
            onClick={props.onPickImage}
            className="flex min-h-24 w-full items-center justify-center rounded-card border border-dashed border-border text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {t("write.imagePick")}
          </button>
        )}
      </BlockShell>
    );
  }

  // ---- text blocks ----
  const style = W_STYLES[block.kind];
  const size = block.kind === "p" && block.size !== undefined ? block.size : style.size;
  const isList = block.kind === "bullet" || block.kind === "numbered";
  const isQuote = block.kind === "quote";

  const editable = (
    <EditableText
      html={runsToHtml(block.runs)}
      version={props.version}
      placeholder={t("write.writeHere")}
      ariaLabel={t("write.blockLabel", { kind: t(`write.block${cap(block.kind)}`) })}
      autoFocusToken={props.autoFocusToken}
      className={isQuote ? "text-slate-600 dark:text-slate-300" : ""}
      style={{
        fontFamily: fontFamilyCss(block.family),
        fontSize: `${size}pt`,
        fontWeight: style.bold ? 700 : 400,
        fontStyle: style.italic ? "italic" : "normal",
        lineHeight: style.lineH,
        textAlign: block.align,
        marginTop: `${style.before}pt`,
        marginBottom: `${style.after}pt`,
        minHeight: `${size * style.lineH}pt`,
        textUnderlineOffset: "0.16em",
      }}
      onInput={(element) => props.onInput(block.id, element)}
      onKeyDown={(event) => props.onKeyDown(block.id, event)}
      onFocusBlock={() => props.onFocusBlock(block.id)}
    />
  );

  if (isList) {
    return (
      <BlockShell controls={controls}>
        <div className="flex" style={{ paddingLeft: "16pt" }}>
          <span
            aria-hidden="true"
            className="shrink-0 select-none"
            style={{
              width: "16pt",
              fontSize: `${size}pt`,
              lineHeight: style.lineH,
              marginTop: `${style.before}pt`,
              marginBottom: `${style.after}pt`,
              fontWeight: 400,
              textAlign: "right",
              paddingRight: "6pt",
            }}
          >
            {block.kind === "bullet" ? "•" : `${props.number}.`}
          </span>
          <div className="min-w-0 flex-1">{editable}</div>
        </div>
      </BlockShell>
    );
  }

  if (isQuote) {
    return (
      <BlockShell controls={controls}>
        <div
          className="border-l-[2.5pt] border-slate-400"
          style={{ paddingLeft: "10pt" }}
        >
          {editable}
        </div>
      </BlockShell>
    );
  }

  return <BlockShell controls={controls}>{editable}</BlockShell>;
}

function cap(kind: string): string {
  switch (kind) {
    case "p":
      return "P";
    case "h1":
      return "H1";
    case "h2":
      return "H2";
    case "h3":
      return "H3";
    case "bullet":
      return "Bullet";
    case "numbered":
      return "Numbered";
    default:
      return "Quote";
  }
}

/* ------------------------------------------------------------------ */
/* One preview text piece                                              */
/* ------------------------------------------------------------------ */

function PreviewPiece({
  piece,
  scale,
  pageH,
}: {
  piece: LPiece;
  scale: number;
  pageH: number;
}): JSX.Element {
  const top = (pageH - piece.baseline - piece.size * 0.8) * scale;
  return (
    <span
      className="absolute whitespace-pre"
      style={{
        left: piece.x * scale,
        top,
        fontSize: `${piece.size * scale}px`,
        lineHeight: `${piece.size * scale}px`,
        fontFamily: previewCssFamily(piece.spec.family, piece.script),
        fontWeight: piece.spec.bold ? 700 : 400,
        fontStyle: piece.spec.italic ? "italic" : "normal",
        ...(piece.script === "noto" ? { fontSynthesis: "none" as const } : {}),
        ...(piece.color !== undefined ? { color: piece.color } : {}),
      }}
    >
      {piece.text}
    </span>
  );
}

