"use client";

export type DropPosition = "before" | "after";

type Identifiable = {
  id: string;
};

export function reorderItemsByDropPosition<T extends Identifiable>(
  items: readonly T[],
  draggedId: string,
  targetId: string,
  position: DropPosition,
): T[] {
  if (draggedId === targetId) {
    return [...items];
  }

  const draggedIndex = items.findIndex((item) => item.id === draggedId);
  const targetIndex = items.findIndex((item) => item.id === targetId);
  if (draggedIndex < 0 || targetIndex < 0) {
    return [...items];
  }

  const next = [...items];
  const [draggedItem] = next.splice(draggedIndex, 1);
  const adjustedTargetIndex = next.findIndex((item) => item.id === targetId);
  const insertIndex = adjustedTargetIndex + (position === "after" ? 1 : 0);
  next.splice(insertIndex, 0, draggedItem);
  return next;
}
