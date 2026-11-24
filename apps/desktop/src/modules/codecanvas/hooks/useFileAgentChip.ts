"use client";

import { useEffect, useMemo, useState } from "react";
import { agentStateRegistry } from "../services/narration/agent-state-registry";
import { agentEditingFile, lineDiffCounts } from "../services/file-node/file-agent-link";
import { useAgentStatusSnapshots } from "./useAgentStatusSnapshots";

export interface FileAgentChip {
  /** The agent's canvas node id. */
  nodeId: string;
  name: string;
  added: number;
  removed: number;
}

/**
 * The File Node's chip: the live agent that touched `path` most recently, with its +/− lines
 * against the git baseline. Null when no agent on the board has touched it (plans/canvas-code, S4).
 * Counts are the file's own diff against HEAD, not per-agent, because the registry keeps no
 * per-agent edit hunks.
 */
export function useFileAgentChip(path: string, baseline: string | null, content: string | null): FileAgentChip | null {
  const snapshots = useAgentStatusSnapshots();
  const [rev, bump] = useState(0);
  useEffect(() => agentStateRegistry.subscribe(() => bump((n) => n + 1)), []);
  const agent = useMemo(
    () => agentEditingFile({
      states: agentStateRegistry.all(),
      live: snapshots.map((s) => ({ id: s.id, name: s.name, hookPaneId: s.hookPaneId })),
      path,
    }),
    // `rev` stands for the registry's contents, which are mutated in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshots, path, rev],
  );
  const counts = useMemo(
    () => (baseline !== null && content !== null ? lineDiffCounts(baseline, content) : { added: 0, removed: 0 }),
    [baseline, content],
  );
  return agent ? { ...agent, ...counts } : null;
}
