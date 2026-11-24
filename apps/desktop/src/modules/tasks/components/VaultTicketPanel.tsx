"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, CircleAlert, ExternalLink, FileText, RefreshCw } from "lucide-react";
import { openExternalLink } from "@/lib/tauri-api";
import { EditableTitle } from "@/modules/tasks/components/EditableTitle";
import { DelegateMenu } from "@/modules/tasks/components/DelegateMenu";
import { ObsidianGlyph } from "@/modules/tasks/components/ObsidianGlyph";
import { TaskDetailBar } from "@/modules/tasks/components/TaskDetailBar";
import { TaskStatusGlyph } from "@/modules/tasks/components/TaskGlyphs";
import { TaskMarkdown } from "@/modules/tasks/components/TaskMarkdown";
import { TaskPropertyMenu } from "@/modules/tasks/components/TaskPropertyMenu";
import { TicketSectionEditor } from "@/modules/tasks/editor/TicketSectionEditor";
import type { TicketEditing } from "@/modules/tasks/hooks/useTicketEditing";
import type { ListPosition } from "@/modules/tasks/services/task-detail";
import type { DelegationPreset } from "@/modules/tasks/services/delegation-preset";
import { statusLabel, type StatusVocabulary } from "@/modules/tasks/services/task-vocabulary";
import type { BridgeTaskStatus } from "@/modules/codespace/services/bridge/task-store";
import { VAULT_VOCABULARY } from "@/modules/tasks/services/vault-vocabulary";
import type { VaultTicketDetail } from "@/modules/tasks/services/vault-api";

/**
 * One vault ticket, read.
 *
 * A panel of its own rather than a branch inside `TaskDetailPanel`, because the two records share
 * almost nothing: a Lotus task carries an intake decision, a blocker and a history of what agents
 * did; a ticket carries prose under headings a person typed. Forcing both through one component
 * would leave half of it empty whichever one you opened.
 *
 * With `editing`, the title, the status and every section's prose are edited in place, `bb`'s way,
 * and written back surgically (`vault_ticket_edit.rs`, `section-splice.ts`). Without it — no vault
 * write path, or a test that does not need one — the panel reads.
 *
 * Headings stay as they are: they ARE the ticket's structure (Plan, Research, Implementation…),
 * and renaming one from here would be a structural edit wearing a prose edit's clothes.
 */

export interface VaultTicketPanelProps {
  detail: VaultTicketDetail;
  /** The vault's name, as the nav calls it. */
  projectName: string;
  onBack: () => void;
  /** Where this ticket sits in the list as drawn; `null` hides the ↑ ↓. */
  position?: ListPosition | null;
  onStep?: (taskId: string) => void;
  /** Surface controls drawn at the right end of the detail bar. */
  barTrailing?: ReactNode;
  /** Open another ticket by its key, when this one names a parent that exists. */
  onOpenKey?: (key: string) => void;
  /** Whether that parent is actually in this vault — a dead link is worse than plain text. */
  hasKey?: (key: string) => boolean;
  /**
   * Handing this ticket to an agent.
   *
   * A ticket has no workspace of its own, and an agent has to be born in one — so the target is
   * chosen here and shown, never picked silently. Absent where this surface cannot delegate.
   */
  /** Present when the ticket can be edited. */
  editing?: TicketEditing | null;
  /**
   * The Lotus tasks this ticket has become — the other half of the task's `source` link, so the
   * ticket says where its work is instead of leaving that to memory.
   */
  workedAs?: readonly TicketWork[];
  onOpenTask?: (taskId: string) => void;
  /** Present when this note has a Notion page it can be refreshed from. */
  pull?: VaultNotePull | null;
  delegation?: {
    presets: readonly DelegationPreset[];
    ready: boolean;
    busy: boolean;
    /** Why the last Delegate failed. Shown on the panel: the list, where it was shown before, is covered by it. */
    error?: string | null;
    /** The Lotus workspaces a task made from this ticket could live in. */
    targets: readonly { id: string; name: string }[];
    targetId: string;
    onTargetChange: (id: string) => void;
    onDelegate: (preset: DelegationPreset) => void;
    /** Both open the shared preset editor — the one the Tasks sidebar opens too. */
    onNewPreset: () => void;
    onEditPreset: (preset: DelegationPreset) => void;
  };
}

