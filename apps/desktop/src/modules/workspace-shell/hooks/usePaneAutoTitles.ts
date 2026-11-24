"use client";

import { useEffect, useRef } from "react";
import { generatePaneTitle, getPaneAgentTitle } from "@/lib/tauri-api";
import { useAutoPaneTitlesEnabled } from "@/modules/codespace/hooks/useAutoPaneTitlesEnabled";
import {
  isUnusableTerminalPaneTitle,
  terminalPaneFallbackLabel,
  titleEchoesLaunchCommand,
  titleIsAssistantChatter,
} from "@/modules/codespace/services/pane-title/pane-title-normalizer";
import {
  planPaneTitle,
  titleProviderForCommand,
  turnJustSettled,
  type PaneTitlePatch,
} from "@/modules/workspace-shell/services/pane-title";
import type { GridCell, Workspace } from "@/modules/codespace/components/types";
import type { PaneActivityState } from "@/modules/workspace-shell/services/pane-activity";
import type { PaneActivity } from "@/modules/workspace-shell/types";

/**
 * Keeps each agent pane named after its CURRENT conversation, checked when a turn settles.
 *
 * The source is the agent's own record, not its screen: the transcript the pane's hooks reported
 * (Rust `pane_agent_title`). That gives the agent's own title for free when it wrote one, and the
 * key of the conversation, so a title left over from before a `/clear` or `/resume` is noticed and
 * replaced. A model is asked only when the agent wrote no title, once per conversation per window,
 * and is fed the first typed prompt and the latest reply — never the PTY paint.
 *
 * The seed (`paneTitleSeed`) still names a pane the moment a prompt is sent, so this never sits on
 * anyone's critical path and may fail in silence.
 */

export interface UsePaneAutoTitlesInput {
  /** Every workspace's panes: an agent in a folder you are not looking at still earns its name. */
  workspaces: Workspace[];
  activities: ReadonlyMap<string, PaneActivityState>;
  onTitle: (workspaceId: string, paneId: string, patch: PaneTitlePatch) => void;
}

export function usePaneAutoTitles({ workspaces, activities, onTitle }: UsePaneAutoTitlesInput): void {
  const enabled = useAutoPaneTitlesEnabled();
  /** What each pane was doing last time — the "was working" half of "has stopped working". */
  const previousActivityRef = useRef(new Map<string, PaneActivity>());
  /** Conversations this window already asked a model to title, successful or not. */
  const generatedRef = useRef(new Set<string>());
  /** Panes with a check in flight, so a quick second settle does not race the first. */
  const inFlightRef = useRef(new Set<string>());
  /** The latest cells, read when an async check lands rather than the ones it started with. */
  const cellsRef = useRef(new Map<string, GridCell>());
  const onTitleRef = useRef(onTitle);
  // Updated in an effect, not during render: the writer is a message to the component ABOVE this
  // hook, and the same pattern already keeps this shell's pane openers out of a listener's deps.
  useEffect(() => {
    onTitleRef.current = onTitle;
  }, [onTitle]);

  useEffect(() => {
    const previous = previousActivityRef.current;
    cellsRef.current = new Map(workspaces.flatMap((w) => w.cells.map((cell) => [cell.id, cell] as const)));

    for (const workspace of workspaces) {
      for (const cell of workspace.cells) {
        const activity = activities.get(cell.id)?.activity;
        if (!activity) continue;
        const previousActivity = previous.get(cell.id);
        previous.set(cell.id, activity);

        if (!enabled || cell.type !== "terminal") continue;
        if (!turnJustSettled(previousActivity, activity)) continue;
        if (inFlightRef.current.has(cell.id)) continue;

        inFlightRef.current.add(cell.id);
        void check({
          paneId: cell.id,
          workspaceId: workspace.id,
          generated: generatedRef.current,
          latestCell: () => cellsRef.current.get(cell.id),
          onTitle: (patch) => onTitleRef.current(workspace.id, cell.id, patch),
        }).finally(() => inFlightRef.current.delete(cell.id));
      }
    }

    // A pane that closed takes its bookkeeping with it.
    const live = new Set(workspaces.flatMap((workspace) => workspace.cells.map((cell) => cell.id)));
    for (const paneId of previous.keys()) if (!live.has(paneId)) previous.delete(paneId);
  }, [activities, enabled, workspaces]);
}

/**
 * One line per decision, in dev only.
 *
 * The chain crosses a hook, an IPC call and a CLI, and "the title never changed" is the same
 * symptom whichever link broke. The log says which.
 */
