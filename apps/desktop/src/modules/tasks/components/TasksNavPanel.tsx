"use client";

import type { ReactNode } from "react";
import { ChevronDown, ListTodo, Pencil, Plus, ShieldAlert, Zap } from "lucide-react";
import { useAgentModelLabels } from "@/lib/tauri/agent-models";
import { AgentMark, presetAgent } from "@/modules/tasks/components/AgentModelPicker";
import { TicketSourceMark } from "@/modules/tasks/components/TicketSourceMark";
import { SourceHealthDot } from "@/modules/tasks/components/SourceHealthBanner";
import { VaultConnectRow } from "@/modules/tasks/components/VaultConnectRow";
import { isTicketSource } from "@/modules/tasks/services/ticket-sources";
import type { DelegationPreset } from "@/modules/tasks/services/delegation-preset";
import { presetSummary } from "@/modules/tasks/services/preset-tuning";
import type { TrackerProject } from "@/modules/tasks/types";

/**
 * The tracker's own navigation: the two views everybody uses, then the projects.
 *
 * It sits on the RIGHT of the list, where `bb` puts it — the left sidebar already belongs to the
 * window (workspaces, panes), and a second list of nav rows beside it would make the eye choose
 * between two columns that mean different things.
 *
 * Workspaces and ticket sources are two sections, not one list: a workspace is where Lotus's own
 * tasks live, a ticket source is somebody else's record shown here (`plans/ticket-sources`), and a
 * person who has no source at all sees no trace of one beyond the way to add it.
 *
 * `All tasks` and `Active` are not filters someone composed — they are the two questions a
 * tracker gets asked most ("what exists" and "what is moving"), so they get a row each rather
 * than living inside the Status chip.
 *
 * `Active` counts tasks a PANE is executing right now, not tasks whose status says in progress.
 * A status is something a person set and may have walked away from; a running pane is a fact
 * about this second, and the difference is the whole reason to show both.
 */

export interface TasksNavProject extends TrackerProject {
  taskCount: number;
}

export interface TasksNavPanelProps {
  projects: TasksNavProject[];
  /** The connected Obsidian vault's path, or empty when there is none. */
  vaultPath: string;
  onConnectVault: (path: string, ticketCount: number) => void;
  onDisconnectVault: () => void;
  /** Opens "Add a ticket source". */
  onAddSource: () => void;
  /** Bumped to open the vault's folder form in place (after Obsidian was picked). */
  vaultFormRequest?: number;
  totalCount: number;
  activeCount: number;
  /** `null` is "All tasks"; `"active"` is the live view; anything else is a project id. */
  selection: string | null | "active";
  onSelect: (selection: string | null | "active") => void;
  /**
   * The worker profiles Delegate offers. Listed here, as `bb` lists them, because a preset is
   * made once and used from many tasks — hiding its editor inside one task's Delegate menu made
   * it look like a property of that task.
   */
  presets: readonly DelegationPreset[];
  onEditPreset: (preset: DelegationPreset) => void;
  onNewPreset: () => void;
  /** Tasks left behind by closed workspaces, drawn under the projects they can be moved into. */
  recovery?: ReactNode;
}

