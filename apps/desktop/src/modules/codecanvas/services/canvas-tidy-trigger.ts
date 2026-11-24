// Pure decision core for the "auto-tidy" behaviour (Settings → Canvas). Tidy is
// INTENT-driven, not count-driven: every node create/close flows through the
// command center, so we decide off the actual mutation — never off a node-count
// delta (which can't tell a fresh project load from a real spawn, and so either
// reshuffled saved layouts or ignored multi-spawns). Project loads/restores don't
// run commands, so they never reach here.

import type { TidyMode } from "../hooks/useCanvasBehaviorSettings";

export type TidyKind = "open" | "close";

export interface TidyDecisionFlags {
  tidyMode: TidyMode;
}

/**
 * Should a single node open/close trigger an auto-arrange? "notes" tidies notes only, "open" tidies
 * every open (and notes on close), "open-close" tidies every mutation.
 */
export function shouldTidyOnMutation(kind: TidyKind, isNote: boolean, flags: TidyDecisionFlags): boolean {
  switch (flags.tidyMode) {
    case "open-close": return true;
    case "open": return isNote || kind === "open";
    case "notes": return isNote;
    default: return false;
  }
}
