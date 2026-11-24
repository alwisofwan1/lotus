"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSettings, saveSettings } from "@/lib/tauri-api";
import { isTauri } from "@/lib/tauri/runtime";
import {
  emitLotusSettingsChanged,
  LOTUS_SETTINGS_CHANGED_EVENT,
  readLotusSettingsChangedDetail,
} from "@/modules/settings/services/settings-events";
import { useTaskExecution } from "@/modules/codespace/services/task-execution/useTaskExecution";
import { createTauriTaskClient } from "@/modules/codespace/services/bridge/task-api";
import {
  prepareDelegationPreset,
  resumeCommand,
  startCommand,
  supportsChosenSession,
  presetRefusalMessage,
  withDeniedTools,
  resolveDelegationPresets,
  type DelegationPreset,
} from "@/modules/tasks/services/delegation-preset";
import { createTaskSpawner, type AddPane, type OpenPane } from "@/modules/tasks/services/task-spawner";
import type { BridgeTask, UpdateTaskPatch } from "@/modules/codespace/services/bridge/task-store";
import type { ClaudeSettings } from "@/modules/settings/types";

/**
 * Handing a task to an agent.
 *
 * The execution machinery already existed and had been unreachable since the Bridge estate was
 * swept: `useTaskExecution` spawns the pane, waits for its PTY, writes the prompt and binds the
 * pane to the task. What was missing was a way in. This is it.
 *
 * Presets are user-defined and there are none to start with — the same rule bb settled on. It
 * forces the choice of worker and permissions to be a decision somebody made, rather than a
 * default that quietly spends money the first time a button is pressed.
 */

export interface Delegation {
  presets: DelegationPreset[];
  /** `null` until Code mode has mounted and published a way to open a pane. */
  ready: boolean;
  /** Resolves to a message when it could not be done, or null on success. */
  delegate: (
    task: BridgeTask,
    preset: DelegationPreset,
    /** The key the task is called by, so the worker can speak about it. */
    taskKey?: string | null,
    options?: DelegateOptions,
  ) => Promise<string | null>;
  /** Resolves to a refusal message, or null when the preset was saved. */
  savePreset: (draft: Omit<DelegationPreset, "id">) => Promise<string | null>;
  /** Same contract as `savePreset`, for an existing preset — it keeps its id and its place. */
  updatePreset: (id: string, draft: Omit<DelegationPreset, "id">) => Promise<string | null>;
  removePreset: (id: string) => Promise<void>;
  /** Walk back into a session a previous dispatch recorded. */
  resume: (task: BridgeTask, command: string) => Promise<string | null>;
  /** Which task is being dispatched right now. */
  inFlight: ReadonlySet<string>;
}

export interface DelegateOptions {
  /**
   * Tool rules the agent must not have — for a Notion ticket, every Notion MCP tool that writes; for
   * a GitHub issue, the `gh issue` and GitHub MCP issue writes.
   * Only a Claude-shaped preset can be given them; any other is refused rather than trusted.
   */
  denyTools?: readonly string[];
  /** Work in this folder rather than the workspace root: a GitHub issue's checkout inside it. */
  cwd?: string;
  /** Said to the agent after the preset's instructions: a GitHub issue worked in a namesake clone. */
  note?: string;
}

/** Said when a preset cannot carry `denyTools`, instead of delegating without them. */
export const DENY_NEEDS_CLAUDE =
  "Only a Claude preset can be kept from writing to the ticket's source. Delegate this ticket with a Claude preset.";

