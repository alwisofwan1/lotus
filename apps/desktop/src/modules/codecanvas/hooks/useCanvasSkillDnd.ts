"use client";
import { useCallback, useState } from "react";
import {
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  pointerWithin,
  type DragStartEvent,
  type DragEndEvent,
  type CollisionDetection,
} from "@dnd-kit/core";

export const SKILL_DRAG_PREFIX = "skill:";
export const TERM_DROP_PREFIX = "term:";
export const AGENT_DROP_PREFIX = "agent:";

export interface DraggedSkill {
  name: string;
  source: "project" | "global";
  content: string;
  /** Absolute path to the skill's SKILL.md — referenced when applying to non-Claude runners (ADR-0027 Phase 6a). */
  path?: string;
}

/** Drag data attached to draggable skill rows. Read off `event.active.data`. */
export type SkillDragData = { skill: DraggedSkill };

/** Which kind of node a skill was dropped onto — a PTY terminal or a headless agent. */
export type SkillDropTargetKind = "terminal" | "agent";

export type SkillDropResolution =
  | { kind: "none" }
  | { kind: "skill-drop"; targetKind: SkillDropTargetKind; targetId: string; skillName: string; skill: DraggedSkill };

function targetFromOverId(overId: string): { kind: SkillDropTargetKind; id: string } | null {
  if (overId.startsWith(TERM_DROP_PREFIX)) return { kind: "terminal", id: overId.slice(TERM_DROP_PREFIX.length) };
  if (overId.startsWith(AGENT_DROP_PREFIX)) return { kind: "agent", id: overId.slice(AGENT_DROP_PREFIX.length) };
  return null;
}

/**
 * Pure helper — decide what a drag end means. Centralised so it can be unit-tested
 * independently of dnd-kit / React. Mirrors `resolveTaskDrop` in codespace.
 */
export function resolveSkillDrop(
  activeId: string | null,
  overId: string | null,
  activeData: unknown,
): SkillDropResolution {
  if (!activeId || !overId) return { kind: "none" };
  if (!activeId.startsWith(SKILL_DRAG_PREFIX)) return { kind: "none" };
  const target = targetFromOverId(overId);
  const skill = (activeData as SkillDragData | undefined)?.skill;
  if (!target?.id || !skill) return { kind: "none" };
  return { kind: "skill-drop", targetKind: target.kind, targetId: target.id, skillName: skill.name, skill };
}

export interface UseCanvasSkillDndOptions {
  onSkillDrop?: (targetKind: SkillDropTargetKind, targetId: string, skill: DraggedSkill) => void;
}

export interface UseCanvasSkillDndResult {
  sensors: ReturnType<typeof useSensors>;
  collisionDetection: CollisionDetection;
  /** The skill being dragged (for the DragOverlay chip), or null. */
  activeSkill: DraggedSkill | null;
  onDragStart: (event: DragStartEvent) => void;
  onDragEnd: (event: DragEndEvent) => void;
  onDragCancel: () => void;
}

export function useCanvasSkillDnd({ onSkillDrop }: UseCanvasSkillDndOptions = {}): UseCanvasSkillDndResult {
  const [activeSkill, setActiveSkill] = useState<DraggedSkill | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const onDragStart = useCallback((event: DragStartEvent) => {
    const id = String(event.active.id);
    if (!id.startsWith(SKILL_DRAG_PREFIX)) return;
    setActiveSkill((event.active.data.current as SkillDragData | undefined)?.skill ?? null);
  }, []);

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveSkill(null);
      const resolution = resolveSkillDrop(
        String(event.active.id),
        event.over ? String(event.over.id) : null,
        event.active.data.current,
      );
      if (resolution.kind === "skill-drop") onSkillDrop?.(resolution.targetKind, resolution.targetId, resolution.skill);
    },
    [onSkillDrop],
  );

  const onDragCancel = useCallback(() => setActiveSkill(null), []);

  return { sensors, collisionDetection: pointerWithin, activeSkill, onDragStart, onDragEnd, onDragCancel };
}