function note(paneId: string, message: string): void {
  if (process.env.NODE_ENV === "production") return;
  console.warn(`[pane-title] ${paneId.slice(0, 8)} ${message}`);
}

function asTitleCell(cell: GridCell) {
  if (cell.type !== "terminal") return { type: cell.type };
  return {
    type: cell.type,
    title: cell.title,
    titleStatus: cell.titleStatus,
    titleSessionKey: cell.titleSessionKey,
    agentCommand: cell.agentCommand,
    runtimeProvider: cell.runtimeProvider,
    cwd: cell.cwd,
  };
}

interface CheckArgs {
  paneId: string;
  workspaceId: string;
  generated: Set<string>;
  latestCell: () => GridCell | undefined;
  onTitle: (patch: PaneTitlePatch) => void;
}

async function check({ paneId, generated, latestCell, onTitle }: CheckArgs): Promise<void> {
  let agent;
  try {
    agent = await getPaneAgentTitle(paneId);
  } catch (error) {
    note(paneId, `no agent title: ${String(error)}`);
    return;
  }
  const cell = latestCell();
  if (!cell || cell.type !== "terminal") return;

  const plan = planPaneTitle({ cell: asTitleCell(cell), agent, generatedKeys: generated, enabled: true, now: Date.now() });
  note(paneId, `plan ${plan.kind}${agent ? ` (${agent.title ? `agent "${agent.title}"` : "no agent title"})` : " (no transcript)"}`);
  if (plan.kind === "none") return;
  if (plan.kind === "apply") {
    onTitle(plan.patch);
    return;
  }

  generated.add(plan.sessionKey);
  // Do not leave an earlier conversation's name up while the model answers.
  if (plan.clearStale) onTitle({ title: null, status: null, updatedAt: Date.now(), sessionKey: plan.sessionKey });

  const title = await modelTitleForPane(paneId, cell, latestCell);
  if (title) onTitle({ title, status: "ready", updatedAt: Date.now(), sessionKey: plan.sessionKey });
}

/**
 * A fresh model title for a pane's current conversation — the title control's "Regenerate", and
 * its "Use automatic title" after the stored one is cleared. Throws when there is nothing to
 * title yet, so the control can say the click did nothing.
 */
export async function regeneratePaneTitle(
  paneId: string,
  latestCell: () => GridCell | undefined,
  onTitle: (patch: PaneTitlePatch) => void,
): Promise<void> {
  const agent = await getPaneAgentTitle(paneId);
  if (!agent?.hasPrompt) throw new Error("this pane has no prompt to title yet");
  const cell = latestCell();
  if (!cell || cell.type !== "terminal") return;
  const title = await modelTitleForPane(paneId, cell, latestCell);
  if (title) onTitle({ title, status: "ready", updatedAt: Date.now(), sessionKey: agent.sessionKey });
}

/**
 * Ask the pane's own CLI family for a title, or null when the answer is no name at all. The
 * model is Settings › Chat › Titles, read in Rust (`chat_runtime/title.rs`), for every mode.
 */
async function modelTitleForPane(
  paneId: string,
  cell: Extract<GridCell, { type: "terminal" }>,
  latestCell: () => GridCell | undefined,
): Promise<string | null> {
  const provider = titleProviderForCommand(cell.agentCommand);
  try {
    const result = await generatePaneTitle({ paneId, provider });
    const title = result.title.trim();
    const now = latestCell();
    // Renamed by hand meanwhile: the person's name wins over an answer that arrived late.
    if (!now || now.type !== "terminal" || now.titleStatus === "manual") return null;
    /*
      The folder, the agent's own name, a launch flag and a CLI error ("You've hit your weekly
      limit", seven times in the rail before this guard) are answers about the setup, not names.
    */
    const unusable =
      isUnusableTerminalPaneTitle(title, [terminalPaneFallbackLabel(cell.cwd), cell.agentName, cell.agentCommand])
      || titleEchoesLaunchCommand(title, cell.agentCommand)
      // A one-shot that greets instead of naming ("I'm ready to help with your coding project!").
      || titleIsAssistantChatter(title);
    note(paneId, `generate (${provider}) -> ${title ? `"${title}"` : "(empty)"}${unusable ? " [rejected]" : ""}`);
    return title && !unusable ? title : null;
  } catch (error) {
    // Silent by design: the seed's title is already on screen. The line is for whoever asks why.
    console.warn(`[pane-title] ${provider} could not name ${paneId.slice(0, 8)}:`, error);
    return null;
  }
}