export function useDelegation(
  workspaceId: string | null,
  spawner: AddPane | OpenPane | null,
  updateTask: (taskId: string, patch: UpdateTaskPatch) => Promise<unknown>,
  onPostSpawn?: (paneId: string) => void,
  /** Why this host cannot open a pane, said in place of "open a workspace" (the Canvas Dock, S4). */
  unavailable?: string,
  /** The spawner's panes run the agent with no shell in front (`TaskSpawner.launchesAgentDirectly`). */
  launchesAgentDirectly?: boolean,
): Delegation {
  const [presets, setPresets] = useState<DelegationPreset[]>([]);
  const client = useRef(createTauriTaskClient());

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void getSettings()
      .then((data) => {
        if (!cancelled) setPresets(resolveDelegationPresets(data as ClaudeSettings));
      })
      .catch(() => {
        /* no presets is the starting state, not a failure */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: Event) => {
      const detail = readLotusSettingsChangedDetail(event);
      if (!detail) return;
      setPresets(resolveDelegationPresets(detail.settings as ClaudeSettings));
    };
    window.addEventListener(LOTUS_SETTINGS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(LOTUS_SETTINGS_CHANGED_EVENT, handler);
  }, []);

  const write = useCallback(async (next: DelegationPreset[]) => {
    setPresets(next);
    if (!isTauri()) return;
    const data = (await getSettings()) as ClaudeSettings;
    const merged = { ...data, delegation: { presets: next } };
    await saveSettings(merged);
    emitLotusSettingsChanged(merged as unknown as Record<string, unknown>);
  }, []);

  /*
    `addPane` is the only piece that comes from the mode that owns the grid; everything else is
    app-wide. A missing spawner means Code mode has not mounted, which is a thing to SAY rather
    than a call to let fail.
  */
  const primitives = useMemo(
    () => createTaskSpawner(spawner ?? (() => null), updateTask, onPostSpawn, { launchesAgentDirectly }),
    [spawner, updateTask, onPostSpawn, launchesAgentDirectly],
  );

  const execution = useTaskExecution({ workspaceId, primitives });

  const delegate = useCallback(
    async (
      task: BridgeTask,
      preset: DelegationPreset,
      taskKey?: string | null,
      options?: DelegateOptions,
    ): Promise<string | null> => {
      if (!spawner) return unavailable ?? "Open a workspace first — there is nowhere to put the agent.";
      const deny = options?.denyTools ?? [];
      if (deny.length > 0 && !supportsChosenSession(preset)) return DENY_NEEDS_CLAUDE;
      /*
        The id is CHOSEN here rather than discovered afterwards. Claude will accept one, so Lotus
        never has to watch `~/.claude/projects/` for a file that appeared and guess whether it was
        this pane's — a guess that races every other claude running in the same folder.
      */
      const sessionId = supportsChosenSession(preset) ? crypto.randomUUID() : null;
      const result = await execution.execute(task, {
        agent: withDeniedTools(
          sessionId ? startCommand(preset, sessionId) : [preset.agent, preset.args].filter(Boolean).join(" "),
          deny,
        ),
        instructions: [preset.instructions, options?.note].filter(Boolean).join("\n"),
        taskKey: taskKey ?? undefined,
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        ...(preset.account ? { claudeAccount: preset.account } : {}),
      });
      if (!result.ok) return result.error ?? "That task could not be delegated.";

      // Recorded after the fact, and only when there is something to record: a dispatch that could
      // not be walked back into must not leave a row that offers to.
      if (sessionId) {
        await client.current
          .appendEvent(task.workspaceId, task.id, {
            id: `dispatch_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
            at: Date.now(),
            actor: "human",
            kind: "assignment-dispatched",
            summary: `Handed to ${preset.name}.`,
            payload: {
              sessionId,
              // The whole command, not the id alone: the button still works when the preset it
              // came from has been deleted.
              // The denied tools ride along, so a resumed session is kept from them too.
              command: withDeniedTools(resumeCommand(preset, sessionId), deny),
              presetName: preset.name,
            },
          })
          .catch(() => undefined);
      }
      return null;
    },
    [execution, spawner, unavailable],
  );

  const resume = useCallback(
    async (task: BridgeTask, command: string): Promise<string | null> => {
      if (!spawner) return unavailable ?? "Open a workspace first — there is nowhere to put the agent.";
      // No prompt: the session already holds the conversation, and sending the task again would
      // ask for the work a second time.
      const result = await execution.execute(task, { agent: command, instructions: "" });
      return result.ok ? null : result.error ?? "That session could not be resumed.";
    },
    [execution, spawner, unavailable],
  );

  const savePreset = useCallback(
    async (draft: Omit<DelegationPreset, "id">): Promise<string | null> => {
      const prepared = prepareDelegationPreset(draft, presets);
      if (!prepared.ok) return presetRefusalMessage(prepared.reason);
      await write([...presets, prepared.preset]);
      return null;
    },
    [presets, write],
  );

  const updatePreset = useCallback(
    async (id: string, draft: Omit<DelegationPreset, "id">): Promise<string | null> => {
      const prepared = prepareDelegationPreset(draft, presets, id);
      if (!prepared.ok) return presetRefusalMessage(prepared.reason);
      await write(presets.map((preset) => (preset.id === id ? prepared.preset : preset)));
      return null;
    },
    [presets, write],
  );

  const removePreset = useCallback(
    async (id: string) => write(presets.filter((preset) => preset.id !== id)),
    [presets, write],
  );

  return {
    presets,
    ready: Boolean(spawner && workspaceId),
    delegate,
    savePreset,
    updatePreset,
    removePreset,
    resume,
    inFlight: execution.inFlight,
  };
}
