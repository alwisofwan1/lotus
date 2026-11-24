"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { agentTurnRegistry } from "@/modules/codecanvas/services/agent-turn-registry";
import { useAgentTurnFacts } from "@/modules/codecanvas/hooks/useAgentTurnFacts";
import { threadActivityRegistry } from "@/modules/codespace/state/thread-activity-registry";
import { createCellBus } from "@/modules/codespace/services/bridge/cell-event-bus";
import {
  attachCellBus,
  type TerminalRuntimeStatus,
} from "@/modules/codespace/services/terminal-session-registry";
import {
  getTerminalActivitySince,
  subscribeTerminalActivity,
  type TerminalActivity,
} from "@/modules/codespace/services/terminal-activity-registry";
import {
  capabilityForCommand,
  resolvePaneActivity,
  stampPaneActivities,
  type PaneActivityState,
} from "@/modules/workspace-shell/services/pane-activity";
import type { PaneActivity } from "@/modules/workspace-shell/types";
import { agentStartError } from "@/modules/codespace/services/bridge/agent-registry";
import { detectFleetProvider } from "@/modules/codespace/services/bridge/fleet-naming";
import type { GridCell } from "@/modules/codespace/components/types";
import { appendDiagnosticTrace } from "@/modules/workspace-shell/services/diagnostic-trace";
import { paneRunnerIdentity } from "@/modules/workspace-shell/services/pane-runner-identity";

/**
 * Every pane's activity, for the rail, the pane headers and the chrome.
 *
 * Mounted ONCE per shell. Three transports meet here and each is the one the rest of the app
 * already uses:
 *
 *  1. `terminal-activity-registry` — per-pane PTY activity (ADR-0004), fed by the terminal-v2
 *     runtime the shell mounts anyway.
 *  2. `agentTurnRegistry` + `useAgentTurnFacts` — hook facts from Rust, cold-hydrated once and
 *     then pushed. Keyed by `LOTUS_PANE_ID`, which for a shell pane is the cell id it was spawned
 *     with, so no correlation table is needed.
 *  3. `threadActivityRegistry` — whether a conversation is generating.
 *
 * Reading them in one place rather than per row is what keeps N panes at three subscriptions plus
 * one per terminal, instead of three per pane.
 */

/** Transitions only; see `services/diagnostic-trace.ts` for where it lands and how to read it. */
const PANE_ACTIVITY_TRACE_KEY = "lotus:pane-activity-trace";

export interface UsePaneActivitiesInput {
  /** Every pane in the window, across all workspaces — the rail lists them all. */
  cells: readonly GridCell[];
}

/** Cheap identity of the inputs that can change an answer, so the map is rebuilt only when one does. */
function cellSignature(cells: readonly GridCell[]): string {
  return cells
    .map((cell) => {
      if (cell.type === "terminal") {
        // `runtimeProvider` belongs here: it is what decides whether a pane's hook facts may be
        // believed at all, and it lands LATE — the CLI's banner is read some seconds after the
        // pane opens. Left out, the memo below would keep answering from the pre-detection
        // capability for as long as nothing else about the pane changed.
        return `t:${cell.id}:${cell.runtimeStatus ?? "-"}:${cell.agentCommand ?? ""}:${cell.runtimeProvider ?? "-"}`;
      }
      if (cell.type === "chat") return `c:${cell.id}:${cell.thread?.id ?? ""}`;
      return `o:${cell.id}`;
    })
    .join("|");
}

