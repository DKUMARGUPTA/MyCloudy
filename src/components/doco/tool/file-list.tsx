"use client";

import type { DragEndEvent } from "@dnd-kit/core";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement } from "@dnd-kit/modifiers";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import { FileCard, type WorkspaceFile } from "./file-card";
import { cn } from "@/lib/utils";

/**
 * Sortable file grid (PRD §8.1 Merge preview / §6.3 workspace):
 * drag-to-reorder with a dedicated grip handle (mouse + touch long-press,
 * 200 ms) and full keyboard support (Tab to the grip, Space to lift,
 * arrows to move, Space to drop, Esc to cancel — announcements provided
 * by dnd-kit's live region). The up/down buttons on each card remain as
 * the always-available keyboard path.
 */

interface FileListProps {
  items: WorkspaceFile[];
  onMove: (from: number, to: number) => void;
  onRemove: (id: string) => void;
}

export function FileList({ items, onMove, onRemove }: FileListProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = items.findIndex((item) => item.id === active.id);
    const to = items.findIndex((item) => item.id === over.id);
    if (from < 0 || to < 0) return;
    onMove(from, to);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToParentElement]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={items.map((item) => item.id)}
        strategy={rectSortingStrategy}
      >
        <ul className="grid list-none gap-3 sm:grid-cols-2">
          {items.map((item, index) => (
            <SortableFileCard
              key={item.id}
              item={item}
              index={index}
              total={items.length}
              onMove={onMove}
              onRemove={onRemove}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

function SortableFileCard({
  item,
  index,
  total,
  onMove,
  onRemove,
}: {
  item: WorkspaceFile;
  index: number;
  total: number;
  onMove: (from: number, to: number) => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useI18n();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: item.id });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "relative list-none",
        isDragging && "z-20",
        isOver && !isDragging && "ring-2 ring-primary/40 rounded-card"
      )}
    >
      <div
        className={cn(
          "rounded-card transition-shadow",
          isDragging && "shadow-lg scale-[1.02]"
        )}
      >
        <FileCard
          item={item}
          index={index}
          total={total}
          onMove={onMove}
          onRemove={onRemove}
        />
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={t("tool.dragHandleLabel", { name: item.file.name })}
          className={cn(
            "absolute right-2 top-2 z-10 flex size-9 items-center justify-center rounded-btn text-muted-foreground/60 outline-none transition-colors",
            "cursor-grab touch-none hover:bg-accent hover:text-foreground active:cursor-grabbing",
            "focus-visible:ring-[3px] focus-visible:ring-ring/50",
            isDragging && "bg-accent text-foreground"
          )}
        >
          <GripVertical className="size-4" aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}
