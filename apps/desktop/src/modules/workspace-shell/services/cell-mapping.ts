import { paneTitleSaysNothing } from "@/modules/codespace/services/pane-title/pane-title-normalizer";
import { paneRunnerIdentity } from "@/modules/workspace-shell/services/pane-runner-identity";
import type { CellType, GridCell, Workspace } from "@/modules/codespace/components/types";
import type { FrameStatus, PaneActivity, PaneKind, RailPane, RailWorkspace } from "@/modules/workspace-shell/types";
import type { PaneActivityState } from "@/modules/workspace-shell/services/pane-activity";
import { isSplit, reconcileFrames } from "@/modules/workspace-shell/services/code-frames";

/**
 * Real CodeSpace state, in the shape the shell draws.
 *
 * The shell's components stay presentational: they take `RailWorkspace`/`RailPane` and know
 * nothing about `GridCell`, PTY status or chat sessions. This file is the only place the two
 * vocabularies meet, so there is one answer to "what kind is this pane" and one place to fix it.
 */

/**
 * CodeSpace has four cell types; the shell has five kinds. They are NOT the same words:
 * `workbench` is what the shell calls an editor. `orchestrator` is not here: the Bridge pane was
 * retired, and a stored one is dropped on restore rather than mapped to something it is not.
 */
export function paneKindForCell(cell: GridCell): PaneKind {
  switch (cell.type) {
    case "chat":
      return "thread";
    case "browser":
      return "browser";
    case "workbench":
      return "editor";
    default:
      return "terminal";
  }
}

/**
 * The same table, read the other way: which cell a kind asks for.
 *
 * Written once because it was already written twice — the add-pane menu translated kind to cell
 * inline, and a squad preset would have made that three. The literal types survive the lookup, so
 * `cellTypeForPaneKind("browser" | "editor")` is still narrow enough for `addCellPane`,
 * which cannot take a chat cell.
 */
const CELL_TYPE_BY_KIND = {
  terminal: "terminal",
  thread: "chat",
  browser: "browser",
  editor: "workbench",
} as const satisfies Record<PaneKind, CellType>;

export function cellTypeForPaneKind<K extends PaneKind>(kind: K): (typeof CELL_TYPE_BY_KIND)[K] {
  return CELL_TYPE_BY_KIND[kind];
}

/**
 * The row's second line, which only earns its place by saying something new.
 *
 * A terminal with no name of its own is titled after its folder, and the meta line used to lead
 * with that same folder — so the row read "interview-hss / interview-hss" and spent two lines on
 * one fact (seen in the native window, 2026-09-20). The folder is dropped when the title already
 * carries it, leaving room for what the pane is actually running.
 */
function metaLine(detail: string, folder: string, title: string): string {
  // Folder first, then the detail — the order a pane was always described in, kept so the only
  // thing that changed here is the repetition.
  const parts = [title.includes(folder) ? "" : folder, detail].map((part) => part.trim()).filter(Boolean);
  return parts.join(" · ");
}

/** The leaf folder, which is what identifies a pane at a glance — not the whole path. */
function leafOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/**
 * One rail row.
 *
 * The activity is passed IN rather than derived here: it is live state — a PTY that fell quiet a
 * second ago, a hook fact that landed from Rust — and this module maps stored cells to rows. A
 * row that computed it would have to subscribe, and there is one row per pane.
 */
