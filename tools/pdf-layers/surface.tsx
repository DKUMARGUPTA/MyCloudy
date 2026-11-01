"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Layers,
  Loader2,
  Lock,
  Plus,
  RotateCcw,
  TriangleAlert,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/components/providers/locale-provider";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { readLayers, type LayerNode } from "./engine";
import { cn } from "@/lib/utils";
import { PreviewFileHeader } from "../stamp-common/preview-parts";

/**
 * PDF layers surface (PHASE-3 batch 4) — the OCG tree editor.
 *
 * The probe uses OUR OWN parser (readLayers — no pdf.js, no network):
 * the /Order display tree loads with per-layer visibility + locked
 * state; the user toggles checkboxes, adds top-level or child layers,
 * deletes stale ones; the ops serialize to the "ops" option and the
 * worker re-validates everything (object-number keyed).
 */

const PL_IDS = { ops: "ops" } as const;
const MAX_LAYERS = 200;
const MAX_NAME = 120;

type ProbeStatus = "working" | "done" | "error";

interface ProbeState {
  file: File;
  status: ProbeStatus;
  pageCount: number;
}

/** Flatten the tree for rendering (depth-driven indent). */
interface FlatRow {
  node: LayerNode;
  /** Original tree node for child-add targeting. */
  key: string;
}

function flatten(tree: LayerNode[], prefix: string, out: FlatRow[]): void {
  for (let i = 0; i < tree.length; i += 1) {
    const node = tree[i]!;
    const key = `${prefix}/${i}`;
    out.push({ node, key });
    flatten(node.children, key, out);
  }
}

