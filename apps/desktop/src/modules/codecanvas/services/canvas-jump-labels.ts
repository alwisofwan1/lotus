import { rectsIntersect } from "./voice/agent-done-callout";

/**
 * Jump labels: a letter badge on every cell, type it to go there
 * (`plans/codecanvas-hotkeys/` S7, deferred at the time and shipped now).
 *
 * The `jump-labels` command has been in the hotkey registry on `f` since that plan, listed in
 * Settings → Hotkeys as a rebindable row, with **no handler anywhere**. The chord resolved and
 * nothing happened. `useCanvasHotkeys` returns before `preventDefault` when a command has no handler,
 * so the key was not even swallowed — it was simply a promise the settings panel kept making and the
 * canvas never kept.
 *
 * Pure throughout: assignment is a table, visibility is a rect test, matching is a lookup. So the
 * awkward parts — uniform label width, prefix versus hit, a cell half off the edge — are all
 * testable without a canvas or a keyboard.
 */

/**
 * Home row, left to right.
 *
 * Chosen for the fingers, not to dodge collisions. Several of these letters are tool shortcuts
 * (`a` arrow, `d` diamond, `l` line, `h` pan), and no alphabet could avoid them all — ten bare
 * letters already belong to the whiteboard. What makes it safe is that the mode captures keys while
 * it is open, and `resolveToolShortcut` is told to stand down.
 */
export const JUMP_LABEL_ALPHABET = "asdfghjkl";

/** Where a cell sits on screen, in the shape {@link rectsIntersect} takes. */
interface ScreenBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Which cells are actually on screen, in the order given.
 *
 * Labels used to go to EVERY tiled node, and the alphabet is a scarce resource: cells parked
 * off-viewport consumed single letters, so the ones the operator could see were pushed to two-letter
 * labels for no reason — and badges sat outside the frame for cells nobody could aim at.
 *
 * Takes boxes already projected to screen space rather than a `ReactFlowInstance`, so the caller owns
 * the pan/zoom maths and this stays testable. Intersection, not containment: a cell hanging half off
 * the edge is still something the operator can see and aim at.
 */
export function onScreenNodeIds(
  nodes: readonly { id: string; box: ScreenBox }[],
  screen: { width: number; height: number },
): string[] {
  const viewport: ScreenBox = { left: 0, top: 0, right: screen.width, bottom: screen.height };
  return nodes.filter((node) => rectsIntersect(node.box, viewport)).map((node) => node.id);
}

export type JumpLabelMatch =
  | { kind: "hit"; nodeId: string }
  | { kind: "pending" }
  | { kind: "miss" };

/**
 * A label for every cell, in the order given.
 *
 * **Order is the caller's.** It passes reading order, and sorting here would let the same node take
 * a different letter depending on where it happens to sit — the one thing a jump label must never do.
 *
 * **Every label is the same width.** Not tidiness: with `a` and `as` both live, typing `a` is
 * ambiguous, and the caller can only either jump too early or never jump at all. So the width grows
 * for the whole set at once, and it keeps growing rather than dropping cells off the end.
 */
export function assignJumpLabels(nodeIds: readonly string[]): Map<string, string> {
  const labels = new Map<string, string>();
  if (nodeIds.length === 0) return labels;

  const base = JUMP_LABEL_ALPHABET.length;
  let width = 1;
  while (base ** width < nodeIds.length) width += 1;

  nodeIds.forEach((nodeId, index) => {
    let n = index;
    let label = "";
    // Least-significant digit first, then reversed: plain base-N counting over the alphabet, which is
    // what guarantees no repeats without a uniqueness check.
    for (let position = 0; position < width; position += 1) {
      label = JUMP_LABEL_ALPHABET[n % base] + label;
      n = Math.floor(n / base);
    }
    labels.set(label, nodeId);
  });

  return labels;
}

/**
 * What the typing so far means: a jump, more to come, or nothing.
 *
 * Case-insensitive because Caps Lock is not a decision the operator made about navigation.
 */
export function matchJumpLabel(
  labels: Map<string, string>,
  typed: string,
): JumpLabelMatch {
  if (labels.size === 0) return { kind: "miss" };
  const key = typed.toLowerCase();
  const hit = labels.get(key);
  if (hit) return { kind: "hit", nodeId: hit };
  // Still a prefix of something, so wait. An empty string is trivially a prefix — the mode has just
  // opened and nothing is wrong yet.
  for (const label of labels.keys()) {
    if (label.startsWith(key)) return { kind: "pending" };
  }
  return { kind: "miss" };
}
