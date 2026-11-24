import { FRAME_COLORS, type CodeFrame, type FrameColor, type WorkspacePaneLayout } from "@/modules/codespace/components/types";
import {
  closeTerminalV2LayoutPane,
  createTerminalV2LayoutWithPane,
  getTerminalV2LayoutPaneIds,
  hasTerminalV2LayoutPane,
  sanitizeTerminalV2LayoutTree,
  splitTerminalV2LayoutPane,
  type TerminalV2LayoutDirection,
  type TerminalV2LayoutNode,
  type TerminalV2LayoutTree,
} from "@/modules/codespace/terminal-v2/layout/terminal-v2-layout-tree";
import { reconcileLayoutWithPanes } from "@/modules/workspace-shell/services/layout-reconcile";
import { balancedPaneLayout } from "@/modules/workspace-shell/services/pane-arrangement";

/**
 * Frame rules for a Code workspace (plans/code-frames/SPEC.md). Pure: everything the rail and the
 * shell do with Frames goes through here.
 */

/**
 * The one-time move from "a workspace is one screen" to Frames: 2+ panes become one Frame named
 * after the workspace, in the layout they already had; a single pane stays loose.
 *
 * Guarded by `framesMigrated`, not by "has no Frames", so a migrated Frame the user deleted stays deleted.
 */
export function migrateFrames(
  layout: WorkspacePaneLayout,
  paneIds: string[],
  legacy: { name: string; color: FrameColor; now: number; newId: () => string },
): WorkspacePaneLayout {
  if (layout.framesMigrated) return layout;
  const frames: CodeFrame[] = paneIds.length >= 2
    ? [{
        id: legacy.newId(),
        name: legacy.name,
        color: legacy.color,
        createdAt: legacy.now,
        paneIds: [...paneIds],
        layout: reconcileLayoutWithPanes(layout.terminalV2Layout, paneIds),
      }]
    : [];
  return { ...layout, frames: [...(layout.frames ?? []), ...frames], framesMigrated: true };
}

/**
 * A Frame with no name is a split: made by opening a pane beside a loose one, never named first,
 * and gone once one pane is left (that pane is loose again). Naming it makes it a Frame that stays.
 */
export const isSplit = (frame: Pick<CodeFrame, "name">) => frame.name === "";

/**
 * Keep Frames true to the panes that exist: a closed pane leaves its Frame and that Frame's
 * layout (the other seams keep their sizes), an emptied Frame stays unless it is a split, and a
 * pane claimed by two Frames stays in the first. Returns the same array when nothing changed.
 */
export function reconcileFrames(frames: CodeFrame[], livePaneIds: readonly string[]): CodeFrame[] {
  const live = new Set(livePaneIds);
  const claimed = new Set<string>();
  let changed = false;
  const next = frames.map((frame) => {
    const paneIds = frame.paneIds.filter((paneId) => live.has(paneId) && !claimed.has(paneId));
    paneIds.forEach((paneId) => claimed.add(paneId));
    if (isSplit(frame) && paneIds.length < 2) {
      changed = true;
      return null;
    }
    const layout = frameLayout(frame, paneIds);
    if (paneIds.length === frame.paneIds.length && layout === frame.layout) return frame;
    changed = true;
    return { ...frame, paneIds, layout };
  });
  return changed ? next.filter((frame): frame is CodeFrame => frame !== null) : frames;
}

function frameLayout(frame: CodeFrame, paneIds: string[]): CodeFrame["layout"] {
  if (paneIds.length === 0) return null;
  let layout = frame.layout;
  // Prune leaf by leaf, so the seams that stay keep the sizes someone dragged them to.
  for (const leaf of layout?.root ? getTerminalV2LayoutPaneIds(layout.root) : []) {
    if (layout && !paneIds.includes(leaf)) layout = closeTerminalV2LayoutPane(layout, leaf);
  }
  return reconcileLayoutWithPanes(layout, paneIds);
}

/**
 * Frames read back from disk: malformed entries are dropped, an unknown colour falls back to the
 * first, and the result is reconciled against the panes that loaded.
 */
export function sanitizeFrames(raw: unknown, livePaneIds: readonly string[]): CodeFrame[] {
  if (!Array.isArray(raw)) return [];
  const frames = raw.flatMap((entry): CodeFrame[] => {
    if (!entry || typeof entry !== "object") return [];
    const { id, name, color, createdAt, paneIds, layout } = entry as Record<string, unknown>;
    if (typeof id !== "string" || typeof name !== "string" || !Array.isArray(paneIds)) return [];
    const members = paneIds.filter((paneId): paneId is string => typeof paneId === "string");
    return [{
      id,
      name,
      color: FRAME_COLORS.includes(color as FrameColor) ? (color as FrameColor) : FRAME_COLORS[0],
      createdAt: typeof createdAt === "number" ? createdAt : 0,
      paneIds: members,
      layout: sanitizeTerminalV2LayoutTree(layout, members),
    }];
  });
  return reconcileFrames(frames, livePaneIds);
}

