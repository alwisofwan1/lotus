"use client";

import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleSlash,
  SignalHigh,
  SignalLow,
  SignalMedium,
  SignalZero,
} from "lucide-react";
import {
  statusLabel,
  statusTone,
  taskPriorityLabel,
  type StatusVocabulary,
} from "@/modules/tasks/services/task-vocabulary";
import type { BridgePriority, BridgeTaskStatus } from "@/modules/codespace/services/bridge/task-store";

/**
 * The two marks every row wears.
 *
 * Both carry their words as the accessible name rather than relying on shape alone: five circles
 * that differ by how much of the ring is drawn is a distinction the eye makes at a glance and a
 * screen reader cannot make at all.
 */

const STATUS_ICON: Record<BridgeTaskStatus, typeof Circle> = {
  todo: Circle,
  "in-progress": CircleDashed,
  // The same mark the detail panel already uses for a blocker line, so the two say one thing.
  blocked: CircleAlert,
  "in-review": CircleDot,
  complete: CircleCheck,
  cancelled: CircleSlash,
};

const TONE_ICON: Record<string, typeof Circle> = {
  open: Circle,
  progress: CircleDashed,
  blocked: CircleAlert,
  review: CircleDot,
  done: CircleCheck,
  dropped: CircleSlash,
};

export interface TaskGlyphProps {
  size?: number;
  /**
   * The words are already on screen beside it, so the glyph is decoration.
   *
   * Used by the section headers, which print their own label: without this a screen reader reads
   * "In Progress In Progress 1", which is how the rail's ask chip read before the same fix.
   */
  decorative?: boolean;
}

export function TaskStatusGlyph({
  status,
  vocabulary,
  size = 14,
  decorative = false,
}: TaskGlyphProps & { status: BridgeTaskStatus; vocabulary: StatusVocabulary }) {
  // An unknown status still draws — as an open circle, the most neutral of the five. The
  // vocabulary can grow in the store without a desktop release.
  // A source's own statuses ("In progress", "Ready for QA") are not Lotus's keys, so they are
  // drawn by their TONE: before this every Notion row drew the same open circle whatever its state.
  const Icon = STATUS_ICON[status] ?? TONE_ICON[statusTone(vocabulary, status)] ?? Circle;
  const label = statusLabel(vocabulary, status);
  return (
    <span
      className="tk-glyph"
      data-tone={statusTone(vocabulary, status)}
      title={label}
      aria-hidden={decorative || undefined}
    >
      <Icon size={size} strokeWidth={2} aria-hidden />
      {decorative ? null : <span className="sr-only">{label}</span>}
    </span>
  );
}

const PRIORITY_ICON: Record<BridgePriority, typeof SignalHigh> = {
  high: SignalHigh,
  medium: SignalMedium,
  low: SignalLow,
  none: SignalZero,
};

export function TaskPriorityGlyph({
  priority,
  size = 14,
  decorative = false,
}: TaskGlyphProps & { priority: BridgePriority }) {
  const Icon = PRIORITY_ICON[priority] ?? SignalZero;
  const label = PRIORITY_ICON[priority] ? taskPriorityLabel(priority) : priority;
  return (
    // `decorative` was accepted here and then ignored, so a menu item reading "High" beside this
    // glyph announced "High High" — the same doubling the rail's ask chip had, found again by a
    // test that asked for the item by its name.
    <span
      className="tk-glyph"
      data-priority={priority}
      title={decorative ? undefined : label}
      aria-hidden={decorative || undefined}
    >
      <Icon size={size} strokeWidth={2} aria-hidden />
      {decorative ? null : <span className="sr-only">{label}</span>}
    </span>
  );
}
