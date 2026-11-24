"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { subscribeAgentStopped } from "@/modules/codecanvas/services/agent-stopped-event";
import { agentTurnRegistry } from "@/modules/codecanvas/services/agent-turn-registry";
import { threadActivityRegistry } from "@/modules/codespace/state/thread-activity-registry";
import { createCellBus } from "@/modules/codespace/services/bridge/cell-event-bus";
import { attachCellBus } from "@/modules/codespace/services/terminal-session-registry";
import {
  subscribeTerminalActivity,
  type TerminalActivity,
} from "@/modules/codespace/services/terminal-activity-registry";
import { createPaneTurnEnds } from "@/modules/workspace-shell/services/pane-turn-ends";
import { createPaneUnreadStore } from "@/modules/workspace-shell/services/pane-unread";
import type { GridCell } from "@/modules/codespace/components/types";
import { appendDiagnosticTrace } from "@/modules/workspace-shell/services/diagnostic-trace";

/**
 * Every turn end this hook hears and every read, with which signal fired and whether the pane was
 * being watched — "a pane lit up that did nothing" has three possible causes and this names which.
 * Its own key: the activity trace rewrites itself many times a second and would push these out.
 */
const PANE_UNREAD_TRACE_KEY = "lotus:pane-unread-trace";

function traceUnread(entry: string): void {
  const line = `[pane-unread] ${entry}`;
  if (process.env.NODE_ENV !== "production") console.warn(line);
  appendDiagnosticTrace(PANE_UNREAD_TRACE_KEY, line);
}

export interface UsePaneUnreadInput {
  /** Every pane in the window, across all workspaces. */
  cells: readonly GridCell[];
  /**
   * Is the user looking at this pane right now? Read at the moment a turn ends, never cached: a
   * result that lands in the pane being watched is already read.
   */
  isSeen: (paneId: string) => boolean;
  /**
   * Every turn end, after it is recorded — the Agent-Done Alert listens here (Lotus #184). `fresh`:
   * a submit opened the turn, so it is work the user just asked for (it skips the alert's quiet time).
   */
  onTurnEnd?: (paneId: string, info: { seen: boolean; fresh: boolean }) => void;
}

export interface PaneUnread {
  /** Oldest first. */
  unreadIds: readonly string[];
  /** When each unread pane finished, for "Done · 2m ago". */
  unreadSince: ReadonlyMap<string, number>;
  markRead: (paneId: string) => void;
}

/**
 * Which panes finished a turn nobody has opened — the S11 "Selesai · baru" contract.
 *
 * Mounted ONCE per shell. The turn-end decision is CodeCanvas's (`pane-turn-ends`), fed by the same
 * transports the rest of the app uses:
 *
 *  1. `mcp://agent-stopped` — the Stop hook, authoritative. Its `paneId` is `LOTUS_PANE_ID`, which
 *     for a shell pane is the cell id.
 *  2. The cell bus — every write into a pane (a submit opens a turn) and every chunk out of it.
 *  3. `terminal-activity-registry` — busy → quiet, the backstop for runners with no hook.
 *  4. `threadActivityRegistry` — a conversation stopping streaming. A thread has no PTY, so no turn
 *     gate is needed: streaming is already an honest "a reply was being written".
 */