export function usePaneActivities({
  cells,
}: UsePaneActivitiesInput): ReadonlyMap<string, PaneActivityState> {
  const signature = cellSignature(cells);
  // Terminal panes are the only ones with a PTY to subscribe to, and the SET is what the
  // subscriptions depend on — a sorted key means reordering panes is not a resubscribe.
  const terminalKey = useMemo(
    () =>
      cells
        .filter((cell) => cell.type === "terminal")
        .map((cell) => cell.id)
        .sort()
        .join(" "),
    // `cells` is a new array on every render of the workspace state; the signature is what
    // actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature],
  );
  const terminalIds = useMemo(() => (terminalKey === "" ? [] : terminalKey.split(" ")), [terminalKey]);

  // Cold hydrate + live push of hook facts. Owns the transport; everything below only reads.
  useAgentTurnFacts(terminalIds);

  const [ptyActivity, setPtyActivity] = useState<ReadonlyMap<string, TerminalActivity>>(
    () => new Map(),
  );

  useEffect(() => {
    if (terminalIds.length === 0) {
      // Dropping straight to an empty map rather than leaving the last one behind: a rail with no
      // terminals must not keep reporting the activity of panes that are gone.
      setPtyActivity((current) => (current.size === 0 ? current : new Map()));
      return;
    }
    const unsubscribes = terminalIds.map((paneId) =>
      subscribeTerminalActivity(paneId, (activity) => {
        setPtyActivity((current) => {
          if (current.get(paneId) === activity) return current;
          const next = new Map(current);
          next.set(paneId, activity);
          return next;
        });
      }),
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [terminalIds]);

  /**
   * A human acting on a pane closes whatever ask was open on it.
   *
   * This is the rejection path the honest-status work found the hard way: refusing a permission
   * prompt fires NO hook at all, so nothing would ever retract the `needs-you` and the badge would
   * sit there for the rest of the session. A submit is the proof a human answered.
   *
   * A bare `CellBus` rather than `CellBusProvider`: the provider also owns a fleet output tap and
   * parses every PTY byte, which is a lot of machinery for one predicate. Attaching a bus is the
   * documented way to receive these events, and the registry fans out to every attached bus.
   */
  // Pane id → the agent whose start error it printed.
  const [startErrors, setStartErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  useEffect(() => {
    const bus = createCellBus();
    const detach = attachCellBus(bus);
    const setStartError = (paneId: string, agent: string | null) =>
      setStartErrors((current) => {
        if ((current.get(paneId) ?? null) === agent) return current;
        const next = new Map(current);
        if (agent) next.set(paneId, agent);
        else next.delete(paneId);
        return next;
      });
    // A small tail per pane, so a start error split across two PTY chunks is still seen whole.
    const tails = new Map<string, string>();
    // Panes where the human already acted on the error. Seen live: after a good answer cursor-agent
    // prints the old error line again, and the pane went back to failed. A later match is history.
    const dismissed = new Set<string>();
    const offInput = bus.on("terminal:input", (event) => {
      if (event.origin !== "human" || !event.submitted) return;
      agentTurnRegistry.noteAnswered(event.paneId, Date.now());
      // The human acted (picked another model, retried): the error is theirs to see in the pane now.
      tails.delete(event.paneId);
      dismissed.add(event.paneId);
      setStartError(event.paneId, null);
    });
    const offOutput = bus.on("terminal:output", ({ paneId, data }) => {
      if (dismissed.has(paneId)) return;
      const recent = ((tails.get(paneId) ?? "") + data).slice(-256);
      tails.set(paneId, recent);
      const agent = agentStartError(recent);
      if (agent) setStartError(paneId, agent);
    });
    const offExited = bus.on("terminal:exited", ({ paneId }) => {
      tails.delete(paneId);
      dismissed.delete(paneId);
      setStartError(paneId, null);
    });
    return () => {
      offInput();
      offOutput();
      offExited();
      detach();
      bus.clear();
    };
  }, []);

  // Primitive, monotonic snapshots — the registries hand out Maps and Sets, which would tear.
  const turnVersion = useSyncExternalStore(
    agentTurnRegistry.subscribe,
    agentTurnRegistry.version,
    () => 0,
  );
  const threadVersion = useSyncExternalStore(
    threadActivityRegistry.subscribe,
    threadActivityRegistry.version,
    () => 0,
  );

  const stamped = useRef<ReadonlyMap<string, PaneActivityState>>(new Map());

  /**
   * What the shell believes about each pane, printed into the dev terminal on every CHANGE.
   *
   * The `console.warn` reaches the WebKit inspector only — not the `tauri dev` terminal (see
   * `services/diagnostic-trace.ts`); the trace is the copy that can be read from disk. It prints the INPUTS beside
   * the answer — lifecycle, PTY activity, hook fact — because "the badge is stuck" has three
   * possible causes and the word on screen cannot tell them apart.
   *
   * Transitions only. A line per render would bury the one that matters.
   */
  const logged = useRef(new Map<string, string>());
  useEffect(() => {
    for (const cell of cells) {
      const state = stamped.current.get(cell.id);
      if (!state) continue;
      let inputs: string;
      // Ages are printed but never compared: they grow on every render, so a key holding them
      // turned "transitions only" into a 62 KB localStorage rewrite per pane per render.
      let ages = "";
      if (cell.type === "terminal") {
        const fact = agentTurnRegistry.get(cell.id);
        const answeredAt = agentTurnRegistry.answeredAt(cell.id);
        const capability = capabilityForCommand(cell.agentCommand, cell.runtimeProvider);
        inputs =
          `status=${cell.runtimeStatus ?? "-"} pty=${ptyActivity.get(cell.id) ?? "-"} ` +
          `fact=${fact?.turn ?? "-"}@${fact?.atMs ?? "-"} answered=${answeredAt ?? "-"} ` +
          `steps=${capability.reportsSteps} end=${capability.reportsTurnEnd} ` +
          `cmd=${cell.agentCommand?.split(/\s+/)[0] || "-"} rp=${cell.runtimeProvider ?? "-"}`;
        ages =
          ` age=${fact ? `${Date.now() - fact.atMs}ms` : "-"}` +
          ` answeredAgo=${answeredAt === undefined ? "-" : `${Date.now() - answeredAt}ms`}`;
      } else if (cell.type === "chat") {
        inputs = `streaming=${threadActivityRegistry.isStreaming(cell.id)}`;
      } else {
        inputs = "surface";
      }
      const line = `${state.activity} ${inputs}`;
      if (logged.current.get(cell.id) === line) continue;
      logged.current.set(cell.id, line);
      const entry = `[pane-activity] ${cell.id.slice(0, 8)} ${line}${ages}`;
      if (process.env.NODE_ENV !== "production") console.warn(entry);
      appendDiagnosticTrace(PANE_ACTIVITY_TRACE_KEY, entry);
    }
  });

  return useMemo(() => {
    const now = Date.now();
    const activities = new Map<string, PaneActivity>();

    for (const cell of cells) {
      activities.set(
        cell.id,
        resolvePaneActivity(cell, {
          terminal:
            cell.type === "terminal"
              ? {
                  runtimeStatus: cell.runtimeStatus as TerminalRuntimeStatus | undefined,
                  activity: ptyActivity.get(cell.id) ?? "idle",
                  activitySinceMs: getTerminalActivitySince(cell.id),
                  fact: agentTurnRegistry.get(cell.id),
                  answeredAtMs: agentTurnRegistry.answeredAt(cell.id),
                  capability: capabilityForCommand(cell.agentCommand, cell.runtimeProvider),
                  agent: paneRunnerIdentity(cell) !== undefined,
                  startError:
                    startErrors.has(cell.id)
                    && startErrors.get(cell.id) === (cell.runtimeProvider ?? detectFleetProvider(cell.agentCommand)),
                  now,
                }
              : undefined,
          chat:
            cell.type === "chat"
              ? // Reported under the pane's id (07d); a deleted thread says so in the pane.
                {
                  streaming: threadActivityRegistry.isStreaming(cell.id),
                  waiting: threadActivityRegistry.isWaiting(cell.id),
                }
              : undefined,
        }),
      );
    }

    // Idempotent: re-running with the same activities returns the same stamps, so a double
    // invocation in development cannot reset an age.
    const next = stampPaneActivities(stamped.current, activities, now);
    stamped.current = next;
    return next;
    // `cells` is rebuilt on every render of the workspace state; `signature` is what carries a
    // real change, and the two registries report through their versions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, ptyActivity, turnVersion, threadVersion, startErrors]);
}
