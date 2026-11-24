import type { FrameColor } from "@/modules/codespace/components/types";

export type PaneKind = "terminal" | "thread" | "browser" | "editor";

/**
 * What the pane is doing, which is what the rail dot and the header badge both read from.
 *
 * The vocabulary lives here with `PaneKind` and the logic lives in `services/pane-activity.ts`,
 * which resolves it from the two signals Lotus already had — the terminal activity registry
 * (ADR-0004) and the hook turn facts (`plans/honest-agent-status/`).
 *
 * `needs-you` is the load-bearing member: it is never inferred, only ever reported by a hook for a
 * runner that can report it, and it never animates. Both rules are enforced in that service.
 */
export type PaneActivity =
  | "offline"
  | "starting"
  | "idle"
  | "working"
  | "needs-you"
  | "failed"
  | "done";

/** The hue a state wears. Separate from the state so the CSS binds one vocabulary, not seven. */
export type PaneActivityTone = "live" | "ask" | "warn" | "boot" | "muted";

export interface RailPane {
  id: string;
  kind: PaneKind;
  title: string;
  /**
   * What identifies this pane beyond its title: cwd, the command it runs, the model.
   *
   * No longer drawn as a second line — the rail shows one line per row — but kept, because it is
   * what the row's tooltip says and what a wider surface can still use.
   */
  meta: string;
  /**
   * A number the row can wear on its right, when one actually exists.
   *
   * A thread knows how many messages it holds; a terminal has nothing to count. Absent rather
   * than zero: an invented figure is worse than empty space.
   */
  badge?: number;
  /** What this pane is doing. Absent means "nothing is known", which draws as at-rest. */
  activity?: PaneActivity;
  /** When it entered that state, so a row can say how long it has been waiting. */
  activitySince?: number;
  /**
   * Its agent finished a turn nobody has opened yet (`services/pane-unread.ts`). Already filtered to
   * panes at rest: one that asks, fails or works again is described by that state instead.
   */
  unread?: boolean;
  /** When that turn finished, for "Done · 2m ago". */
  unreadSince?: number;
  /**
   * The agent's own handle — `Nara`, `Bima`, or whatever the user renamed it to.
   *
   * Carried SEPARATELY from {@link RailPane.title} rather than folded into it, because the two
   * answer different questions and a pane can have both: once the title generator lands, the
   * conversation title wins the title slot and the handle would otherwise vanish — which is
   * exactly the gap CodeCanvas does not have, since a node always wears its name.
   */
  persona?: string;
  /** Which CLI is behind the pane, for the mark and the runner word in the header. */
  runner?: PaneRunnerIdentity;
}

/** One Frame of a Code workspace, as its rail row draws it. */
export interface RailFrame {
  id: string;
  name: string;
  color: FrameColor;
  /** What the coloured tile shows. */
  initial: string;
  paneCount: number;
  paneIds: string[];
  /** The one most urgent state among its panes. */
  status: FrameStatus;
  /** Up to four member panes, for the logo stack. */
  marks: RailPane[];
  /** Members beyond the three marks: the "+N". */
  moreCount: number;
  /** No name: a split, drawn as one line of its panes; gone once one pane is left. */
  split: boolean;
  /** Every member, in order: a named Frame's card lists them, a split's line shows them. */
  panes: RailPane[];
}

/** A Frame row's line two, most urgent first: needs you > failed > working > new result > idle. */
export type FrameStatus = "needs-you" | "failed" | "working" | "unread" | "idle";