export function usePaneUnread({ cells, isSeen, onTurnEnd }: UsePaneUnreadInput): PaneUnread {
  const [store] = useState(() => createPaneUnreadStore(typeof localStorage === "undefined" ? undefined : localStorage));
  // A pane with any hook fact on record has a live hook, so its PTY settles are never believed —
  // and that record, unlike a set held here, survives a remount.
  const [turnEnds] = useState(() =>
    createPaneTurnEnds({ hookHasReported: (paneId) => agentTurnRegistry.get(paneId) !== undefined }),
  );

  const isSeenRef = useRef(isSeen);
  const onTurnEndRef = useRef(onTurnEnd);
  useLayoutEffect(() => {
    isSeenRef.current = isSeen;
    onTurnEndRef.current = onTurnEnd;
  }, [isSeen, onTurnEnd]);

  const finish = useCallback(
    (paneId: string, source: "hook" | "settle" | "thread", fresh = true) => {
      const seen = isSeenRef.current(paneId);
      traceUnread(`turn-end ${paneId.slice(0, 8)} source=${source} seen=${seen}`);
      store.finished(paneId, { seen, at: Date.now() });
      onTurnEndRef.current?.(paneId, { seen, fresh });
    },
    [store],
  );

  // Keyed by the SET of ids, so reordering or retitling a pane is not a resubscribe.
  const terminalKey = cells
    .filter((cell) => cell.type === "terminal")
    .map((cell) => cell.id)
    .sort()
    .join(" ");
  const threadKey = cells
    .flatMap((cell) => (cell.type === "chat" ? [cell.id] : []))
    .sort()
    .join(" ");
  const paneKey = cells
    .map((cell) => cell.id)
    .sort()
    .join(" ");

  // The live set, for the once-subscribed hook listener.
  const terminalIdsRef = useRef<ReadonlySet<string>>(new Set());
  useLayoutEffect(() => {
    terminalIdsRef.current = new Set(terminalKey ? terminalKey.split(" ") : []);
  }, [terminalKey]);

  // A closed pane has nothing left to read, and its turn window must not outlive it.
  const knownPanesRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const next = new Set(paneKey ? paneKey.split(" ") : []);
    for (const paneId of knownPanesRef.current) if (!next.has(paneId)) turnEnds.forget(paneId);
    knownPanesRef.current = next;
    // Not before the panes have loaded: an empty first render would wipe the marks kept from last run.
    if (next.size) store.retain(next);
  }, [paneKey, store, turnEnds]);

  // Writes open turns, output keeps them alive. A bare bus, as `usePaneActivities` does: the provider
  // also parses every PTY byte, which is a lot of machinery for two notes.
  useEffect(() => {
    const bus = createCellBus();
    const detach = attachCellBus(bus);
    const offInput = bus.on("terminal:input", (event) => turnEnds.noteInput(event.paneId, event.data));
    const offOutput = bus.on("terminal:output", (event) => turnEnds.noteOutput(event.paneId));
    return () => {
      offInput();
      offOutput();
      detach();
      bus.clear();
    };
  }, [turnEnds]);

  useEffect(
    () =>
      subscribeAgentStopped((paneId) => {
        // The hook fires for every agent in the app; canvas nodes are not this shell's to mark.
        if (!terminalIdsRef.current.has(paneId)) return;
        const fresh = turnEnds.isTurnOpen(paneId);
        if (turnEnds.hookStopped(paneId)) finish(paneId, "hook", fresh);
      }),
    [finish, turnEnds],
  );

  useEffect(() => {
    if (!terminalKey) return;
    const unsubscribes = terminalKey.split(" ").map((paneId) => {
      let previous: TerminalActivity | undefined;
      return subscribeTerminalActivity(paneId, (activity) => {
        const settled = previous === "running" && activity !== "running";
        previous = activity;
        if (settled && turnEnds.settled(paneId)) finish(paneId, "settle");
      });
    });
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [finish, terminalKey, turnEnds]);

  useEffect(() => {
    if (!threadKey) return;
    // Reported under the pane's id (07d).
    const threads = threadKey.split(" ").map((paneId) => ({ paneId, streaming: threadActivityRegistry.isStreaming(paneId) }));
    return threadActivityRegistry.subscribe(() => {
      for (const thread of threads) {
        const streaming = threadActivityRegistry.isStreaming(thread.paneId);
        // Only the edge: a thread that was never streaming while watched has finished nothing.
        if (thread.streaming && !streaming) finish(thread.paneId, "thread");
        thread.streaming = streaming;
      }
    });
  }, [finish, threadKey]);

  const version = useSyncExternalStore(store.subscribe, store.version, () => 0);
  const [unreadIds, unreadSince] = useMemo(
    () => {
      const ids = store.unreadIds();
      return [ids, new Map(ids.map((id) => [id, store.since(id)!]))] as const;
    },
    // `version` is what carries a change; the store is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, version],
  );
  const markRead = useCallback(
    (paneId: string) => {
      if (store.isUnread(paneId)) traceUnread(`read ${paneId.slice(0, 8)}`);
      store.markRead(paneId);
    },
    [store],
  );

  return { unreadIds, unreadSince, markRead };
}