export function TasksNavPanel({
  projects,
  vaultPath,
  onConnectVault,
  onDisconnectVault,
  onAddSource,
  vaultFormRequest,
  totalCount,
  activeCount,
  selection,
  onSelect,
  presets,
  onEditPreset,
  onNewPreset,
  recovery,
}: TasksNavPanelProps) {
  const workspaces = projects.filter((project) => !isTicketSource(project));
  const sources = projects.filter(isTicketSource);

  return (
    <nav className="tk-nav" aria-label="Tasks navigation">
      <button
        type="button"
        className="tk-nav-item"
        data-active={selection === null ? "true" : undefined}
        onClick={() => onSelect(null)}
      >
        <ListTodo size={14} strokeWidth={1.75} aria-hidden />
        <span className="tk-nav-label">All tasks</span>
        <span className="tk-nav-count">{totalCount}</span>
      </button>

      <button
        type="button"
        className="tk-nav-item"
        data-active={selection === "active" ? "true" : undefined}
        onClick={() => onSelect("active")}
      >
        <Zap size={14} strokeWidth={1.75} aria-hidden />
        {/* "Running agents", not "Active": the count is panes at work, and "Active 0" beside two
            In Progress tasks read as a wrong number (Tasks revamp D5). */}
        <span className="tk-nav-label">Running agents</span>
        <span className="tk-nav-count">{activeCount}</span>
      </button>

      <p className="tk-nav-section">Projects</p>
      {workspaces.map((project) => (
        <button
          key={project.id}
          type="button"
          className="tk-nav-item"
          data-active={selection === project.id ? "true" : undefined}
          onClick={() => onSelect(project.id)}
          title={project.prefix ? `${project.name} · ${project.prefix}` : project.name}
        >
          <span
            className="tk-nav-dot"
            style={project.color ? { background: project.color } : undefined}
            aria-hidden
          />
          <span className="tk-nav-label">{project.name}</span>
          {/* The prefix is shown because it is what the operator types into search, and
              because seeing it is how they learn the key on their own rows. */}
          {project.prefix ? <span className="tk-nav-prefix">{project.prefix}</span> : null}
          <span className="tk-nav-count">{project.taskCount}</span>
        </button>
      ))}

      {recovery}

      <p className="tk-nav-section">Ticket sources</p>
      {sources.map((project) => (
        <button
          key={project.id}
          type="button"
          className="tk-nav-item tk-nav-item--source"
          data-active={selection === project.id ? "true" : undefined}
          onClick={() => onSelect(project.id)}
          title={project.name}
        >
          {/* A source wears its own mark instead of a colour dot: it did not come from this
              window, and the mark says where it did come from. */}
          <TicketSourceMark kind={project.source!.kind} />
          <span className="tk-nav-source-text">
            <span className="tk-nav-label">{project.name}</span>
            <span className="tk-nav-sync">
              <SourceHealthDot health={project.source!.health} />
              {project.source!.syncLine}
            </span>
          </span>
          <span className="tk-nav-count">{project.taskCount}</span>
        </button>
      ))}

      {/* The vault's own form: "Change vault" once there is one, and where picking Obsidian in
          "Add a ticket source" opens, so the path is typed in the row the vault will live in. */}
      <VaultConnectRow
        path={vaultPath}
        onConnect={onConnectVault}
        onDisconnect={onDisconnectVault}
        openRequest={vaultFormRequest}
      />

      {/* Worded as the act, with no brand on it: a person with no source sees no trace of one. */}
      <button type="button" className="tk-nav-item tk-nav-item--quiet" onClick={onAddSource} aria-haspopup="dialog">
        <Plus size={14} strokeWidth={1.75} aria-hidden />
        <span className="tk-nav-label">Add ticket source</span>
      </button>

      {/* Settings, not a place to go: folded by default so it does not read as more views. */}
      <details className="tk-nav-fold">
        <summary className="tk-nav-section tk-nav-fold-head">
          <ChevronDown size={11} strokeWidth={2} aria-hidden className="tk-nav-fold-chev" />
          Agent presets
          <span className="tk-nav-count">{presets.length}</span>
        </summary>
        {presets.map((preset) => (
          <PresetNavRow key={preset.id} preset={preset} onEdit={() => onEditPreset(preset)} />
        ))}
        <button type="button" className="tk-nav-item tk-nav-item--quiet" onClick={onNewPreset}>
          <Plus size={14} strokeWidth={1.75} aria-hidden />
          <span className="tk-nav-label">New preset</span>
        </button>
      </details>
    </nav>
  );
}

/**
 * A preset as a row: its agent's tile, its name, and what it runs in words — `Sonnet 5 · High` —
 * with an amber shield when it runs without approvals. The raw command stays in the tooltip.
 */
function PresetNavRow({ preset, onEdit }: { preset: DelegationPreset; onEdit: () => void }) {
  const liveLabel = useAgentModelLabels([presetAgent(preset.agent)]);
  const summary = presetSummary(preset.agent, preset.args, (model) => liveLabel(presetAgent(preset.agent), model));
  return (
    <button
      type="button"
      className="tk-nav-item tk-nav-item--preset"
      onClick={onEdit}
      aria-label={preset.name}
      title={[preset.agent, preset.args].filter(Boolean).join(" ")}
    >
      <AgentMark agent={presetAgent(preset.agent)} size={14} />
      <span className="tk-nav-preset-text">
        <span className="tk-nav-label">{preset.name}</span>
        <span className="tk-nav-preset-meta">
          {summary.text}
          {preset.account ? ` · ${preset.account}` : null}
          {summary.fullAccess ? <ShieldAlert size={11} strokeWidth={2} aria-label="Full access" className="tk-full-access" /> : null}
        </span>
      </span>
      <Pencil size={12} strokeWidth={1.75} aria-hidden className="tk-nav-preset-edit" />
    </button>
  );
}