export function PdfLayersSurface({
  files,
  onChange,
  setFileOrder,
  setRunBlocked,
}: ToolSurfaceProps): React.JSX.Element | null {
  const { t } = useI18n();
  const fileMeta = files[0];
  const file = fileMeta?.file ?? null;

  const [probe, setProbe] = useState<ProbeState | null>(null);
  /** The pristine tree straight from the probe (for resets). */
  const [baseline, setBaseline] = useState<LayerNode[]>([]);
  /** Live working copy (toggles + pending adds rendered optimistically). */
  const [tree, setTree] = useState<LayerNode[]>([]);
  const [newName, setNewName] = useState("");
  const [addParent, setAddParent] = useState<number | null>(null);
  const [deleted, setDeleted] = useState<Set<number>>(new Set());
  const probeSeq = useRef(0);

  /* ---------------- probe: read the OCG tree (own parser) ---------------- */

  useEffect(() => {
    if (!file) return;
    const seq = ++probeSeq.current;

    void (async () => {
      // Reset first (microtask — never synchronously in the effect body).
      await Promise.resolve();
      if (seq !== probeSeq.current) return;
      setProbe({ file, status: "working", pageCount: 0 });
      setTree([]);
      setBaseline([]);
      setDeleted(new Set());
      try {
        const { readLayers: read } = await import("./engine");
        const { parsePdf, catalogDict } = await import("@/lib/own/pdf");
        const bytes = new Uint8Array(await file.arrayBuffer());
        const doc = parsePdf(bytes);
        const catalog = catalogDict(doc);
        const pagesObj = catalog?.get("Pages");
        const pages =
          pagesObj?.k === "ref"
            ? (doc.getObject(pagesObj.num) as { m?: Map<string, unknown> })
            : undefined;
        const count = Number(pages?.m?.get("Count") ?? 0);
        const layerDoc = read(bytes);
        if (seq !== probeSeq.current) return;
        setBaseline(structuredClone(layerDoc.tree));
        setTree(layerDoc.tree);
        setProbe({
          file,
          status: "done",
          pageCount: Number.isFinite(count) ? count : 0,
        });
      } catch {
        if (seq !== probeSeq.current) return;
        setProbe({ file, status: "error", pageCount: 0 });
      }
    })();

    return () => {
      // cancelled via seq bump
    };
  }, [file]);

  const activeProbe = probe !== null && probe.file === file ? probe : null;
  const busy = activeProbe?.status === "working";
  const probeError = activeProbe?.status === "error";
  const pageCount = activeProbe?.pageCount ?? 0;

  const removeFile = useCallback((): void => {
    setFileOrder([]);
  }, [setFileOrder]);

  /* ---------------- ops derivation + run gating ---------------- */

  const dirty = useMemo(() => {
    // Any visibility diff vs baseline, pending adds, or deletes.
    const diffs: number[] = [];
    const walk = (before: LayerNode[], after: LayerNode[]): void => {
      if (before.length !== after.length) {
        // adds change lengths — handled by adds count below
      }
      for (let i = 0; i < Math.min(before.length, after.length); i += 1) {
        const b = before[i]!;
        const a = after[i]!;
        if (a.num === b.num && a.visible !== b.visible) diffs.push(a.num);
        walk(b.children, a.children);
      }
    };
    walk(baseline, tree);
    const addsCount = countNodes(tree) - countNodes(baseline);
    return diffs.length > 0 || addsCount > 0 || deleted.size > 0;
  }, [baseline, tree, deleted]);

  useEffect(() => {
    if (!dirty) {
      onChange(PL_IDS.ops, "");
      return;
    }
    const toggles: Array<{ num: number; visible: boolean }> = [];
    const adds: Array<{ name: string; parent?: number }> = [];
    const walkDiff = (before: LayerNode[], after: LayerNode[]): void => {
      for (let i = 0; i < after.length; i += 1) {
        const a = after[i]!;
        const b = before[i];
        if (b !== undefined && b.num === a.num) {
          if (a.visible !== b.visible && !deleted.has(a.num)) {
            toggles.push({ num: a.num, visible: a.visible });
          }
          walkDiff(b.children, a.children);
        } else {
          // New node at this position — a pending add.
          collectAdds(a, adds);
        }
      }
    };
    const collectAdds = (node: LayerNode, out: Array<{ name: string; parent?: number }>): void => {
      addsPending.push(node);
    };
    const addsPending: LayerNode[] = [];
    walkDiff(baseline, tree);
    for (const n of addsPending) {
      const parent = findParentNum(baseline, tree, n);
      adds.push({ name: n.name, ...(parent !== null ? { parent } : {}) });
    }
    onChange(
      PL_IDS.ops,
      JSON.stringify({
        v: 1,
        toggles,
        adds,
        deletes: Array.from(deleted),
      })
    );
  }, [tree, baseline, deleted, dirty, onChange]);

  const blockedKey =
    activeProbe === null || probeError
      ? null
      : !dirty
        ? "pl.ctaNothing"
        : null;
  useEffect(() => {
    setRunBlocked(blockedKey);
    return () => setRunBlocked(null);
  }, [blockedKey, setRunBlocked]);

  /* ---------------- tree operations ---------------- */

  const toggleVisible = (key: string): void => {
    setTree((prev) => mutateAt(prev, key, (node) => ({ ...node, visible: !node.visible })));
  };

  const markDelete = (key: string, num: number): void => {
    setDeleted((prev) => new Set(prev).add(num));
    setTree((prev) => removeAt(prev, key));
  };

  const restoreAll = (): void => {
    setBaseline((base) => {
      setTree(structuredClone(base));
      return base;
    });
    setDeleted(new Set());
    setNewName("");
    setAddParent(null);
  };

  const addLayer = (): void => {
    const name = newName.trim().slice(0, MAX_NAME);
    if (name.length === 0) return;
    const total = countNodes(tree);
    if (total >= MAX_LAYERS) return;
    const node: LayerNode = {
      num: -Date.now() % 1_000_000, // negative = pending (worker re-numbers)
      name,
      visible: true,
      locked: false,
      depth: 0,
      children: [],
    };
    if (addParent !== null) {
      setTree((prev) => attachChild(prev, addParent, node));
    } else {
      setTree((prev) => [...prev, node]);
    }
    setNewName("");
  };

  const rows = useMemo(() => {
    const out: FlatRow[] = [];
    flatten(tree, "", out);
    return out;
  }, [tree]);

  /* ---------------- render ---------------- */

  if (!file) return null;

  const layerCount = countNodes(tree);

  return (
    <section aria-label={t("pl.surfaceLabel")} className="space-y-3">
      <PreviewFileHeader file={file} pageCount={pageCount} onRemove={removeFile} />

      {busy ? (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-4 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t("pl.reading")}
        </div>
      ) : probeError ? (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-4 py-4 text-sm text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t("pl.probeError")}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {t("pl.countChip", {
                count: String(layerCount),
                visible: String(rows.filter((r) => r.node.visible).length),
              })}
            </p>
            <button
              type="button"
              onClick={restoreAll}
              disabled={!dirty}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              {t("pl.restoreAll")}
            </button>
          </div>

          {rows.length === 0 ? (
            <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-4 py-4 text-sm text-muted-foreground">
              <Layers className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {t("pl.emptyTree")}
            </div>
          ) : (
            <ul className="max-h-96 space-y-1.5 overflow-y-auto pr-1">
              {rows.map(({ node, key }) => {
                const isPending = node.num < 0;
                return (
                  <li
                    key={key}
                    className={cn(
                      "flex items-center gap-2 rounded-lg border border-border bg-background p-2",
                      isPending && "border-dashed"
                    )}
                    style={{ marginLeft: `${Math.min(node.depth, 5) * 18}px` }}
                  >
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={node.visible}
                        disabled={node.locked}
                        onChange={() => toggleVisible(key)}
                        aria-label={t("pl.toggleLabel", { name: node.name })}
                        className="size-4 accent-[var(--primary)]"
                      />
                      <span className="truncate text-sm" title={node.name}>
                        {node.name}
                      </span>
                      {node.locked ? (
                        <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-label={t("pl.lockedLabel")} />
                      ) : null}
                      {isPending ? (
                        <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                          {t("pl.pendingChip")}
                        </span>
                      ) : null}
                    </label>
                    <button
                      type="button"
                      onClick={() => markDelete(key, node.num)}
                      aria-label={t("pl.deleteLabel", { name: node.name })}
                      className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 p-2.5">
            <Input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addLayer();
              }}
              placeholder={t("pl.newNamePlaceholder")}
              aria-label={t("pl.newNameLabel")}
              maxLength={MAX_NAME}
              className="h-8 min-w-0 flex-1 text-sm"
            />
            <select
              value={addParent === null ? "" : String(addParent)}
              onChange={(event) =>
                setAddParent(event.target.value === "" ? null : Number(event.target.value))
              }
              aria-label={t("pl.parentLabel")}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            >
              <option value="">{t("pl.parentTop")}</option>
              {rows
                .filter((r) => r.node.num > 0)
                .map((r) => (
                  <option key={r.key} value={String(r.node.num)}>
                    {t("pl.parentUnder", { name: r.node.name })}
                  </option>
                ))}
            </select>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={addLayer}
              disabled={newName.trim().length === 0 || layerCount >= MAX_LAYERS}
              className="h-8 shrink-0"
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {t("pl.add")}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

/* ---------------- pure tree helpers ---------------- */

function countNodes(nodes: LayerNode[]): number {
  let total = 0;
  for (const node of nodes) {
    total += 1 + countNodes(node.children);
  }
  return total;
}

function mutateAt(
  nodes: LayerNode[],
  key: string,
  fn: (node: LayerNode) => LayerNode
): LayerNode[] {
  const [head, ...rest] = key.split("/").filter(Boolean);
  if (head === undefined) return nodes;
  const index = Number(head);
  return nodes.map((node, i) => {
    if (i !== index) return node;
    if (rest.length === 0) return fn(node);
    return { ...node, children: mutateAt(node.children, `/${rest.join("/")}`, fn) };
  });
}

function removeAt(nodes: LayerNode[], key: string): LayerNode[] {
  const [head, ...rest] = key.split("/").filter(Boolean);
  if (head === undefined) return nodes;
  const index = Number(head);
  const out: LayerNode[] = [];
  nodes.forEach((node, i) => {
    if (i === index && rest.length === 0) return; // drop
    if (i === index) {
      out.push({ ...node, children: removeAt(node.children, `/${rest.join("/")}`) });
      return;
    }
    out.push(node);
  });
  return out;
}

function attachChild(nodes: LayerNode[], parentNum: number, child: LayerNode): LayerNode[] {
  return nodes.map((node) => {
    if (node.num === parentNum) {
      return {
        ...node,
        children: [...node.children, { ...child, depth: node.depth + 1 }],
      };
    }
    if (node.children.length > 0) {
      return { ...node, children: attachChild(node.children, parentNum, child) };
    }
    return node;
  });
}

/** Find a pending node's parent object number (null = top level). */
function findParentNum(
  baseline: LayerNode[],
  tree: LayerNode[],
  target: LayerNode
): number | null {
  let found: number | null = null;
  const walk = (nodes: LayerNode[], parentNum: number | null): void => {
    for (const node of nodes) {
      if (node.num === target.num && node.name === target.name) {
        found = parentNum;
        return;
      }
      walk(node.children, node.num > 0 ? node.num : parentNum);
    }
  };
  walk(tree, null);
  void baseline;
  return found;
}