export interface RailWorkspace {
  id: string;
  name: string;
  /** Frame rows, newest first. Absent until the workspace has been migrated to Frames. */
  frames?: RailFrame[];
  /** Panes outside every Frame, one line each, after the Frame rows. Absent with `frames`. */
  loosePanes?: RailPane[];
  /** Live panes in this workspace. Hidden when zero, so an idle folder stays quiet. */
  liveCount?: number;
  /**
   * Panes in this folder waiting on a human.
   *
   * Carried on the FOLDER because a collapsed folder still has to be able to say it — an ask that
   * only exists inside a fold is an ask nobody will answer.
   */
  needsYouCount?: number;
  /** Panes in this folder whose agent is working — a collapsed folder draws a ring for it. */
  workingCount?: number;
  /** Panes in this folder with a finished turn nobody opened — a collapsed folder counts them. */
  unreadCount?: number;
  /**
   * Kept at the top of the rail, by choice rather than by recency.
   *
   * Derived from stored preferences (`pinnedWorkspaceIds`) by `orderRailWorkspaces`, not by the
   * workspace engine: a pin is how this window likes its list arranged, and putting it on the
   * workspace itself would let a layout preference travel into the persisted snapshot.
   */
  pinned?: boolean;
  /**
   * The folder whose panes are ON SCREEN.
   *
   * Separate from "expanded" since folders stay open independently of each other: the rail can
   * show four expanded folders while exactly one of them is the one being looked at.
   */
  active?: boolean;
  panes: RailPane[];
}

export type ShellMode = "canvas" | "code" | "chat";

/**
 * What the showing mode says about itself, for the one pill in the chrome.
 *
 * The mode reports it rather than the chrome computing it: only the mode knows how many of its
 * sessions are live, and a number written into the title bar is a number that goes stale the
 * moment anything happens underneath it.
 */
export interface ShellModeStatus {
  label: string;
  /**
   * Someone is waiting on a human in this mode.
   *
   * Separate from {@link ShellModeStatus.tone}, which says which KIND of work a mode holds. An ask
   * is not a kind, and it has to be able to override the hue of whatever kind raised it.
   */
  attention?: boolean;
  /** This mode's share of Needs you (GLOSSARY), window-wide: the chrome's badge adds the rest. */
  needsYou?: { waiting: number; done: number };
  /** A Done row's "Mark seen" in the Jump palette: the pane's result counts as read. */
  onMarkSeen?: (paneId: string) => void;
  /** The panes this mode holds, and focusing one: a Tasks row's live badge goes there (LOT2-220). */
  paneIds?: ReadonlySet<string>;
  onFocusPane?: (paneId: string) => void;
  /** The Jump palette's workspaces and panes, read when it opens, and selecting a workspace. */
  jumpWorkspaces?: () => import("./services/jump-items").JumpWorkspace[];
  onSelectWorkspace?: (workspaceId: string) => void;
  /** Which kind hue the pill takes, so Code and Chat are told apart without reading it. */
  tone: PaneKind;
  /**
   * What kind of pane holds focus.
   *
   * Not drawn anywhere yet. It is here because it decides real behaviour — only the focused pane
   * of a shown surface is eligible for the accelerated renderer — so a measurement of a mode
   * switch is not interpretable without it.
   */
  focusKind?: PaneKind;
}

/**
 * The mark drawn for a pane's runner, which is the same idea CodeCanvas draws on an agent node.
 *
 * A `logo` is painted as a CSS mask in `currentColor`, never as a coloured brand image: the shell
 * spends colour on exactly four things and a vendor hue is not one of them. `generic` is the
 * honest answer for an agent whose vendor has no asset here, and it must not degrade into a solid
 * square — the same rule `canvas-persona-badge` follows.
 */
export type PaneRunnerMark =
  | { kind: "logo"; src: string }
  | { kind: "generic" };

/**
 * Who is running inside a pane, for the pane header's identity line.
 *
 * `label` is NEVER computed here: it comes from `deriveFleetIdentity`, the registry the fleet and
 * the rail already read, so a pane cannot be called one thing in the header and another in an
 * `@mention`. Absent means there is no agent — a plain shell, a browser, an editor.
 */
export interface PaneRunnerIdentity {
  provider: string;
  label: string;
  mark: PaneRunnerMark;
}