/** A new, empty Frame, in the next palette colour so neighbours differ without anyone choosing. */
export function createFrame(
  frames: CodeFrame[],
  init: { name: string; now: number; newId: () => string },
): CodeFrame[] {
  const color = FRAME_COLORS[frames.length % FRAME_COLORS.length];
  return [...frames, { id: init.newId(), name: init.name, color, createdAt: init.now, paneIds: [], layout: null }];
}

/** Rename a Frame. An empty or unchanged name is no rename: the same array comes back. */
export function renameFrame(frames: CodeFrame[], frameId: string, name: string): CodeFrame[] {
  const next = name.trim();
  const target = frames.find((frame) => frame.id === frameId);
  if (!target || !next || next === target.name) return frames;
  return frames.map((frame) => (frame.id === frameId ? { ...frame, name: next } : frame));
}

/** Recolour a Frame. Its own colour again is no change: the same array comes back. */
export function recolorFrame(frames: CodeFrame[], frameId: string, color: FrameColor): CodeFrame[] {
  if (!frames.some((frame) => frame.id === frameId && frame.color !== color)) return frames;
  return frames.map((frame) => (frame.id === frameId ? { ...frame, color } : frame));
}

export type DeletedFrame = { frame: CodeFrame; index: number };

/**
 * Delete a Frame and nothing else: its panes keep running and, in no Frame now, list as loose.
 * `deleted` is what an Undo hands to `restoreFrame`.
 */
export function deleteFrame(frames: CodeFrame[], frameId: string): { frames: CodeFrame[]; deleted: DeletedFrame | null } {
  const index = frames.findIndex((frame) => frame.id === frameId);
  if (index < 0) return { frames, deleted: null };
  return { frames: frames.filter((_, i) => i !== index), deleted: { frame: frames[index], index } };
}

/**
 * Undo a delete: the Frame comes back in its place, with its members and layout. A member that
 * joined another Frame since comes back too (the Undo is the newer wish); a closed one is dropped
 * by the next reconcile.
 */
export function restoreFrame(frames: CodeFrame[], { frame, index }: DeletedFrame): CodeFrame[] {
  const others = frames
    .filter((other) => other.id !== frame.id)
    .map((other) => {
      if (!other.paneIds.some((paneId) => frame.paneIds.includes(paneId))) return other;
      const paneIds = other.paneIds.filter((paneId) => !frame.paneIds.includes(paneId));
      return { ...other, paneIds, layout: frameLayout(other, paneIds) };
    });
  return [...others.slice(0, index), frame, ...others.slice(index)];
}

/** What the screen shows, as far as a new pane cares: a Frame, a loose pane, or nothing to join. */
export type ScreenTarget = { frameId: string } | { paneId: string } | null;

/**
 * Where newly opened panes go: into the Frame on screen; beside a loose pane on screen, into a new
 * split with it; else nowhere (loose). Returns the same array when nothing joined.
 * shortcut: the spawning-pane branch (an agent's pane joins its spawner's Frame) lands in #319.
 */
export function placeNewPanes(
  frames: CodeFrame[],
  known: ReadonlySet<string>,
  paneIds: readonly string[],
  screen: ScreenTarget,
  directionFor: (targetFrame: CodeFrame | undefined) => TerminalV2LayoutDirection,
  init: { now: number; newId: () => string },
  /** The pane that asked for a new pane (an agent's spawn): it joins that pane's Frame first, on screen or not. */
  spawnerOf?: (paneId: string) => string | undefined,
): CodeFrame[] {
  const placed = spawnerOf ? joinSpawnersFrames(frames, known, paneIds, spawnerOf, directionFor) : frames;
  if (screen && "frameId" in screen) return assignNewPanes(placed, known, paneIds, screen.frameId, directionFor);
  const loose = screen?.paneId;
  if (!loose || frameOfPane(placed, loose) || !paneIds.some((paneId) => paneId !== loose && !known.has(paneId) && !frameOfPane(placed, paneId))) return placed;
  const split: CodeFrame = {
    id: init.newId(),
    name: "",
    color: FRAME_COLORS[frames.length % FRAME_COLORS.length],
    createdAt: init.now,
    paneIds: [loose],
    layout: createTerminalV2LayoutWithPane(loose),
  };
  const withSplit = [...placed, split];
  const next = assignNewPanes(withSplit, new Set([...known, loose]), paneIds, split.id, directionFor);
  return next === withSplit ? placed : next;
}

/** #319: each new pane whose spawner sits in a Frame (a group or a split) joins that Frame. */
function joinSpawnersFrames(
  frames: CodeFrame[],
  known: ReadonlySet<string>,
  paneIds: readonly string[],
  spawnerOf: (paneId: string) => string | undefined,
  directionFor: (targetFrame: CodeFrame | undefined) => TerminalV2LayoutDirection,
): CodeFrame[] {
  return paneIds.reduce((next, paneId) => {
    if (known.has(paneId)) return next;
    const spawner = spawnerOf(paneId);
    const home = spawner ? frameOfPane(next, spawner) : null;
    return home ? assignNewPanes(next, known, [paneId], home.id, directionFor) : next;
  }, frames);
}

