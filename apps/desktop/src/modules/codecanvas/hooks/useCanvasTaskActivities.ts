"use client";

import { useEffect, useMemo, useState } from "react";
import type { Node } from "@xyflow/react";
import type { GridCell } from "@/modules/codespace/components/types";
import {
  subscribeTerminalSessionStatus,
  type TerminalRuntimeStatus,
} from "@/modules/codespace/services/terminal-session-registry";
import { usePaneActivities } from "@/modules/workspace-shell/hooks/usePaneActivities";
import type { PaneActivityState } from "@/modules/workspace-shell/services/pane-activity";

/**
 * What the canvas's task cells are doing, for the window's one tracker board (`plans/canvas-dock/`
 * S4b follow-up).
 *
 * A task delegated from the Dock records the terminal's `runtimePaneId` as its `cellId`, but the
 * board's activities came only from Code mode — so the row showed no live state, the liveness
 * recorder read the cell as `gone`, and finished / failed / needs-you never reached the task's
 * history. This publishes the canvas half; the provider merges it with Code's.
 *
 * The same resolver as Code (`usePaneActivities`), fed a terminal cell per task node: its PTY
 * activity and hook facts are keyed by the pane id the PTY was spawned with, which for a canvas
 * terminal is `runtimePaneId` — the `LOTUS_PANE_ID` its agent inherits.
 *
 * Only nodes that carry a task (`spawnTaskKey`): a shell someone opened by hand has no row to
 * update, and N subscriptions for it would be paid for nothing.
 */

interface TaskCellNode {
  paneId: string;
  agentCommand?: string;
}

/**
 * Which node holds each terminal pane, by `runtimePaneId` — the id a delegated task records as its
 * `cellId`. Lets a Tasks row's live badge find its agent's node (LOT2-220).
 */
export function canvasPaneNodes(nodes: readonly Node[]): Map<string, string> {
  const panes = new Map<string, string>();
  for (const node of nodes) {
    if (node.type !== "terminal") continue;
    const paneId = (node.data as { runtimePaneId?: string }).runtimePaneId;
    if (paneId) panes.set(paneId, node.id);
  }
  return panes;
}

export function canvasTaskCells(nodes: readonly Node[]): TaskCellNode[] {
  const cells: TaskCellNode[] = [];
  for (const node of nodes) {
    if (node.type !== "terminal") continue;
    const data = node.data as { spawnTaskKey?: string; runtimePaneId?: string; launchCommand?: string[] };
    if (!data.spawnTaskKey || !data.runtimePaneId) continue;
    cells.push({ paneId: data.runtimePaneId, agentCommand: data.launchCommand?.join(" ") });
  }
  return cells;
}

export function useCanvasTaskActivities(
  nodes: readonly Node[],
  publish: ((activities: ReadonlyMap<string, PaneActivityState>) => void) | undefined,
): void {
  const taskCells = canvasTaskCells(nodes);
  // `nodes` is a new array on every drag; the pane set and commands are what can change an answer.
  const cellKey = taskCells.map((cell) => `${cell.paneId}\u0000${cell.agentCommand ?? ""}`).sort().join("\u0001");
  const cellList = useMemo(
    () => (cellKey === "" ? [] : cellKey.split("\u0001").map((entry) => {
      const [paneId, agentCommand] = entry.split("\u0000");
      return { paneId: paneId!, agentCommand: agentCommand || undefined };
    })),
    [cellKey],
  );

  // Lifecycle first, as Code reads it: a pane whose PTY exited is `done` whatever the PTY last said.
  const [statuses, setStatuses] = useState<ReadonlyMap<string, TerminalRuntimeStatus>>(() => new Map());
  useEffect(() => {
    const unsubscribes = cellList.map(({ paneId }) =>
      subscribeTerminalSessionStatus(paneId, (status) =>
        setStatuses((current) => {
          if (current.get(paneId) === status) return current;
          const next = new Map(current);
          next.set(paneId, status);
          return next;
        }),
      ),
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [cellList]);

  const cells = useMemo<GridCell[]>(
    () =>
      cellList.map(({ paneId, agentCommand }) => ({
        id: paneId,
        type: "terminal",
        runtimeStatus: statuses.get(paneId),
        agentCommand,
      }) as GridCell),
    [cellList, statuses],
  );
  const activities = usePaneActivities({ cells });

  // Keyed on a signature, never the Map: the provider sets state, and a new Map per render would loop.
  const signature = [...activities].map(([id, state]) => `${id}:${state.activity}`).sort().join("|");
  useEffect(() => {
    publish?.(activities);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, publish]);
  // Leaving the canvas takes its cells out of the board, as a closed Code window does.
  useEffect(() => () => publish?.(new Map()), [publish]);
}
