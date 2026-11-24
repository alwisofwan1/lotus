"use client";

import { Pencil, Play, Plus, ShieldAlert } from "lucide-react";
import { useAgentModelLabels } from "@/lib/tauri/agent-models";
import { AgentMark, presetAgent } from "@/modules/tasks/components/AgentModelPicker";
import { closeDetailsOnEscape, useCloseMenusOnOutsidePress } from "@/modules/tasks/components/details-menu";
import type { DelegationPreset } from "@/modules/tasks/services/delegation-preset";
import { presetSummary } from "@/modules/tasks/services/preset-tuning";

/**
 * Handing this task to an agent.
 *
 * A `<details>` like the status and priority menus, for the same reason: the browser already
 * gives open/close and outside-click (Escape it does not — see `details-menu.ts`), and a menu is
 * exactly where reimplementing them earns nothing.
 *
 * There are no presets to start with, and that is deliberate — the rule bb settled on. Pressing
 * this spawns a real process and spends real money, so which worker and which permissions must be
 * a choice somebody made rather than a default that ran. When the list is empty the menu offers to
 * make the first one instead of offering to guess.
 *
 * Making and editing a preset both open the ONE preset editor (`PresetEditorModal`), the same one
 * the Tasks sidebar opens. This menu used to carry its own smaller form, which meant two editors
 * with different fields and a preset you could make here but never change.
 */

export interface DelegateMenuProps {
  presets: readonly DelegationPreset[];
  /** False while Code mode has not published a way to open a pane. */
  ready: boolean;
  busy?: boolean;
  onDelegate: (preset: DelegationPreset) => void;
  onNewPreset: () => void;
  onEditPreset: (preset: DelegationPreset) => void;
}

/** A `<details>` stays open after a click inside it; the modal must not open behind a menu. */
function closeMenu(target: Element) {
  target.closest("details")?.removeAttribute("open");
}

export function DelegateMenu({
  presets,
  ready,
  busy,
  onDelegate,
  onNewPreset,
  onEditPreset,
}: DelegateMenuProps) {
  useCloseMenusOnOutsidePress();
  return (
    <details data-menu className="tk-delegate" onKeyDown={closeDetailsOnEscape}>
      <summary className="tk-delegate-summary" title={ready ? "Hand this task to an agent" : undefined}>
        <Play size={12} strokeWidth={2.5} aria-hidden />
        {busy ? "Delegating…" : "Delegate"}
      </summary>

      <div className="tk-delegate-menu" role="menu">
        {!ready ? (
          // Said, not hidden: a control that vanishes teaches nothing about why.
          <p className="tk-delegate-note">Open a workspace first — there is nowhere to put the agent.</p>
        ) : null}

        {presets.map((preset) => (
          <div key={preset.id} className="tk-delegate-row">
            <button
              type="button"
              className="tk-chip-option"
              disabled={!ready || busy}
              title={[preset.agent, preset.args].filter(Boolean).join(" ")}
              onClick={(event) => {
                closeMenu(event.currentTarget);
                onDelegate(preset);
              }}
            >
              <AgentMark agent={presetAgent(preset.agent)} size={14} />
              <span className="tk-delegate-name">{preset.name}</span>
              <PresetMeta preset={preset} />
            </button>
            <button
              type="button"
              className="tk-delegate-remove"
              aria-label={`Edit ${preset.name}`}
              title="Edit preset"
              onClick={(event) => {
                closeMenu(event.currentTarget);
                onEditPreset(preset);
              }}
            >
              <Pencil size={12} strokeWidth={1.75} aria-hidden />
            </button>
          </div>
        ))}

        {presets.length === 0 ? (
          <p className="tk-delegate-note">
            No presets yet. A preset names the agent, its model and its permissions, so delegating is
            never a guess.
          </p>
        ) : null}

        <button
          type="button"
          className="tk-delegate-new"
          onClick={(event) => {
            closeMenu(event.currentTarget);
            onNewPreset();
          }}
        >
          <Plus size={12} strokeWidth={2} aria-hidden />
          New preset
        </button>
      </div>
    </details>
  );
}

/** What a preset runs, in words; the raw command is the row's tooltip. */
function PresetMeta({ preset }: { preset: DelegationPreset }) {
  const liveLabel = useAgentModelLabels([presetAgent(preset.agent)]);
  const summary = presetSummary(preset.agent, preset.args, (model) => liveLabel(presetAgent(preset.agent), model));
  return (
    <span className="tk-delegate-agent">
      {summary.text}
      {preset.account ? ` · ${preset.account}` : null}
      {summary.fullAccess ? <ShieldAlert size={11} strokeWidth={2} aria-label="Full access" className="tk-full-access" /> : null}
    </span>
  );
}