/** Take a pane out of its Frame: it is loose again, and a split it leaves with one pane dissolves. */
export function takePaneOut(frames: CodeFrame[], paneId: string): CodeFrame[] {
  return reconcileFrames(frames, frames.flatMap((frame) => frame.paneIds).filter((id) => id !== paneId));
}

/**
 * Panes born since the last look join the target Frame. A known pane, or one already in a Frame,
 * stays put. Returns the same array when nothing joined.
 */
export function assignNewPanes(
  frames: CodeFrame[],
  known: ReadonlySet<string>,
  paneIds: readonly string[],
  targetFrameId: string,
  directionFor: (targetFrame: CodeFrame | undefined) => TerminalV2LayoutDirection,
): CodeFrame[] {
  const fresh = paneIds.filter((paneId) => !known.has(paneId) && !frameOfPane(frames, paneId));
  const targetFrame = frames.find((frame) => frame.id === targetFrameId);
  if (!fresh.length || !targetFrame) return frames;
  if (fresh.length === 1) return addPaneToFrame(frames, targetFrameId, fresh[0], directionFor(targetFrame));

  // A squad: one balanced block beside the active pane, not a chain where each new pane halves
  // the last. The Frame's other seams keep their sizes.
  const block = balancedPaneLayout(fresh, fresh[0]);
  const root = targetFrame.layout?.root;
  const anchor = targetFrame.layout?.activePaneId ?? targetFrame.paneIds.at(-1);
  const layout: TerminalV2LayoutTree = root && anchor && hasTerminalV2LayoutPane(root, anchor)
    ? { root: graftBeside(root, anchor, block.root!, directionFor(targetFrame)), activePaneId: fresh[0] }
    : block;
  return frames.map((frame) => (frame.id === targetFrameId ? { ...frame, paneIds: [...frame.paneIds, ...fresh], layout } : frame));
}

/** Replace one leaf with a split of [that leaf, the block], halves each. */
function graftBeside(
  node: TerminalV2LayoutNode,
  paneId: string,
  block: TerminalV2LayoutNode,
  direction: TerminalV2LayoutDirection,
): TerminalV2LayoutNode {
  if (node.kind === "leaf") {
    return node.paneId === paneId ? { kind: "split", direction, children: [node, block], sizes: [50, 50] } : node;
  }
  return { ...node, children: node.children.map((child) => graftBeside(child, paneId, block, direction)) };
}

/**
 * Put a pane in a Frame, beside that Frame's active pane. It leaves any other Frame first, so a
 * pane is never in two.
 */
export function addPaneToFrame(
  frames: CodeFrame[],
  frameId: string,
  paneId: string,
  direction: TerminalV2LayoutDirection,
): CodeFrame[] {
  return frames.map((frame) => {
    if (frame.id !== frameId) {
      if (!frame.paneIds.includes(paneId)) return frame;
      const paneIds = frame.paneIds.filter((id) => id !== paneId);
      return { ...frame, paneIds, layout: paneIds.length && frame.layout ? closeTerminalV2LayoutPane(frame.layout, paneId) : null };
    }
    if (frame.paneIds.includes(paneId)) return frame;
    const layout = frame.layout?.root
      ? splitTerminalV2LayoutPane(frame.layout, frame.layout.activePaneId ?? frame.paneIds.at(-1) ?? "", paneId, direction)
      : createTerminalV2LayoutWithPane(paneId);
    return { ...frame, paneIds: [...frame.paneIds, paneId], layout };
  });
}

/**
 * Make `paneId` its Frame's active pane, so the next new pane splits beside it. Focus never writes
 * a Frame's `activePaneId`, so without this a split lands beside whichever pane was born last.
 */
export function anchorFramesAt(frames: CodeFrame[], paneId: string | null): CodeFrame[] {
  if (!paneId || !frames.some((frame) => frame.layout && frame.paneIds.includes(paneId) && frame.layout.activePaneId !== paneId)) return frames;
  return frames.map((frame) =>
    frame.layout && frame.paneIds.includes(paneId) ? { ...frame, layout: { ...frame.layout, activePaneId: paneId } } : frame,
  );
}

/** Give one Frame a new split (a seam drag, a tidy); the others are untouched. */
export function setFrameLayout(frames: CodeFrame[], frameId: string, layout: CodeFrame["layout"]): CodeFrame[] {
  return frames.map((frame) => (frame.id === frameId ? { ...frame, layout } : frame));
}

/** The Frame a pane belongs to, if any. */
export function frameOfPane(frames: readonly CodeFrame[], paneId: string): CodeFrame | null {
  return frames.find((frame) => frame.paneIds.includes(paneId)) ?? null;
}