export function railPaneForCell(
  cell: GridCell,
  activity: PaneActivity = "idle",
  activitySince?: number,
): RailPane {
  const kind = paneKindForCell(cell);

  if (cell.type === "chat") {
    const title = cell.thread?.title?.trim() || "New chat";
    return { id: cell.id, kind, title, meta: metaLine("thread", leafOf(cell.cwd), title), activity, activitySince };
  }

  if (cell.type === "browser") {
    return {
      id: cell.id,
      kind,
      title: cell.title?.trim() || cell.url?.replace(/^https?:\/\//, "") || "Browser",
      meta: "browser",
      activity,
      activitySince,
    };
  }

  if (cell.type === "workbench") {
    const activeTab = cell.tabs?.find((tab) => tab.id === cell.activeTabId);
    const tabName = activeTab && activeTab.kind === "file" ? leafOf(activeTab.filePath) : null;
    return { id: cell.id, kind, title: tabName ?? "Editor", meta: "editor", activity, activitySince };
  }

  /*
    A stored title is trusted only while it still says something.

    Titles written before the guards existed are on disk — "Transcript not readable" was in the
    rail on 2026-09-21, and so was a pane named after the flag its CLI was launched with. Judging
    them HERE rather than migrating the snapshot means no rewrite of anyone's stored state, and a
    pane whose name is refused simply falls back to its folder until it earns a better one.
  */
  const storedTitle = cell.title?.trim();
  const usableTitle =
    storedTitle
    && !paneTitleSaysNothing(storedTitle, {
      agentCommand: cell.agentCommand,
      cwd: cell.cwd,
      agentName: cell.agentName,
    })
      ? storedTitle
      : undefined;
  const displayName = usableTitle || cell.agentName?.trim();
  const title = displayName || leafOf(cell.cwd) || "Terminal";

  /*
    The handle, carried whether or not it won the title.

    `agentName` is drawn once from the name pool at spawn and persisted (ADR-0024) — it is what you
    address the pane by in an `@mention`, and a user rename replaces it. It loses the title slot the
    moment the title generator produces something, which is why it travels in its own field: a pane
    that stops saying its own name is a pane you can no longer hand work to by name.
  */
  const persona = cell.agentName?.trim() || undefined;

  return {
    id: cell.id,
    kind,
    title,
    meta: metaLine(cell.agentCommand?.trim() ?? "", leafOf(cell.cwd), title),
    persona,
    runner: paneRunnerIdentity(cell),
    activity,
    activitySince,
  };
}

/** Live means a running process, which is what the rail's count is claiming. */
export function livePaneCount(cells: GridCell[]): number {
  return cells.filter((cell) => cell.type === "terminal" && cell.runtimeStatus === "live").length;
}

/**
 * Two shells in one folder is the ordinary case, not an edge case — and both are titled after
 * that folder, so the rail listed the same row twice with no way to tell which was which. The
 * later ones are numbered, which is what a tab bar does and what a person expects.
 *
 * Numbering happens HERE rather than in `railPaneForCell`, because it is not a property of a
 * pane: it only exists relative to its siblings.
 */
function numberRepeatedTitles(panes: RailPane[]): RailPane[] {
  const seen = new Map<string, number>();
  return panes.map((pane) => {
    const count = (seen.get(pane.title) ?? 0) + 1;
    seen.set(pane.title, count);
    return count === 1 ? pane : { ...pane, title: `${pane.title} ${count}` };
  });
}

const FRAME_MARKS = 3;

/** "1 pane", "3 panes": a Frame row, its menu and its delete toast all say it this way. */
export const paneCountLabel = (count: number) => (count === 1 ? "1 pane" : `${count} panes`);

function frameStatus(members: RailPane[]): FrameStatus {
  if (members.some((pane) => pane.activity === "needs-you")) return "needs-you";
  if (members.some((pane) => pane.activity === "failed")) return "failed";
  if (members.some((pane) => pane.activity === "working")) return "working";
  if (members.some((pane) => pane.unread)) return "unread";
  return "idle";
}

/** Frame rows newest first, then the loose panes; nothing until the workspace is migrated. */
function railFrames(workspace: Workspace, panes: RailPane[]): Pick<RailWorkspace, "frames" | "loosePanes"> {
  if (!workspace.paneLayout?.framesMigrated) return {};
  const frames = reconcileFrames(workspace.paneLayout.frames ?? [], panes.map((pane) => pane.id));
  const framed = new Set(frames.flatMap((frame) => frame.paneIds));
  return {
    frames: [...frames]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ id, name, color, paneIds }) => {
        const members = paneIds.flatMap((paneId) => panes.find((pane) => pane.id === paneId) ?? []);
        return {
          id,
          name,
          color,
          initial: name.trim().charAt(0).toUpperCase(),
          paneCount: paneIds.length,
          paneIds,
          status: frameStatus(members),
          marks: members.slice(0, FRAME_MARKS),
          moreCount: Math.max(0, members.length - FRAME_MARKS),
          split: isSplit({ name }),
          panes: members,
        };
      }),
    loosePanes: panes.filter((pane) => !framed.has(pane.id)),
  };
}

export function toRailWorkspaces(
  workspaces: Workspace[],
  activities: ReadonlyMap<string, PaneActivityState> = new Map(),
  /** Panes with a finished turn nobody opened yet (`services/pane-unread.ts`). */
  unreadIds: ReadonlySet<string> = new Set(),
  /** When each of those finished. */
  unreadSince: ReadonlyMap<string, number> = new Map(),
): RailWorkspace[] {
  return workspaces.map((workspace) => {
    const panes = numberRepeatedTitles(
      workspace.cells.map((cell) => {
        const pane = railPaneForCell(cell, activities.get(cell.id)?.activity ?? "idle", activities.get(cell.id)?.since);
        return unreadIds.has(cell.id) ? { ...pane, unread: true, unreadSince: unreadSince.get(cell.id) } : pane;
      }),
    );
    return {
      id: workspace.id,
      name: workspace.label?.trim() || leafOf(workspace.cwd),
      liveCount: livePaneCount(workspace.cells),
      // Counted on the folder so a COLLAPSED folder can still say it: an ask that exists only
      // inside a fold is an ask nobody will answer.
      needsYouCount: panes.filter((pane) => pane.activity === "needs-you").length,
      workingCount: panes.filter((pane) => pane.activity === "working").length,
      unreadCount: panes.filter((pane) => pane.unread).length,
      panes,
      ...railFrames(workspace, panes),
    };
  });
}