/**
 * This note's link to a page it can be refreshed from (mockup `NOTION 02`): Notion's page for the
 * same ticket, found by the caller. The panel only draws it; what a pull writes is the caller's.
 */
export interface VaultNotePull {
  /** The section a pull writes whole. Drawn read only here, since the next pull replaces it. */
  section: string;
  /** Notion's `last_edited_time` for the page. */
  editedAt: string;
  /** The page in Notion, for a note whose front matter has no `notion:` link. */
  url: string | null;
  /** `notion_pulled:` — the page's edit time at the last pull, or null before the first. */
  pulledAt: string | null;
  /** Notion has a newer version than the note holds. */
  newer: boolean;
  /** Formats a time the way the page says it. */
  format: (iso: string) => string;
  onReview: () => void;
}

export interface TicketWork {
  id: string;
  key: string | null;
  status: string;
  vocabulary: StatusVocabulary;
  projectName: string;
}

export function VaultTicketPanel({
  detail,
  projectName,
  onBack,
  position = null,
  onStep,
  barTrailing,
  onOpenKey,
  hasKey,
  delegation,
  editing = null,
  workedAs = [],
  onOpenTask,
  pull = null,
}: VaultTicketPanelProps) {
  /** "Later" hides the callout for this version of the page only — a newer edit brings it back. */
  const [later, setLater] = useState<string | null>(null);
  // While editing, what is drawn is the queue's copy — it follows each save.
  const shown = editing?.state.detail ?? detail;
  const { ticket, sections } = shown;
  const parentIsHere = Boolean(ticket.parent && hasKey?.(ticket.parent));

  return (
    <div className="tk-detail">
      <TaskDetailBar
        mark={
          <span className="tk-vault-mark" aria-hidden>
            <ObsidianGlyph size={13} decorative />
          </span>
        }
        projectName={projectName}
        taskKey={ticket.ticket}
        position={position}
        onBack={onBack}
        onStep={onStep}
        trailing={barTrailing}
      />

      <div className="tk-detail-scroll">
        <div className="tk-detail-page">
          <article className="tk-detail-main">
            {editing ? <TicketSaveBar editing={editing} /> : null}

            {pull && pull.newer && pull.pulledAt && later !== `${ticket.file}@${pull.editedAt}` ? (
              <div className="tk-callout tk-callout--pull" role="status">
                <RefreshCw size={15} strokeWidth={2} aria-hidden />
                <div className="tk-pull-callout-body">
                  <p>
                    <strong>Notion changed since your last pull</strong>
                  </p>
                  <p className="tk-pull-callout-meta">
                    Edited {pull.format(pull.editedAt)} · last pulled {pull.format(pull.pulledAt)} · your own sections are untouched
                  </p>
                </div>
                <button type="button" className="tk-button tk-button--primary" onClick={pull.onReview}>
                  Review changes
                </button>
                <button type="button" className="tk-button" onClick={() => setLater(`${ticket.file}@${pull.editedAt}`)}>
                  Later
                </button>
              </div>
            ) : null}

            {editing ? (
              <EditableTitle
                key={`${ticket.file}:${ticket.title}`}
                title={ticket.title}
                label="Ticket title"
                onCommit={editing.setTitle}
              />
            ) : (
              <h2 className="tk-detail-title">{ticket.title}</h2>
            )}
            {delegation?.error ? (
              <p className="tk-callout tk-callout--blocked tk-notion-notice" role="alert">
                {delegation.error}
              </p>
            ) : null}

            {sections.map((section, index) => (
              // Index keyed on purpose: headings repeat in real tickets, and file order IS the identity.
              <section className="tk-detail-section" key={`${ticket.file}-${section.heading ?? "preamble"}-${index}`}>
                {section.heading ? <h3 className="tk-detail-h">{section.heading}</h3> : null}
                {pull && section.heading === pull.section ? (
                  <>
                    <p className="tk-pull-owned-note">
                      <FileText size={12} strokeWidth={1.75} aria-hidden />
                      Written by Lotus on each pull · edit your own words in the other sections
                    </p>
                    <TaskMarkdown onOpenReference={onOpenKey} canOpenReference={hasKey}>
                      {section.body}
                    </TaskMarkdown>
                  </>
                ) : editing ? (
                  <TicketSectionEditor
                    body={section.body}
                    resetKey={editing.resetKeys[index] ?? 0}
                    placeholder={section.heading ? `Write ${section.heading.toLowerCase()}…` : "Write a description…"}
                    onChange={(markdown) => editing.setSection(index, section.heading ?? null, markdown)}
                    onOpenReference={onOpenKey}
                    canOpenReference={hasKey}
                  />
                ) : (
                  <TaskMarkdown onOpenReference={onOpenKey} canOpenReference={hasKey}>
                    {section.body}
                  </TaskMarkdown>
                )}
              </section>
            ))}
          </article>

          <aside className="tk-props" aria-label="Properties">
            <h3 className="tk-props-h">Properties</h3>
            {editing ? (
              <div className="tk-props-list">
                <TaskPropertyMenu
                  kind="status"
                  vocabulary={VAULT_VOCABULARY}
                  value={ticket.status}
                  showLabel
                  onChange={editing.setStatus}
                />
              </div>
            ) : (
            <p className="tk-props-value">
              {/* Cast, not widened: a vault word like `qa-revision` is not a Lotus status, and the
                  glyph already draws an unknown one as its neutral circle. The list does the same. */}
              <TaskStatusGlyph status={ticket.status as BridgeTaskStatus} vocabulary={VAULT_VOCABULARY} decorative />
              {statusLabel(VAULT_VOCABULARY, ticket.status)}
            </p>
            )}

            {ticket.tags.length > 0 ? (
              <>
                <h3 className="tk-props-h">Labels</h3>
                <p className="tk-detail-tags">
                  {ticket.tags.map((tag) => (
                    <span key={tag} className="tk-detail-tag">
                      {tag}
                    </span>
                  ))}
                </p>
              </>
            ) : null}

            <h3 className="tk-props-h">Project</h3>
            <p className="tk-props-value">
              <span className="tk-vault-mark" aria-hidden>
                <ObsidianGlyph size={13} decorative />
              </span>
              {projectName}
            </p>

            {ticket.parent ? (
              <>
                <h3 className="tk-props-h">Parent</h3>
                <p className="tk-props-value">
                  {parentIsHere && onOpenKey ? (
                    <button type="button" className="tk-props-link" onClick={() => onOpenKey(ticket.parent!)}>
                      {ticket.parent}
                    </button>
                  ) : (
                    <span>{ticket.parent}</span>
                  )}
                </p>
              </>
            ) : null}

            {delegation ? (
              <>
                <h3 className="tk-props-h">Agent</h3>
                {/* Shown, not assumed: the ticket belongs to no workspace, and a worker born in the
                    wrong repository is worse than one not born at all. */}
                {delegation.targets.length > 1 ? (
                  <label className="tk-select-chip tk-select-chip--block">
                    <span className="tk-select-chip-value">
                      in {delegation.targets.find((target) => target.id === delegation.targetId)?.name ?? "…"}
                    </span>
                    <ChevronDown size={13} strokeWidth={1.75} aria-hidden />
                    <select
                      value={delegation.targetId}
                      aria-label="Workspace for this work"
                      onChange={(event) => delegation.onTargetChange(event.target.value)}
                    >
                      {delegation.targets.map((target) => (
                        <option key={target.id} value={target.id}>
                          {target.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : delegation.targets[0] ? (
                  <p className="tk-props-note">in {delegation.targets[0].name}</p>
                ) : null}
                <DelegateMenu
                  presets={delegation.presets}
                  ready={delegation.ready && delegation.targets.length > 0}
                  busy={delegation.busy}
                  onDelegate={delegation.onDelegate}
                  onNewPreset={delegation.onNewPreset}
                  onEditPreset={delegation.onEditPreset}
                />
              </>
            ) : null}

            {workedAs.length > 0 ? (
              <>
                <h3 className="tk-props-h">Work</h3>
                <ul className="tk-props-work">
                  {workedAs.map((work) => (
                    <li key={work.id}>
                      <button
                        type="button"
                        className="tk-props-link"
                        onClick={() => onOpenTask?.(work.id)}
                        title={`${statusLabel(work.vocabulary, work.status)} · ${work.projectName}`}
                      >
                        <TaskStatusGlyph
                          status={work.status as BridgeTaskStatus}
                          vocabulary={work.vocabulary}
                          decorative
                        />
                        {work.key ?? "Task"}
                        <span className="tk-props-work-where">{work.projectName}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {ticket.notion || pull ? (
              <>
                <h3 className="tk-props-h">Source</h3>
                {ticket.notion || pull?.url ? (
                  <button
                    type="button"
                    className="tk-props-link"
                    onClick={() => void openExternalLink((ticket.notion || pull?.url)!)}
                    title={ticket.notion || pull?.url || undefined}
                  >
                    Open in Notion
                    <ExternalLink size={11} strokeWidth={2} aria-hidden />
                  </button>
                ) : null}
                {pull ? (
                  <div className="tk-pull-source">
                    <p className="tk-props-value">{pull.pulledAt ? `Pulled ${pull.format(pull.pulledAt)}` : "Not pulled yet"}</p>
                    {pull.newer && pull.pulledAt ? (
                      <p className="tk-pull-newer">
                        <span className="tk-pull-dot" aria-hidden />
                        Notion is newer
                      </p>
                    ) : null}
                    <button type="button" className="tk-button tk-pull-refresh" onClick={pull.onReview}>
                      <RefreshCw size={12} strokeWidth={2} aria-hidden />
                      {pull.pulledAt ? "Refresh from Notion" : "Pull from Notion"}
                    </button>
                  </div>
                ) : null}
              </>
            ) : null}

            <p className="tk-props-foot">
              {[ticket.created && `created ${ticket.created}`, ticket.updated && `updated ${ticket.updated}`]
                .filter(Boolean)
                .join(" · ") || "no dates recorded"}
            </p>
          </aside>
        </div>
      </div>
    </div>
  );
}

/**
 * What the editor is doing, in one quiet line — and, on a conflict, the only loud thing on the
 * page, because it is the one moment the person has a decision to make.
 */
function TicketSaveBar({ editing }: { editing: TicketEditing }) {
  const { state } = editing;
  if (state.conflict) {
    return (
      <div className="tk-callout tk-callout--conflict" role="alert">
        <CircleAlert size={15} strokeWidth={2} aria-hidden />
        <div className="tk-conflict-body">
          <p>
            <strong>This ticket changed in Obsidian</strong> while you were editing. Your unsaved
            text is still here — nothing has been written over.
          </p>
          <p className="tk-conflict-hint">
            {state.canApplyOnTop
              ? "The change was somewhere you were not editing, so your edits can go on top of it."
              : "The change touched what you were editing. Reload to see it; your unsaved text will be dropped."}
          </p>
          <div className="tk-conflict-actions">
            {state.canApplyOnTop ? (
              <button type="button" className="tk-button tk-button--primary" onClick={editing.applyOnTop}>
                Save mine on top
              </button>
            ) : null}
            <button type="button" className="tk-button" onClick={editing.reload}>
              Reload from Obsidian
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <p className="tk-save-state" aria-live="polite" data-state={state.error ? "error" : state.saving ? "saving" : state.dirty ? "dirty" : "saved"}>
      {state.error ?? (state.saving ? "Saving…" : state.dirty ? "Editing…" : state.savedAt ? "Saved to vault" : "Edits save to the vault as you type")}
    </p>
  );
}
